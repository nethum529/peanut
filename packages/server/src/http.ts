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
    return json(
      { roomId: room.id, state: store.stateFor(room.id, host.sessionId) },
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

  return json({ error: "not_found" }, 404);
}

function statusFor(code: RoomError["code"]): number {
  switch (code) {
    case "room_not_found":
    case "instruction_not_found":
      return 404;
    case "bad_name":
    case "bad_instruction":
      return 400;
    case "not_a_participant":
    case "not_allowed":
      return 403;
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
