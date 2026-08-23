import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startServer, type PeanutServer } from "./http.ts";

let server: PeanutServer;

beforeEach(() => {
  server = startServer();
});

afterEach(() => {
  server.stop();
});

describe("web shell", () => {
  test("a room link serves the html shell", async () => {
    const response = await fetch(`${server.url}/someRoomId123`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain('<div id="app">');
    expect(body).toContain("/app.js");
  });

  test("the client bundle is served as javascript", async () => {
    const response = await fetch(`${server.url}/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const body = await response.text();
    expect(body).toContain("renderMarkdown");
  });

  test("api paths never fall through to the shell", async () => {
    const response = await fetch(`${server.url}/api/nope`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });

  test("a visitor without a session gets 403 from state, which cues the join dialog", async () => {
    const created = await fetch(`${server.url}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ title: "T", content: "# Plan", hostName: "H" }),
    });
    const { roomId } = await created.json();
    const state = await fetch(`${server.url}/api/rooms/${roomId}/state`);
    expect(state.status).toBe(403);
  });
});
