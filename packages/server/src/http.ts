import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { parseAnchor } from "./anchors.ts";
import { renderMarkdown } from "../../web/src/markdown.ts";
import {
  RoomError,
  RoomStore,
  type ContentType,
  type Participant,
  type Room,
} from "./rooms.ts";

export interface PeanutServer {
  port: number;
  url: string;
  stop(): void;
  store: RoomStore;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const FONT_PATHS = new Set([
  "/fonts/google-sans.woff2",
  "/fonts/google-sans-latin-ext.woff2",
  "/fonts/google-sans-italic.woff2",
  "/fonts/google-sans-italic-latin-ext.woff2",
]);
const ICON_PATHS = new Set([
  "/icon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-mask.png",
  "/manifest.webmanifest",
]);
const ASSET_CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
]);

interface RelayData {
  roomId: string;
  sessionId: string;
  participantId: string;
}

export function startServer(options: { port?: number } = {}): PeanutServer {
  const store = new RoomStore();
  // One set of live sockets per room. Incoming frames are passed through
  // unchanged. The relay also announces when a participant disconnects.
  const relayRooms = new Map<string, Set<Bun.ServerWebSocket<RelayData>>>();

  const server = Bun.serve<RelayData>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    // The agent poll holds a silent request for its whole window and
    // the relay idles between messages. The default ten second idle
    // cut kills both, so idle connections are never closed here.
    idleTimeout: 0,
    async fetch(request, bunServer) {
      try {
        const relayMatch = new URL(request.url).pathname.match(/^\/api\/rooms\/([^/]+)\/relay$/);
        if (relayMatch) {
          const roomId = relayMatch[1]!;
          // The same cookie gate as the HTTP API: no participant session,
          // no socket.
          const participant = store.participant(roomId, sessionFromCookie(request, roomId));
          const upgraded = bunServer.upgrade(request, {
            data: {
              roomId,
              sessionId: participant.sessionId,
              participantId: participant.publicId,
            },
          });
          if (upgraded) return undefined as unknown as Response;
          return json({ error: "upgrade_failed" }, 400);
        }
        return await route(request, store);
      } catch (error) {
        if (error instanceof RoomError) {
          return json({ error: error.code, message: error.message }, statusFor(error.code));
        }
        throw error;
      }
    },
    websocket: {
      // Upgraded sockets have their own idle rule with a two minute
      // default; a quiet room must not lose its relay either.
      idleTimeout: 0,
      open(ws) {
        const set = relayRooms.get(ws.data.roomId) ?? new Set();
        relayRooms.set(ws.data.roomId, set);
        set.add(ws);
      },
      message(ws, message) {
        const set = relayRooms.get(ws.data.roomId);
        if (!set) return;
        for (const peer of set) {
          if (peer !== ws) peer.send(message);
        }
      },
      close(ws) {
        const set = relayRooms.get(ws.data.roomId);
        if (!set) return;
        set.delete(ws);
        const participantStillConnected = [...set].some(
          (peer) => peer.data.sessionId === ws.data.sessionId,
        );
        if (!participantStillConnected) {
          const leave = JSON.stringify({
            type: "cursor-leave",
            participantId: ws.data.participantId,
          });
          for (const peer of set) peer.send(leave);
        }
        if (set.size === 0) relayRooms.delete(ws.data.roomId);
      },
    },
  });

  return {
    port: server.port ?? 0,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    store,
  };
}

