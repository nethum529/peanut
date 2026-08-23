import { parseAnchor } from "./anchors.ts";
import { RoomError, RoomStore, type Participant } from "./rooms.ts";

export interface PeanutServer {
  port: number;
  url: string;
  stop(): void;
  store: RoomStore;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function startServer(options: { port?: number } = {}): PeanutServer {
  const store = new RoomStore();

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      try {
        return await route(request, store);
      } catch (error) {
        if (error instanceof RoomError) {
          return json({ error: error.code, message: error.message }, statusFor(error.code));
        }
        throw error;
      }
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
    const round = store.flushRound(roomId, sessionFromCookie(request, roomId), {
      domSnapshot: stringField(body, "domSnapshot"),
      nextStep: stringField(body, "nextStep"),
    });
    return json({ round: round.number }, 201);
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
    store.agentReply(
      replyMatch[1]!,
      bearerToken(request),
      stringField(body, "message"),
      stringField(body, "meta") || undefined,
    );
    return json({ replied: true }, 201);
  }

  const agentEndMatch = path.match(/^\/api\/rooms\/([^/]+)\/agent\/end$/);
  if (request.method === "POST" && agentEndMatch) {
    store.endByAgent(agentEndMatch[1]!, bearerToken(request));
    return json({ ended: true });
  }

  return json({ error: "not_found" }, 404);
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
// heartbeat space until a round or the end of the session arrives, and a
// take that can not be written back to the client is restored.
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

  const immediate = store.takeRound(roomId, token);
  if (immediate.status !== "waiting") {
    if (request.signal.aborted) {
      store.restoreRound(roomId, token, immediate);
      return json({ status: "waiting" });
    }
    return json(immediate);
  }

  if (timeoutMs !== null) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || request.signal.aborted) return json({ status: "waiting" });
      await Promise.race([store.waitForChange(roomId, request.signal), sleep(remaining)]);
      const result = store.takeRound(roomId, token);
      if (result.status === "waiting") continue;
      if (request.signal.aborted) {
        store.restoreRound(roomId, token, result);
        return json({ status: "waiting" });
      }
      return json(result);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(" "));
      }, POLL_HEARTBEAT_MS);
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
      };
      const onAbort = () => finish();
      request.signal.addEventListener("abort", onAbort, { once: true });
      (async () => {
        while (!closed) {
          await store.waitForChange(roomId, request.signal);
          if (request.signal.aborted) {
            finish();
            return;
          }
          const result = store.takeRound(roomId, token);
          if (result.status === "waiting") continue;
          if (closed || request.signal.aborted) {
            store.restoreRound(roomId, token, result);
            return;
          }
          controller.enqueue(encoder.encode(JSON.stringify(result)));
          finish();
          controller.close();
          return;
        }
      })().catch(() => finish());
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
