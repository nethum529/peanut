import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer, type PeanutServer } from "./http.ts";

let server: PeanutServer;

beforeEach(() => {
  server = startServer();
});

afterEach(() => {
  server.stop();
});

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const anchor = { type: "stamp", selector: "main > p" };

async function setup() {
  const created = await fetch(`${server.url}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ title: "Review", content: "# Plan", hostName: "Nethum" }),
  });
  const body = await created.json();
  const hostCookie = cookieFrom(created);
  const joined = await fetch(`${server.url}/api/rooms/${body.roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ name: "Sam" }),
  });
  const joinedState = await joined.json();
  const guestId = joinedState.you.id as string;
  return {
    roomId: body.roomId as string,
    agentToken: body.agentToken as string,
    hostCookie,
    guestCookie: cookieFrom(joined),
    guestId,
  };
}

async function pin(roomId: string, cookie: string, words: string) {
  return fetch(`${server.url}/api/rooms/${roomId}/instructions`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ words, anchor }),
  });
}

async function flush(roomId: string, cookie: string, extra: Record<string, string> = {}) {
  return fetch(`${server.url}/api/rooms/${roomId}/flush`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify(extra),
  });
}

async function grant(roomId: string, cookie: string, participantId: string, canSend: boolean) {
  return fetch(`${server.url}/api/rooms/${roomId}/grants`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ participantId, canSend }),
  });
}

async function state(roomId: string, cookie: string) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/state`, { headers: { cookie } });
  return response.json();
}

async function poll(roomId: string, token: string, timeoutMs: number) {
  const response = await fetch(
    `${server.url}/api/rooms/${roomId}/agent/poll?timeoutMs=${timeoutMs}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return JSON.parse((await response.text()).trim());
}

describe("send grants", () => {
  test("a granted guest can flush; a revoked one can not", async () => {
    const { roomId, hostCookie, guestCookie, guestId } = await setup();
    await pin(roomId, guestCookie, "One.");
    expect((await flush(roomId, guestCookie)).status).toBe(403);

    expect((await grant(roomId, hostCookie, guestId, true)).status).toBe(200);
    expect((await flush(roomId, guestCookie)).status).toBe(201);

    await pin(roomId, guestCookie, "Two.");
    expect((await grant(roomId, hostCookie, guestId, false)).status).toBe(200);
    expect((await flush(roomId, guestCookie)).status).toBe(403);
  });

  test("room state shows each participant's grant so the UI can render toggles", async () => {
    const { roomId, hostCookie, guestId } = await setup();
    let view = await state(roomId, hostCookie);
    const sam = () => view.participants.find((p: { name: string }) => p.name === "Sam");
    expect(sam().canSend).toBe(false);
    expect(sam().id).toBe(guestId);
    await grant(roomId, hostCookie, guestId, true);
    view = await state(roomId, hostCookie);
    expect(sam().canSend).toBe(true);
  });

  test("a guest can not grant, not even to themselves", async () => {
    const { roomId, guestCookie, guestId } = await setup();
    expect((await grant(roomId, guestCookie, guestId, true)).status).toBe(403);
  });

  test("the host grant can not be changed and unknown targets are refused", async () => {
    const { roomId, hostCookie } = await setup();
    const view = await state(roomId, hostCookie);
    const hostId = view.participants.find((p: { isHost: boolean }) => p.isHost).id;
    expect((await grant(roomId, hostCookie, hostId, false)).status).toBe(403);
    expect((await grant(roomId, hostCookie, "nope", true)).status).toBe(403);
  });

  test("state never leaks session cookies through participant ids", async () => {
    const { roomId, hostCookie, guestCookie, guestId } = await setup();
    const guestSession = guestCookie.split("=")[1]!;
    const text = JSON.stringify(await state(roomId, hostCookie));
    expect(text).not.toContain(guestSession);
    expect(guestId).not.toBe(guestSession);
  });
});

describe("verdicts", () => {
  test("an approve verdict rides the flush and ends the session as ended_by user", async () => {
    const { roomId, hostCookie, agentToken } = await setup();
    await pin(roomId, hostCookie, "Ship it.");
    const response = await flush(roomId, hostCookie, { verdict: "approve" });
    expect(response.status).toBe(201);
    const result = await poll(roomId, agentToken, 500);
    expect(result.status).toBe("round");
    expect(result.verdict).toBe("approve");
    expect(result.session_ended).toBe(true);
    expect(result.ended_by).toBe("user");
    const view = await state(roomId, hostCookie);
    expect(view.status).toBe("ended");
    expect(view.verdict).toBe("approve");
  });

  test("request changes rides the flush and keeps the session live", async () => {
    const { roomId, hostCookie, agentToken } = await setup();
    await pin(roomId, hostCookie, "Fix the copy.");
    await flush(roomId, hostCookie, { verdict: "request_changes" });
    const result = await poll(roomId, agentToken, 500);
    expect(result.status).toBe("round");
    expect(result.verdict).toBe("request_changes");
    expect(result.session_ended).toBeUndefined();
    const view = await state(roomId, hostCookie);
    expect(view.status).toBe("live");
    expect(view.rounds[0].verdict).toBe("request_changes");
  });

  test("a granted guest still can not set a verdict", async () => {
    const { roomId, hostCookie, guestCookie, guestId } = await setup();
    await grant(roomId, hostCookie, guestId, true);
    await pin(roomId, guestCookie, "Note.");
    expect((await flush(roomId, guestCookie, { verdict: "approve" })).status).toBe(403);
  });

  test("host end without a flush reaches the agent as verdict end", async () => {
    const { roomId, hostCookie, agentToken } = await setup();
    await fetch(`${server.url}/api/rooms/${roomId}/end`, {
      method: "POST",
      headers: { cookie: hostCookie },
    });
    const result = await poll(roomId, agentToken, 500);
    expect(result).toEqual({ status: "ended", ended_by: "user", verdict: "end" });
  });

  test("an unknown verdict value is refused", async () => {
    const { roomId, hostCookie } = await setup();
    await pin(roomId, hostCookie, "Note.");
    expect((await flush(roomId, hostCookie, { verdict: "maybe" })).status).toBe(400);
  });
});
