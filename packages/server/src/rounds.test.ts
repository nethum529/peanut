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
  return {
    roomId: body.roomId as string,
    agentToken: body.agentToken as string,
    hostCookie,
    guestCookie: cookieFrom(joined),
  };
}

async function pin(roomId: string, cookie: string, words: string) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/instructions`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ words, anchor }),
  });
  return response.json();
}

async function flush(roomId: string, cookie: string, extra: Record<string, string> = {}) {
  return fetch(`${server.url}/api/rooms/${roomId}/flush`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify(extra),
  });
}

async function poll(roomId: string, token: string, timeoutMs?: number) {
  const query = timeoutMs === undefined ? "" : `?timeoutMs=${timeoutMs}`;
  const response = await fetch(`${server.url}/api/rooms/${roomId}/agent/poll${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = (await response.text()).trim();
  return { response, body: JSON.parse(text) };
}

async function ack(roomId: string, token: string, round: number) {
  return fetch(`${server.url}/api/rooms/${roomId}/agent/ack`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ round }),
  });
}

async function state(roomId: string, cookie: string) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/state`, { headers: { cookie } });
  return response.json();
}

describe("flush", () => {
  test("creation returns an agent token but room state never does", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    expect(agentToken).toMatch(/^[A-Za-z0-9]{22}$/);
    const text = JSON.stringify(await state(roomId, hostCookie));
    expect(text).not.toContain(agentToken);
  });

  test("host flush records a numbered round and empties the pinned list", async () => {
    const { roomId, hostCookie } = await setup();
    await pin(roomId, hostCookie, "Cap the backoff.");
    await pin(roomId, hostCookie, "Reset the counter.");
    const response = await flush(roomId, hostCookie, { nextStep: "Apply and reload." });
    expect(response.status).toBe(201);
    expect((await response.json()).round).toBe(1);
    const view = await state(roomId, hostCookie);
    expect(view.instructions).toHaveLength(0);
    expect(view.rounds).toHaveLength(1);
    expect(view.rounds[0].instructions.map((i: { words: string }) => i.words)).toEqual([
      "Cap the backoff.",
      "Reset the counter.",
    ]);
    expect(view.rounds[0].nextStep).toBe("Apply and reload.");
  });

  test("an empty flush is refused", async () => {
    const { roomId, hostCookie } = await setup();
    expect((await flush(roomId, hostCookie)).status).toBe(400);
  });

  test("an ungranted guest can not flush", async () => {
    const { roomId, guestCookie } = await setup();
    await pin(roomId, guestCookie, "Note.");
    expect((await flush(roomId, guestCookie)).status).toBe(403);
  });
});

describe("agent poll", () => {
  test("a flushed round reaches the poll with snapshot and next_step", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await pin(roomId, hostCookie, "Cap the backoff.");
    await flush(roomId, hostCookie, { domSnapshot: "<main>plan</main>", nextStep: "Reload after." });
    const { body } = await poll(roomId, agentToken, 1000);
    expect(body.status).toBe("round");
    expect(body.round).toBe(1);
    expect(body.instructions[0].words).toBe("Cap the backoff.");
    expect(body.instructions[0].author.name).toBe("Nethum");
    expect(body.dom_snapshot).toBe("<main>plan</main>");
    expect(body.next_step).toBe("Reload after.");
  });

  test("a waiting poll resolves when a flush lands", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    const pending = poll(roomId, agentToken, 5000);
    await Bun.sleep(50);
    await pin(roomId, hostCookie, "Cap the backoff.");
    await flush(roomId, hostCookie);
    const { body } = await pending;
    expect(body.status).toBe("round");
  });

  test("a bounded poll with no round returns waiting", async () => {
    const { roomId, agentToken } = await setup();
    const { body } = await poll(roomId, agentToken, 100);
    expect(body.status).toBe("waiting");
  });

  test("a round repeats on every poll until it is acked", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await pin(roomId, hostCookie, "One.");
    await flush(roomId, hostCookie);
    const first = await poll(roomId, agentToken, 1000);
    expect(first.body.status).toBe("round");
    const again = await poll(roomId, agentToken, 100);
    expect(again.body).toEqual(first.body);
    expect((await ack(roomId, agentToken, 1)).status).toBe(200);
    const after = await poll(roomId, agentToken, 100);
    expect(after.body.status).toBe("waiting");
  });

  test("an ack retry succeeds and a wrong ack is refused", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    expect((await ack(roomId, agentToken, 1)).status).toBe(409);
    await pin(roomId, hostCookie, "One.");
    await flush(roomId, hostCookie);
    expect((await ack(roomId, agentToken, 7)).status).toBe(409);
    expect((await ack(roomId, agentToken, 1)).status).toBe(200);
    expect((await ack(roomId, agentToken, 1)).status).toBe(200);
  });

  test("a late ack for a delivered round succeeds after a newer flush", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await pin(roomId, hostCookie, "One.");
    await flush(roomId, hostCookie);
    await ack(roomId, agentToken, 1);
    await pin(roomId, hostCookie, "Two.");
    await flush(roomId, hostCookie);
    expect((await ack(roomId, agentToken, 1)).status).toBe(200);
    const { body } = await poll(roomId, agentToken, 200);
    expect(body.round).toBe(2);
  });

  test("a flush is refused until the previous round is acked", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await pin(roomId, hostCookie, "One.");
    await flush(roomId, hostCookie);
    await pin(roomId, hostCookie, "Two.");
    expect((await flush(roomId, hostCookie)).status).toBe(409);
    await poll(roomId, agentToken, 500);
    expect((await flush(roomId, hostCookie)).status).toBe(409);
    await ack(roomId, agentToken, 1);
    expect((await flush(roomId, hostCookie)).status).toBe(201);
  });

  test("a reply can target an earlier round by number", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await pin(roomId, hostCookie, "One.");
    await flush(roomId, hostCookie);
    await poll(roomId, agentToken, 500);
    await ack(roomId, agentToken, 1);
    await pin(roomId, hostCookie, "Two.");
    await flush(roomId, hostCookie);
    const response = await fetch(`${server.url}/api/rooms/${roomId}/agent/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ message: "Round one done.", round: 1 }),
    });
    expect(response.status).toBe(201);
    const view = await state(roomId, hostCookie);
    expect(view.rounds[0].reply.message).toBe("Round one done.");
    expect(view.rounds[1].reply).toBeUndefined();
  });

  test("the unbounded poll streams a heartbeat then the round", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    const pending = poll(roomId, agentToken);
    await Bun.sleep(50);
    await pin(roomId, hostCookie, "Streamed.");
    await flush(roomId, hostCookie);
    const { body } = await pending;
    expect(body.status).toBe("round");
    expect(body.instructions[0].words).toBe("Streamed.");
  });

  test("a wrong token is refused everywhere", async () => {
    const { roomId } = await setup();
    const { response } = await poll(roomId, "wrong", 50);
    expect(response.status).toBe(401);
    const reply = await fetch(`${server.url}/api/rooms/${roomId}/agent/reply`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(reply.status).toBe(401);
  });

  test("a participant cookie is not an agent credential", async () => {
    const { roomId, hostCookie } = await setup();
    const response = await fetch(`${server.url}/api/rooms/${roomId}/agent/poll?timeoutMs=50`, {
      headers: { cookie: hostCookie },
    });
    expect(response.status).toBe(401);
  });
});

