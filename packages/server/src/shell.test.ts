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
    expect(body).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(body).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
    expect(body).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(body).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  });

  test("the client bundle is served as javascript", async () => {
    const response = await fetch(`${server.url}/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const body = await response.text();
    expect(body).toContain("plan-frame");
    expect(body).toContain("isOverlayToChromeMessage");
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

  test("web app icons are served with their declared content types", async () => {
    const assets = [
      ["/icon.svg", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/icon-192.png", "image/png"],
      ["/icon-512.png", "image/png"],
      ["/icon-mask.png", "image/png"],
    ] as const;
    for (const [path, contentType] of assets) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect((await response.bytes()).length).toBeGreaterThan(100);
    }
  });

  test("the web app manifest lists the Peanut icons", async () => {
    const response = await fetch(`${server.url}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/manifest+json");
    const manifest = await response.json();
    expect(manifest).toMatchObject({
      name: "Peanut",
      background_color: "#0d1b2a",
      theme_color: "#0d1b2a",
    });
    expect(manifest.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-mask.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ]);
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
