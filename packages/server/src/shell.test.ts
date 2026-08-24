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
    expect(body).toContain('font-family: "Google Sans", system-ui, sans-serif');
    expect(body).toContain('src: url("/fonts/google-sans.woff2")');
    expect(body).toContain("font-weight: 400 700;");
    expect(body).toContain("font-style: italic;");
    expect(body).toContain("unicode-range:");
    expect(body).not.toContain("google-sans-400.woff2");
    expect(body).not.toContain("fonts.googleapis.com");
  });

  test("the client bundle is served as javascript", async () => {
    const response = await fetch(`${server.url}/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const body = await response.text();
    expect(body).toContain("renderMarkdown");
  });

  test("self-hosted fonts are served as woff2", async () => {
    const paths = [
      "google-sans.woff2",
      "google-sans-latin-ext.woff2",
      "google-sans-italic.woff2",
      "google-sans-italic-latin-ext.woff2",
    ];
    for (const path of paths) {
      const response = await fetch(`${server.url}/fonts/${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("font/woff2");
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(new TextDecoder().decode((await response.bytes()).slice(0, 4))).toBe("wOF2");
    }
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