async function route(request: Request, store: RoomStore): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "POST" && path === "/api/rooms") {
    const body = await readJson(request);
    const contentType = contentTypeField(body);
    // A hostless room comes from the CLI: the agent holds the token and
    // the first person who joins by link becomes the host.
    if (body.hostless === true) {
      const { room } = store.createRoom({
        title: stringField(body, "title"),
        content: stringField(body, "content"),
        documentDirectory: stringField(body, "documentDirectory") || undefined,
        contentType,
      });
      return json({ roomId: room.id, agentToken: room.agentToken }, 201);
    }
    const { room, host } = store.createRoom({
      title: stringField(body, "title"),
      content: stringField(body, "content"),
      documentDirectory: stringField(body, "documentDirectory") || undefined,
      contentType,
      hostName: stringField(body, "hostName") || "Host",
    });
    // The agent token is returned once, to the creator only. It never
    // appears in room state.
    return json(
      { roomId: room.id, agentToken: room.agentToken, state: store.stateFor(room.id, host!.sessionId) },
      201,
      sessionCookie(room.id, host!),
    );
  }

  const joinMatch = path.match(/^\/api\/rooms\/([^/]+)\/join$/);
  if (request.method === "POST" && joinMatch) {
    const roomId = joinMatch[1]!;
    const body = await readJson(request);
    const sessionId = sessionFromCookie(request, roomId);
    const participant =
      body.claimHost === true
        ? store.claimHost(roomId, sessionId)
        : store.join(roomId, { name: stringField(body, "name"), sessionId });
    return json(store.stateFor(roomId, participant.sessionId), 200, sessionCookie(roomId, participant));
  }

  const stateMatch = path.match(/^\/api\/rooms\/([^/]+)\/state$/);
  if (request.method === "GET" && stateMatch) {
    const roomId = stateMatch[1]!;
    let participant: Participant;
    try {
      participant = store.participant(roomId, sessionFromCookie(request, roomId));
    } catch (error) {
      if (error instanceof RoomError && error.code === "not_a_participant") {
        return json(
          {
            error: error.code,
            message: error.message,
            participantCount: store.participantCount(roomId),
          },
          403,
        );
      }
      throw error;
    }
    return json(store.stateFor(roomId, participant.sessionId));
  }

  const documentMatch = path.match(/^\/api\/rooms\/([^/]+)\/document$/);
  if (request.method === "GET" && documentMatch) {
    const roomId = documentMatch[1]!;
    store.participant(roomId, sessionFromCookie(request, roomId));
    return new Response(roomDocument(store.getRoom(roomId)), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "sandbox allow-scripts allow-forms allow-popups",
      },
    });
  }

  const pinMatch = path.match(/^\/api\/rooms\/([^/]+)\/instructions$/);
  if (request.method === "POST" && pinMatch) {
    const roomId = pinMatch[1]!;
    const body = await readJson(request);
    const anchor = parseAnchor(body.anchor);
    if (!anchor) throw new RoomError("bad_instruction", "a valid anchor is required");
    const instruction = store.pinInstruction(roomId, sessionFromCookie(request, roomId), {
      words: stringField(body, "words"),
      anchor,
    });
    return json({ id: instruction.id }, 201);
  }

  const removeMatch = path.match(/^\/api\/rooms\/([^/]+)\/instructions\/([^/]+)$/);
  if (request.method === "DELETE" && removeMatch) {
    const roomId = removeMatch[1]!;
    store.removeInstruction(roomId, sessionFromCookie(request, roomId), removeMatch[2]!);
    return json({ removed: true });
  }
  if (request.method === "PATCH" && removeMatch) {
    const roomId = removeMatch[1]!;
    const body = await readJson(request);
    store.editInstruction(
      roomId,
      sessionFromCookie(request, roomId),
      removeMatch[2]!,
      stringField(body, "words"),
    );
    return json({ edited: true });
  }

  const flushMatch = path.match(/^\/api\/rooms\/([^/]+)\/flush$/);
  if (request.method === "POST" && flushMatch) {
    const roomId = flushMatch[1]!;
    const body = await readJson(request);
    const verdictField = stringField(body, "verdict");
    if (verdictField && verdictField !== "approve" && verdictField !== "request_changes") {
      throw new RoomError("bad_instruction", "verdict must be approve or request_changes");
    }
    const round = store.flushRound(roomId, sessionFromCookie(request, roomId), {
      domSnapshot: stringField(body, "domSnapshot"),
      nextStep: stringField(body, "nextStep"),
      ...(verdictField ? { verdict: verdictField as "approve" | "request_changes" } : {}),
    });
    return json({ round: round.number }, 201);
  }

  const grantMatch = path.match(/^\/api\/rooms\/([^/]+)\/grants$/);
  if (request.method === "POST" && grantMatch) {
    const roomId = grantMatch[1]!;
    const body = await readJson(request);
    const canSend = body.canSend;
    if (typeof canSend !== "boolean") {
      throw new RoomError("bad_instruction", "canSend must be true or false");
    }
    store.setSendGrant(
      roomId,
      sessionFromCookie(request, roomId),
      stringField(body, "participantId"),
      canSend,
    );
    return json({ granted: canSend });
  }

  const participantMatch = path.match(/^\/api\/rooms\/([^/]+)\/participants\/([^/]+)$/);
  if (request.method === "PATCH" && participantMatch) {
    const roomId = participantMatch[1]!;
    const body = await readJson(request);
    const participant = store.renameParticipant(
      roomId,
      sessionFromCookie(request, roomId),
      participantMatch[2]!,
      stringField(body, "name"),
    );
    return json(store.stateFor(roomId, participant.sessionId));
  }

  const endMatch = path.match(/^\/api\/rooms\/([^/]+)\/end$/);
  if (request.method === "POST" && endMatch) {
    store.endByUser(endMatch[1]!, sessionFromCookie(request, endMatch[1]!));
    return json({ ended: true });
  }

  const pollMatch = path.match(/^\/api\/rooms\/([^/]+)\/agent\/poll$/);
  if (request.method === "GET" && pollMatch) {
    return agentPoll(request, store, pollMatch[1]!, url);
  }

  const replyMatch = path.match(/^\/api\/rooms\/([^/]+)\/agent\/reply$/);
  if (request.method === "POST" && replyMatch) {
    const body = await readJson(request);
    const roundNumber = body.round;
    if (roundNumber !== undefined && !Number.isInteger(roundNumber)) {
      throw new RoomError("bad_instruction", "round must be an integer");
    }
    store.agentReply(
      replyMatch[1]!,
      bearerToken(request),
      stringField(body, "message"),
      stringField(body, "meta") || undefined,
      roundNumber as number | undefined,
    );
    return json({ replied: true }, 201);
  }

  const contentMatch = path.match(/^\/api\/rooms\/([^/]+)\/agent\/content$/);
  if (request.method === "PUT" && contentMatch) {
    const body = await readJson(request);
    if (typeof body.content !== "string") {
      throw new RoomError("bad_instruction", "content must be a string");
    }
    const result = store.replaceContent(
      contentMatch[1]!,
      bearerToken(request),
      body.content,
    );
    return json(result);
  }

  const ackMatch = path.match(/^\/api\/rooms\/([^/]+)\/agent\/ack$/);
  if (request.method === "POST" && ackMatch) {
    const body = await readJson(request);
    if (!Number.isInteger(body.round)) {
      throw new RoomError("bad_instruction", "round must be an integer");
    }
    store.ackRound(ackMatch[1]!, bearerToken(request), body.round as number);
    return json({ acked: true });
  }

  const agentEndMatch = path.match(/^\/api\/rooms\/([^/]+)\/agent\/end$/);
  if (request.method === "POST" && agentEndMatch) {
    store.endByAgent(agentEndMatch[1]!, bearerToken(request));
    return json({ ended: true });
  }

  const assetMatch = path.match(/^\/api\/rooms\/([^/]+)\/(.+)$/);
  if (request.method === "GET" && assetMatch) {
    const roomId = assetMatch[1]!;
    // The sandboxed document has an opaque origin and sends no room cookie.
    // The unguessable room id still scopes assets to one document directory.
    return roomAsset(store.getRoom(roomId), assetMatch[2]!);
  }

  if (request.method === "GET" && path === "/app.js") {
    return appScript();
  }

  if (request.method === "GET" && path === "/overlay.js") {
    return overlayScript();
  }

  if (request.method === "GET" && path === "/overlay.css") {
    const css = embeddedAssets
      ? embeddedAssets.overlayCss
      : Bun.file(webPath("public/overlay.css"));
    return new Response(css, {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }

  if (request.method === "GET" && FONT_PATHS.has(path)) {
    const font = embeddedAssets?.fonts[path] ?? Bun.file(webPath(`public${path}`));
    return new Response(font, {
      headers: {
        "content-type": "font/woff2",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (request.method === "GET" && ICON_PATHS.has(path)) {
    const asset = embeddedAssets?.icons[path] ?? Bun.file(webPath(`public${path}`));
    const contentType =
      path === "/icon.svg"
        ? "image/svg+xml"
        : path === "/favicon.ico"
          ? "image/x-icon"
          : path === "/manifest.webmanifest"
            ? "application/manifest+json"
            : "image/png";
    return new Response(asset, {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  // A room link is /<roomId>. The shell is served for every id; the
  // client shows "room not found" when the state fetch says so.
  if (request.method === "GET" && /^\/[A-Za-z0-9]+$/.test(path)) {
    const html = embeddedAssets
      ? embeddedAssets.indexHtml
      : Bun.file(webPath("public/index.html"));
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return json({ error: "not_found" }, 404);
}

async function roomAsset(room: Room, encodedPath: string): Promise<Response> {
  const notFound = () => json({ error: "not_found" }, 404);
  if (!room.documentDirectory) return notFound();

  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(encodedPath);
  } catch {
    return notFound();
  }
  if (
    requestedPath.includes("\0") ||
    isAbsolute(requestedPath) ||
    win32.isAbsolute(requestedPath)
  ) {
    return notFound();
  }

  if (!ASSET_CONTENT_TYPES.has(extname(requestedPath).toLowerCase())) return notFound();

  let assetPath: string;
  let contentType: string;
  try {
    const documentDirectory = await realpath(room.documentDirectory);
    assetPath = await realpath(resolve(documentDirectory, requestedPath));
    const resolvedContentType = ASSET_CONTENT_TYPES.get(extname(assetPath).toLowerCase());
    if (!resolvedContentType) return notFound();
    contentType = resolvedContentType;
    const pathFromDocument = relative(documentDirectory, assetPath);
    if (
      pathFromDocument === "" ||
      pathFromDocument === ".." ||
      pathFromDocument.startsWith(`..${sep}`) ||
      isAbsolute(pathFromDocument) ||
      !(await stat(assetPath)).isFile()
    ) {
      return notFound();
    }
  } catch {
    return notFound();
  }

  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (contentType === "image/svg+xml") {
    // SVG stays usable as an image. This sandbox stops it from running as a page.
    headers["content-security-policy"] = "sandbox; default-src 'none'";
  }
  return new Response(Bun.file(assetPath), { headers });
}

function webPath(relative: string): string {
  return new URL(`../../web/${relative}`, import.meta.url).pathname;
}

// The compiled binary has no web sources on disk; its entry injects
// the assets it carries, and the disk paths are never touched.
export interface WebAssets {
  indexHtml: string;
  appJs: string;
  overlayJs: string;
  overlayCss: string;
  fonts: Record<string, Blob>;
  icons: Record<string, Blob>;
}

let embeddedAssets: WebAssets | null = null;

export function setEmbeddedAssets(assets: WebAssets): void {
  embeddedAssets = assets;
}

let appBundle: string | null = null;
let overlayBundle: string | null = null;

// The client is TypeScript; Bun bundles it in memory on the first
// request and the result is reused for the life of the process.
async function appScript(): Promise<Response> {
  if (embeddedAssets) {
    return new Response(embeddedAssets.appJs, {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (appBundle === null) {
    const build = await Bun.build({
      entrypoints: [webPath("src/app.ts")],
      target: "browser",
      minify: false,
    });
    if (!build.success) {
      return json({ error: "build_failed" }, 500);
    }
    appBundle = await build.outputs[0]!.text();
  }
  return new Response(appBundle, {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}

async function overlayScript(): Promise<Response> {
  if (embeddedAssets) {
    return new Response(embeddedAssets.overlayJs, {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (overlayBundle === null) {
    const build = await Bun.build({
      entrypoints: [webPath("src/overlay.ts")],
      target: "browser",
      format: "iife",
      minify: false,
    });
    if (!build.success) return json({ error: "build_failed" }, 500);
    overlayBundle = await build.outputs[0]!.text();
  }
  return new Response(overlayBundle, {
    headers: { "content-type": "text/javascript; charset=utf-8" },
  });
}

const POLL_HEARTBEAT_MS = 15_000;

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Long-poll for the agent. With ?timeoutMs= the request resolves to
// {status:"waiting"} at the deadline. Without it the response streams a
// heartbeat space until a round or the end of the session arrives. A
// poll never consumes the round; the agent acknowledges it separately,
// so a delivery lost on the wire repeats on the next poll.
async function agentPoll(
  request: Request,
  store: RoomStore,
  roomId: string,
  url: URL,
): Promise<Response> {
  const token = bearerToken(request);
  const timeoutParam = url.searchParams.get("timeoutMs");
  const timeoutMs =
    timeoutParam === null ? null : Math.max(0, Math.min(Number(timeoutParam) || 0, 2147483647));

  const immediate = store.peekRound(roomId, token);
  if (immediate.status !== "waiting") return json(immediate);

  if (timeoutMs !== null) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || request.signal.aborted) return json({ status: "waiting" });
      const waiter = store.changeWaiter(roomId, request.signal);
      try {
        await Promise.race([waiter.promise, sleep(remaining)]);
      } finally {
        waiter.dispose();
      }
      const result = store.peekRound(roomId, token);
      if (result.status === "waiting") continue;
      return json(result);
    }
  }

  let finish = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(" "));
      }, POLL_HEARTBEAT_MS);
      finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
      };
      request.signal.addEventListener("abort", finish, { once: true });
      (async () => {
        while (!closed) {
          const waiter = store.changeWaiter(roomId, request.signal);
          try {
            await waiter.promise;
          } finally {
            waiter.dispose();
          }
          if (closed || request.signal.aborted) {
            finish();
            return;
          }
          const result = store.peekRound(roomId, token);
          if (result.status === "waiting") continue;
          controller.enqueue(encoder.encode(JSON.stringify(result)));
          finish();
          controller.close();
          return;
        }
      })().catch(() => finish());
    },
    // The runtime can cancel the stream without the abort event firing
    // first; without this the heartbeat interval would enqueue into a
    // cancelled controller forever.
    cancel() {
      finish();
    },
  });
  return new Response(stream, { status: 200, headers: JSON_HEADERS });
}

function statusFor(code: RoomError["code"]): number {
  switch (code) {
    case "room_not_found":
    case "instruction_not_found":
      return 404;
    case "bad_name":
    case "bad_instruction":
    case "empty_flush":
    case "reply_too_long":
    case "reply_meta_too_long":
      return 400;
    case "bad_agent_token":
      return 401;
    case "not_a_participant":
    case "not_allowed":
      return 403;
    case "host_taken":
    case "room_ended":
    case "round_pending":
    case "bad_ack":
      return 409;
  }
}

const OVERLAY_ASSETS =
  '<link rel="stylesheet" href="/overlay.css">\n<script src="/overlay.js"></script>';

const MARKDOWN_DOCUMENT_STYLES = `
  @font-face {
    font-family: "Google Sans";
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url("/fonts/google-sans-latin-ext.woff2") format("woff2");
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7,
      U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F,
      U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113,
      U+2C60-2C7F, U+A720-A7FF;
  }
  @font-face {
    font-family: "Google Sans";
    font-style: normal;
    font-weight: 400 700;
    font-display: swap;
    src: url("/fonts/google-sans.woff2") format("woff2");
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6,
      U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC,
      U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: "Google Sans";
    font-style: italic;
    font-weight: 400 700;
    font-display: swap;
    src: url("/fonts/google-sans-italic-latin-ext.woff2") format("woff2");
    unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7,
      U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F,
      U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113,
      U+2C60-2C7F, U+A720-A7FF;
  }
  @font-face {
    font-family: "Google Sans";
    font-style: italic;
    font-weight: 400 700;
    font-display: swap;
    src: url("/fonts/google-sans-italic.woff2") format("woff2");
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6,
      U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC,
      U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  :root {
    color-scheme: dark;
    --document-ink: #e6e9ef;
    --document-line: #2a3140;
    --document-paper: #10141b;
    --document-surface: #171c25;
    --document-accent: color-mix(in srgb, #0d1b2a 35%, white);
  }
  html[data-theme="light"] {
    color-scheme: light;
    --document-ink: #2b2e3a;
    --document-line: #d5dae3;
    --document-paper: #f3f5f8;
    --document-surface: #fff;
    --document-accent: #0d1b2a;
  }
  * { box-sizing: border-box; }
  body.plan {
    max-width: 760px;
    min-height: calc(100vh - 56px);
    margin: 28px auto;
    padding: 32px 40px;
    border: 1px solid var(--document-line);
    border-radius: 12px;
    color: var(--document-ink);
    background: var(--document-surface);
    font-family: "Google Sans", system-ui, sans-serif;
    line-height: 1.6;
  }
  html { background: var(--document-paper); }
  body.plan pre {
    padding: 12px;
    overflow-x: auto;
    border: 1px solid var(--document-line);
    border-radius: 6px;
    background: var(--document-paper);
  }
  body.plan code { font-size: 0.92em; }
  body.plan a { color: var(--document-accent); }
  @media (max-width: 480px) {
    body.plan { padding: 24px; }
  }
`;

function roomDocument(room: Room): string {
  const source =
    room.contentType === "html"
      ? room.content
      : `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(room.title)}</title>
    <style>${MARKDOWN_DOCUMENT_STYLES}</style>
  </head>
  <body class="plan">${renderMarkdown(room.content)}</body>
</html>`;
  return injectOverlayAssets(source);
}

export function injectOverlayAssets(html: string): string {
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${OVERLAY_ASSETS}\n</body>`);
  }
  return `${html}\n${OVERLAY_ASSETS}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// One cookie per room: the same browser can sit in several rooms at once
// without the sessions overwriting each other.
function cookieName(roomId: string): string {
  return `peanut_${roomId}`;
}

function sessionCookie(roomId: string, participant: Participant): HeadersInit {
  return {
    ...JSON_HEADERS,
    "set-cookie": `${cookieName(roomId)}=${participant.sessionId}; Path=/; HttpOnly; SameSite=Lax`,
  };
}

export function sessionFromCookie(request: Request, roomId: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === cookieName(roomId)) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return {};
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function contentTypeField(body: Record<string, unknown>): ContentType {
  const value = body.contentType;
  if (value === undefined) return "markdown";
  if (value === "markdown" || value === "html") return value;
  throw new RoomError("bad_instruction", "contentType must be markdown or html");
}

function json(value: unknown, status = 200, headers: HeadersInit = JSON_HEADERS): Response {
  return new Response(JSON.stringify(value), { status, headers });
}
