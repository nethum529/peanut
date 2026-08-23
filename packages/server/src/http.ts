import { parseAnchor } from "./anchors.ts";
import { RoomError, RoomStore, type Participant } from "./rooms.ts";

export interface PeanutServer {
  port: number;
  url: string;
  stop(): void;
  store: RoomStore;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

interface RelayData {
  roomId: string;
  sessionId: string;
}

export function startServer(options: { port?: number } = {}): PeanutServer {
  const store = new RoomStore();
  // One set of live sockets per room. The relay never decodes frames; it
  // only fans them out to the other members of the same room.
  const relayRooms = new Map<string, Set<Bun.ServerWebSocket<RelayData>>>();

  const server = Bun.serve<RelayData>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      try {
        const relayMatch = new URL(request.url).pathname.match(/^\/api\/rooms\/([^/]+)\/relay$/);
        if (relayMatch) {
          const roomId = relayMatch[1]!;
          // The same cookie gate as the HTTP API: no participant session,
          // no socket.
          const participant = store.participant(roomId, sessionFromCookie(request, roomId));
          const upgraded = bunServer.upgrade(request, {
            data: { roomId, sessionId: participant.sessionId },
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
    const { room, host } = store.createRoom({
      title: stringField(body, "title"),
      content: stringField(body, "content"),
      hostName: stringField(body, "hostName") || "Host",
    });
    // The agent token is returned once, to the creator only. It never
    // appears in room state.
    return json(
      { roomId: room.id, agentToken: room.agentToken, state: store.stateFor(room.id, host.sessionId) },
      201,
      sessionCookie(room.id, host),
    );
  }

  const joinMatch = path.match(/^\/api\/rooms\/([^/]+)\/join$/);
  if (request.method === "POST" && joinMatch) {
    const roomId = joinMatch[1]!;
    const body = await readJson(request);
    const participant = store.join(roomId, {
      name: stringField(body, "name"),
      sessionId: sessionFromCookie(request, roomId),
    });
    return json(store.stateFor(roomId, participant.sessionId), 200, sessionCookie(roomId, participant));
  }

  const stateMatch = path.match(/^\/api\/rooms\/([^/]+)\/state$/);
  if (request.method === "GET" && stateMatch) {
    const roomId = stateMatch[1]!;
    const participant = store.participant(roomId, sessionFromCookie(request, roomId));
    return json(store.stateFor(roomId, participant.sessionId));
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

  if (request.method === "GET" && path === "/app.js") {
    return appScript();
  }

  // A room link is /<roomId>. The shell is served for every id; the
  // client shows "room not found" when the state fetch says so.
  if (request.method === "GET" && /^\/[A-Za-z0-9]+$/.test(path)) {
    return new Response(Bun.file(webPath("public/index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return json({ error: "not_found" }, 404);
}

function webPath(relative: string): string {
  return new URL(`../../web/${relative}`, import.meta.url).pathname;
}

let appBundle: string | null = null;

// The client is TypeScript; Bun bundles it in memory on the first
// request and the result is reused for the life of the process.
async function appScript(): Promise<Response> {
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
      return 400;
    case "bad_agent_token":
      return 401;
    case "not_a_participant":
    case "not_allowed":
      return 403;
    case "room_ended":
    case "round_pending":
    case "bad_ack":
      return 409;
  }
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

function json(value: unknown, status = 200, headers: HeadersInit = JSON_HEADERS): Response {
  return new Response(JSON.stringify(value), { status, headers });
}