describe("reply and end", () => {
  test("an agent reply attaches to the latest round", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await pin(roomId, hostCookie, "Do it.");
    await flush(roomId, hostCookie);
    const response = await fetch(`${server.url}/api/rooms/${roomId}/agent/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ message: "Done.", meta: "tests: 18 passed" }),
    });
    expect(response.status).toBe(201);
    const view = await state(roomId, hostCookie);
    expect(view.rounds[0].reply.message).toBe("Done.");
    expect(view.rounds[0].reply.meta).toBe("tests: 18 passed");
  });

  test("a reply with no round is refused", async () => {
    const { roomId, agentToken } = await setup();
    const response = await fetch(`${server.url}/api/rooms/${roomId}/agent/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ message: "Done." }),
    });
    expect(response.status).toBe(403);
  });

  test("host end reaches a waiting agent as ended_by user", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    const pending = poll(roomId, agentToken, 5000);
    await Bun.sleep(50);
    const ended = await fetch(`${server.url}/api/rooms/${roomId}/end`, {
      method: "POST",
      headers: { cookie: hostCookie },
    });
    expect(ended.status).toBe(200);
    const { body } = await pending;
    expect(body).toEqual({ status: "ended", ended_by: "user", verdict: "end" });
  });

  test("a guest can not end the session", async () => {
    const { roomId, guestCookie } = await setup();
    const response = await fetch(`${server.url}/api/rooms/${roomId}/end`, {
      method: "POST",
      headers: { cookie: guestCookie },
    });
    expect(response.status).toBe(403);
  });

  test("agent end marks ended_by agent, but a user end is never overwritten", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await fetch(`${server.url}/api/rooms/${roomId}/agent/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    let view = await state(roomId, hostCookie);
    expect(view.status).toBe("ended");
    expect(view.endedBy).toBe("agent");

    const second = await setup();
    await fetch(`${server.url}/api/rooms/${second.roomId}/end`, {
      method: "POST",
      headers: { cookie: second.hostCookie },
    });
    await fetch(`${server.url}/api/rooms/${second.roomId}/agent/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${second.agentToken}` },
    });
    view = await state(second.roomId, second.hostCookie);
    expect(view.endedBy).toBe("user");
  });

  test("a round flushed just before an end is still delivered first", async () => {
    const { roomId, agentToken, hostCookie } = await setup();
    await pin(roomId, hostCookie, "Last words.");
    await flush(roomId, hostCookie);
    await fetch(`${server.url}/api/rooms/${roomId}/end`, {
      method: "POST",
      headers: { cookie: hostCookie },
    });
    const first = await poll(roomId, agentToken, 500);
    expect(first.body.status).toBe("round");
    expect(first.body.session_ended).toBe(true);
    expect(first.body.ended_by).toBe("user");
    await ack(roomId, agentToken, 1);
    const second = await poll(roomId, agentToken, 100);
    expect(second.body).toEqual({ status: "ended", ended_by: "user", verdict: "end" });
  });

  test("flushing into an ended room is refused", async () => {
    const { roomId, hostCookie } = await setup();
    await pin(roomId, hostCookie, "Too late.");
    await fetch(`${server.url}/api/rooms/${roomId}/end`, {
      method: "POST",
      headers: { cookie: hostCookie },
    });
    expect((await flush(roomId, hostCookie)).status).toBe(409);
  });
});
