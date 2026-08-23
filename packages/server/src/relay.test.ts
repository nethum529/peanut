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

async function createRoom() {
  const response = await fetch(`${server.url}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ title: "Review", content: "# Plan", hostName: "Nethum" }),
  });
  const body = await response.json();
  return { roomId: body.roomId as string, hostCookie: cookieFrom(response) };
}

async function join(roomId: string, name: string) {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return cookieFrom(response);
}

function wsUrl(roomId: string): string {
  return `${server.url.replace("http", "ws")}/api/rooms/${roomId}/relay`;
}

function connect(roomId: string, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun's WebSocket accepts custom headers; the DOM type does not know.
    // @ts-expect-error bun extension
    const socket = new WebSocket(wsUrl(roomId), { headers: { cookie } });
    socket.binaryType = "arraybuffer";
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("connection failed"));
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 1000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message")), timeoutMs);
    socket.onmessage = (event) => {
      clearTimeout(timer);
      resolve(new Uint8Array(event.data as ArrayBuffer));
    };
  });
}

describe("relay", () => {
  test("frames fan out to peers in the room without echoing to the sender", async () => {
    const { roomId, hostCookie } = await createRoom();
    const guestCookie = await join(roomId, "Sam");
    const host = await connect(roomId, hostCookie);
    const guest = await connect(roomId, guestCookie);

    let hostGotEcho = false;
    host.onmessage = () => {
      hostGotEcho = true;
    };
    const waiting = nextMessage(guest);
    const frame = new Uint8Array([1, 2, 3, 255]);
    host.send(frame);
    expect(await waiting).toEqual(frame);
    await Bun.sleep(50);
    expect(hostGotEcho).toBe(false);
    host.close();
    guest.close();
  });

  test("messages never cross rooms", async () => {
    const first = await createRoom();
    const second = await createRoom();
    const a = await connect(first.roomId, first.hostCookie);
    const b = await connect(second.roomId, second.hostCookie);
    let crossed = false;
    b.onmessage = () => {
      crossed = true;
    };
    a.send(new Uint8Array([9]));
    await Bun.sleep(80);
    expect(crossed).toBe(false);
    a.close();
    b.close();
  });

  test("a connection without a valid session is refused", async () => {
    const { roomId } = await createRoom();
    const bare = new Promise<boolean>((resolve) => {
      const socket = new WebSocket(wsUrl(roomId));
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
    });
    expect(await bare).toBe(false);
    const forged = new Promise<boolean>((resolve) => {
      // @ts-expect-error bun extension
      const socket = new WebSocket(wsUrl(roomId), { headers: { cookie: `peanut_${roomId}=forged` } });
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
    });
    expect(await forged).toBe(false);
  });

  test("a disconnect cleans up and the rest keep relaying", async () => {
    const { roomId, hostCookie } = await createRoom();
    const samCookie = await join(roomId, "Sam");
    const alexCookie = await join(roomId, "Alex");
    const host = await connect(roomId, hostCookie);
    const sam = await connect(roomId, samCookie);
    const alex = await connect(roomId, alexCookie);

    sam.close();
    await Bun.sleep(50);
    const waiting = nextMessage(alex);
    host.send(new Uint8Array([7, 7]));
    expect(await waiting).toEqual(new Uint8Array([7, 7]));
    host.close();
    alex.close();
  });

  test("text frames relay unchanged too", async () => {
    const { roomId, hostCookie } = await createRoom();
    const guestCookie = await join(roomId, "Sam");
    const host = await connect(roomId, hostCookie);
    const guest = await connect(roomId, guestCookie);
    const waiting = new Promise<string>((resolve) => {
      guest.onmessage = (event) => resolve(String(event.data));
    });
    host.send("awareness:ping");
    expect(await waiting).toBe("awareness:ping");
    host.close();
    guest.close();
  });
});
