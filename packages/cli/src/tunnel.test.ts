import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "../../server/src/http.ts";
import { findTunnelUrl, startTunnel, type Tunnel } from "./tunnel.ts";

describe("findTunnelUrl", () => {
  test("finds the url in real cloudflared output", () => {
    const stderr = [
      "2026-08-22T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-08-22T00:00:01Z INF +--------------------------------------------------------------+",
      "2026-08-22T00:00:01Z INF |  Your quick Tunnel has been created! Visit it at:            |",
      "2026-08-22T00:00:01Z INF |  https://sample-words-here-abcd.trycloudflare.com            |",
      "2026-08-22T00:00:01Z INF +--------------------------------------------------------------+",
    ].join("\n");
    expect(findTunnelUrl(stderr)).toBe("https://sample-words-here-abcd.trycloudflare.com");
  });

  test("returns null when there is no url yet", () => {
    expect(findTunnelUrl("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
    expect(findTunnelUrl("")).toBeNull();
  });
});

describe("startTunnel failure", () => {
  test("returns null when the binary is missing", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-peanut-path";
    try {
      expect(await startTunnel("http://127.0.0.1:1", 1000)).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("kills the child when no url appears before the deadline", async () => {
    // The stub prints no url and records the TERM signal in a marker
    // file, so the test can prove the child was reaped.
    const stubDir = `${process.env.TMPDIR ?? "/tmp"}/peanut-tunnel-stub-${process.pid}`;
    const marker = `${stubDir}/killed`;
    await Bun.write(
      `${stubDir}/cloudflared`,
      `#!/bin/sh\ntrap 'echo yes > ${marker}; exit 0' TERM\necho quiet >&2\nwhile true; do sleep 1; done\n`,
    );
    await Bun.spawn(["chmod", "+x", `${stubDir}/cloudflared`]).exited;
    const savedPath = process.env.PATH;
    process.env.PATH = stubDir;
    try {
      expect(await startTunnel("http://127.0.0.1:1", 500)).toBeNull();
      let killed = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await Bun.file(marker).exists()) {
          killed = true;
          break;
        }
        await Bun.sleep(100);
      }
      expect(killed).toBe(true);
    } finally {
      process.env.PATH = savedPath;
      await Bun.spawn(["rm", "-rf", stubDir]).exited;
    }
  });

  test("returns null fast when the child exits at once", async () => {
    const stubDir = `${process.env.TMPDIR ?? "/tmp"}/peanut-tunnel-exit-${process.pid}`;
    await Bun.write(`${stubDir}/cloudflared`, "#!/bin/sh\necho bad flag >&2\nexit 1\n");
    await Bun.spawn(["chmod", "+x", `${stubDir}/cloudflared`]).exited;
    const savedPath = process.env.PATH;
    process.env.PATH = stubDir;
    const before = Date.now();
    try {
      expect(await startTunnel("http://127.0.0.1:1", 20_000)).toBeNull();
      expect(Date.now() - before).toBeLessThan(5_000);
    } finally {
      process.env.PATH = savedPath;
      await Bun.spawn(["rm", "-rf", stubDir]).exited;
    }
  });
});

// A real quick tunnel needs the network and can take minutes to
// provision, so it runs only on explicit request:
//   PEANUT_TUNNEL_TEST=1 bun test tunnel
describe.skipIf(!process.env.PEANUT_TUNNEL_TEST)("real quick tunnel", () => {
  let tunnel: Tunnel | null = null;

  afterAll(() => {
    if (tunnel) {
      try {
        process.kill(tunnel.pid);
      } catch {
        // Already gone.
      }
    }
  });

  test("the room page loads through the public url", async () => {
    expect(Bun.which("cloudflared")).not.toBeNull();
    const server = startServer({ port: 0 });
    try {
      const created = await fetch(`${server.url}/api/rooms`, {
        method: "POST",
        body: JSON.stringify({ title: "t", content: "# hi", hostless: true }),
      });
      const { roomId } = (await created.json()) as { roomId: string };

      tunnel = await startTunnel(new URL(server.url).origin, 60_000);
      expect(tunnel).not.toBeNull();

      // Edge registration and DNS can lag well after the url prints.
      let page: Response | null = null;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        try {
          page = await fetch(`${tunnel!.url}/${roomId}`);
          if (page.ok) break;
        } catch {
          // Not reachable yet.
        }
        await Bun.sleep(3000);
      }
      expect(page?.ok).toBe(true);
      expect(await page!.text()).toContain("<title>");
    } finally {
      server.stop();
    }
  }, 200_000);
});
