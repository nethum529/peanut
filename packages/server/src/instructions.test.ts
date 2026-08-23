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

async function setup() {
  const created = await fetch(`${server.url}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ title: "Review", content: "# Plan", hostName: "Nethum" }),
  });
  const { roomId } = await created.json();
  const hostCookie = cookieFrom(created);
  const joined = await fetch(`${server.url}/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ name: "Sam" }),
  });
  const guestCookie = cookieFrom(joined);
  return { roomId, hostCookie, guestCookie };
}

const stampAnchor = { type: "stamp", selector: "main > p:nth-of-type(2)" };
const rangeAnchor = {
  type: "range",
  selector: "#intro",
  nodePath: [0, 1],
  startOffset: 4,
  endOffset: 19,
  quote: "retry the upload",
};

async function pin(roomId: string, cookie: string, words: string, anchor: unknown = stampAnchor) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/instructions`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ words, anchor }),
  });
  return { response, body: await response.json() };
}

async function state(roomId: string, cookie: string) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/state`, {
    headers: { cookie },
  });
  return response.json();
}

async function remove(roomId: string, cookie: string, id: string) {
  return fetch(`${server.url}/api/rooms/${roomId}/instructions/${id}`, {
    method: "DELETE",
    headers: { cookie },
  });
}

describe("pinning", () => {
  test("a joined session pins an instruction and state lists it with its author", async () => {
    const { roomId, guestCookie, hostCookie } = await setup();
    const { response } = await pin(roomId, guestCookie, "State when the counter resets.");
    expect(response.status).toBe(201);
    const view = await state(roomId, hostCookie);
    expect(view.instructions).toHaveLength(1);
    expect(view.instructions[0].words).toBe("State when the counter resets.");
    expect(view.instructions[0].author.name).toBe("Sam");
    expect(view.instructions[0].mine).toBe(false);
  });

  test("a range anchor round-trips unchanged", async () => {
    const { roomId, hostCookie } = await setup();
    await pin(roomId, hostCookie, "Tighten this sentence.", rangeAnchor);
    const view = await state(roomId, hostCookie);
    expect(view.instructions[0].anchor).toEqual(rangeAnchor);
    expect(view.instructions[0].mine).toBe(true);
  });

  test("empty words or a broken anchor are refused", async () => {
    const { roomId, hostCookie } = await setup();
    expect((await pin(roomId, hostCookie, "   ")).response.status).toBe(400);
    expect((await pin(roomId, hostCookie, "ok", { type: "stamp" })).response.status).toBe(400);
    expect(
      (await pin(roomId, hostCookie, "ok", { type: "range", selector: "p", nodePath: [-1], startOffset: 0, endOffset: 1, quote: "" }))
        .response.status,
    ).toBe(400);
  });

  test("an outsider can not pin", async () => {
    const { roomId } = await setup();
    const { response } = await pin(roomId, "", "hello");
    expect(response.status).toBe(403);
  });
});

describe("removal", () => {
  test("the author removes their own instruction", async () => {
    const { roomId, guestCookie } = await setup();
    const { body } = await pin(roomId, guestCookie, "Drop this.");
    expect((await remove(roomId, guestCookie, body.id)).status).toBe(200);
    const view = await state(roomId, guestCookie);
    expect(view.instructions).toHaveLength(0);
  });

  test("the host prunes any instruction", async () => {
    const { roomId, hostCookie, guestCookie } = await setup();
    const { body } = await pin(roomId, guestCookie, "Guest note.");
    expect((await remove(roomId, hostCookie, body.id)).status).toBe(200);
  });

  test("a guest can not remove another author's instruction", async () => {
    const { roomId, hostCookie, guestCookie } = await setup();
    const { body } = await pin(roomId, hostCookie, "Host note.");
    expect((await remove(roomId, guestCookie, body.id)).status).toBe(403);
    const view = await state(roomId, hostCookie);
    expect(view.instructions).toHaveLength(1);
  });

  test("removing a missing instruction is a 404", async () => {
    const { roomId, hostCookie } = await setup();
    expect((await remove(roomId, hostCookie, "nope")).status).toBe(404);
  });
});

describe("instructions after the end", () => {
  test("an ended room refuses pin and remove with 409", async () => {
    const { roomId, hostCookie } = await setup();
    const { body: pinned } = await pin(roomId, hostCookie, "before the end");
    await fetch(`${server.url}/api/rooms/${roomId}/end`, {
      method: "POST",
      headers: { cookie: hostCookie },
    });
    const { response: late } = await pin(roomId, hostCookie, "too late");
    expect(late.status).toBe(409);
    const removal = await remove(roomId, hostCookie, pinned.id);
    expect(removal.status).toBe(409);
  });
});
