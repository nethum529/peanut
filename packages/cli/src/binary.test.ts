import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End to end against the compiled binary: build it, run share from a
// directory outside the repo, and check that the embedded assets and
// the self re-exec server work.

const ROOT = new URL("../../..", import.meta.url).pathname;
const BINARY = join(ROOT, "dist", "peanut");
const NOTICE = join(ROOT, "dist", "NOTICE");
const SESSION = ".peanut-session.json";

let dir: string;

beforeAll(async () => {
  const build = Bun.spawn(["bun", join(ROOT, "scripts", "build.ts")], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`build failed: ${await new Response(build.stderr).text()}`);
  }
  dir = await mkdtemp(join(tmpdir(), "peanut-binary-"));
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface SessionFile {
  server: string;
  roomId: string;
  agentToken: string;
}

async function waitForSession(): Promise<SessionFile> {
  for (let tries = 0; tries < 200; tries += 1) {
    const file = Bun.file(join(dir, SESSION));
    if (await file.exists()) {
      const parsed = (await file.json().catch(() => null)) as SessionFile | null;
      if (parsed?.roomId) return parsed;
    }
    await Bun.sleep(50);
  }
  throw new Error("no session file appeared");
}

describe("compiled binary", () => {
  test("share serves the room from embedded assets over a re-execed server", async () => {
    await Bun.write(
      join(dir, "plan.html"),
      '<!doctype html><html><body><h1>Plan</h1><img src="shot.png"></body></html>',
    );
    await Bun.write(join(dir, "shot.png"), new Uint8Array([1, 2, 3]));
    const proc = Bun.spawn([BINARY, "share", "plan.html", "--session", SESSION], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const session = await waitForSession();

    const joined = await fetch(`${session.server}/api/rooms/${session.roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ claimHost: true }),
    });
    expect(joined.ok).toBe(true);
    const cookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const document = await fetch(`${session.server}/api/rooms/${session.roomId}/document`, {
      headers: { cookie },
    });
    expect(await document.text()).toContain('<img src="shot.png">');
    const documentAsset = await fetch(`${session.server}/api/rooms/${session.roomId}/shot.png`);
    expect(documentAsset.headers.get("content-type")).toBe("image/png");
    expect(documentAsset.headers.get("cache-control")).toBe("no-store");
    expect(await documentAsset.bytes()).toEqual(new Uint8Array([1, 2, 3]));

    // The page and the client script come from the embedded assets;
    // there are no web sources next to the binary or the cwd.
    const page = await fetch(`${session.server}/${session.roomId}`);
    expect(page.ok).toBe(true);
    expect(await page.text()).toContain("<title>Peanut</title>");
    const script = await fetch(`${session.server}/app.js`);
    expect(script.ok).toBe(true);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await script.text()).length).toBeGreaterThan(1000);
    const overlayScript = await fetch(`${session.server}/overlay.js`);
    expect(overlayScript.ok).toBe(true);
    expect(overlayScript.headers.get("content-type")).toContain("javascript");
    expect((await overlayScript.text()).length).toBeGreaterThan(1000);
    const overlayStyles = await fetch(`${session.server}/overlay.css`);
    expect(overlayStyles.ok).toBe(true);
    expect(overlayStyles.headers.get("content-type")).toContain("text/css");
    expect(await overlayStyles.text()).toContain(".stamp-hover");
    const fontPaths = [
      "google-sans.woff2",
      "google-sans-latin-ext.woff2",
      "google-sans-italic.woff2",
      "google-sans-italic-latin-ext.woff2",
    ];
    for (const path of fontPaths) {
      const font = await fetch(`${session.server}/fonts/${path}`);
      expect(font.ok).toBe(true);
      expect(font.headers.get("content-type")).toBe("font/woff2");
      expect(font.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect((await font.bytes()).length).toBeGreaterThan(1000);
    }
    const assets = [
      ["/icon.svg", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/icon-192.png", "image/png"],
      ["/icon-512.png", "image/png"],
      ["/icon-mask.png", "image/png"],
      ["/manifest.webmanifest", "application/manifest+json"],
    ] as const;
    for (const [path, contentType] of assets) {
      const asset = await fetch(`${session.server}${path}`);
      expect(asset.ok).toBe(true);
      expect(asset.headers.get("content-type")).toBe(contentType);
      expect(await asset.bytes()).toEqual(
        await Bun.file(join(ROOT, "packages/web/public", path.slice(1))).bytes(),
      );
    }
    const notice = await Bun.file(NOTICE).text();
    expect(notice).toContain("Copyright 2025 The Google Sans Project Authors");
    expect(notice).toContain("SIL OPEN FONT LICENSE Version 1.1");

    // End the review; the CLI must exit 1 and stop its server.
    const ended = await fetch(
      `${session.server}/api/rooms/${session.roomId}/agent/end`,
      { method: "POST", headers: { authorization: `Bearer ${session.agentToken}` } },
    );
    expect(ended.ok).toBe(true);
    expect(await proc.exited).toBe(1);
    await Bun.sleep(300);
    let alive = true;
    try {
      await fetch(`${session.server}/api/rooms/x/state`, { signal: AbortSignal.timeout(1000) });
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 30_000);
});
