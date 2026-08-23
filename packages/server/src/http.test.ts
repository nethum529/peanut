import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer, type PeanutServer } from "./http.ts";
import { COLOR_PALETTE } from "./rooms.ts";

let server: PeanutServer;

beforeEach(() => {
  server = startServer();
});

afterEach(() => {
  server.stop();
});

async function createRoom() {
  const response = await fetch(`${server.url}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ title: "Retry review", content: "# Plan", hostName: "Nethum" }),
  });
  const body = await response.json();
  return { response, body, cookie: cookieFrom(response) };
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

async function join(roomId: string, name: string, cookie?: string) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: JSON.stringify({ name }),
  });
  return { response, body: await response.json(), cookie: cookieFrom(response) };
}

describe("room creation", () => {
  test("creates a room with an unguessable id and a host session", async () => {
    const { response, body, cookie } = await createRoom();
    expect(response.status).toBe(201);
    expect(body.roomId).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(body.state.you.isHost).toBe(true);
    expect(body.state.you.name).toBe("Nethum");
    expect(cookie).toContain(`peanut_${body.roomId}=`);
  });
});

describe("guest join", () => {
  test("guest gets a session cookie, a palette color, and shows in state", async () => {
    const { body: created } = await createRoom();
    const { response, body, cookie } = await join(created.roomId, "Sam");
    expect(response.status).toBe(200);
    expect(cookie).toContain(`peanut_${created.roomId}=`);
    expect(body.you.isHost).toBe(false);
    expect(COLOR_PALETTE).toContain(body.you.color);
    expect(body.participants.map((p: { name: string }) => p.name)).toEqual(["Nethum", "Sam"]);
  });

  test("rejoining with the same cookie reuses the session", async () => {
    const { body: created } = await createRoom();
    const first = await join(created.roomId, "Sam");
    const second = await join(created.roomId, "Sam again", first.cookie);
    expect(second.body.you.name).toBe("Sam");
    expect(second.body.participants).toHaveLength(2);
  });

  test("a blank name is refused", async () => {
    const { body: created } = await createRoom();
    const { response } = await join(created.roomId, "   ");
    expect(response.status).toBe(400);
  });

  test("joining a missing room is a 404", async () => {
    const { response } = await join("nope", "Sam");
    expect(response.status).toBe(404);
  });
});

describe("room state", () => {
  test("requires a valid session", async () => {
    const { body: created } = await createRoom();
    const bare = await fetch(`${server.url}/api/rooms/${created.roomId}/state`);
    expect(bare.status).toBe(403);
    const forged = await fetch(`${server.url}/api/rooms/${created.roomId}/state`, {
      headers: { cookie: `peanut_${created.roomId}=forged` },
    });
    expect(forged.status).toBe(403);
  });

  test("never exposes session ids", async () => {
    const { body: created, cookie } = await createRoom();
    await join(created.roomId, "Sam");
    const response = await fetch(`${server.url}/api/rooms/${created.roomId}/state`, {
      headers: { cookie },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("sessionId");
    const state = JSON.parse(text);
    expect(state.participants).toHaveLength(2);
    expect(state.you.you).toBe(true);
  });

  test("cookies from one room do not leak into another", async () => {
    const first = await createRoom();
    const second = await createRoom();
    const response = await fetch(`${server.url}/api/rooms/${second.body.roomId}/state`, {
      headers: { cookie: first.cookie },
    });
    expect(response.status).toBe(403);
  });
});
