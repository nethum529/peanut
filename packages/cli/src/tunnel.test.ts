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
      expect(await startTunnel(1, 1000)).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("returns null when no url appears before the deadline", async () => {
    // A port with nothing behind it still lets cloudflared start, but
    // with PATH pointed at a stub that prints no url, the deadline
    // must fire and the child must be reaped.
    const stubDir = `${process.env.TMPDIR ?? "/tmp"}/peanut-tunnel-stub-${process.pid}`;
    await Bun.write(`${stubDir}/cloudflared`, "#!/bin/sh\necho quiet >&2\nsleep 30\n");
    await Bun.spawn(["chmod", "+x", `${stubDir}/cloudflared`]).exited;
    const savedPath = process.env.PATH;
    process.env.PATH = stubDir;
    try {
      expect(await startTunnel(1, 500)).toBeNull();
    } finally {
      process.env.PATH = savedPath;
      await Bun.spawn(["rm", "-rf", stubDir]).exited;
    }
  });
});

describe.skipIf(!Bun.which("cloudflared"))("real quick tunnel", () => {
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
    const server = startServer({ port: 0 });
    try {
      const created = await fetch(`${server.url}/api/rooms`, {
        method: "POST",
        body: JSON.stringify({ title: "t", content: "# hi", hostless: true }),
      });
      const { roomId } = (await created.json()) as { roomId: string };

      tunnel = await startTunnel(Number(new URL(server.url).port));
      expect(tunnel).not.toBeNull();

      // The edge can lag or refuse connections for a moment after
      // the url prints.
      let page: Response | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          page = await fetch(`${tunnel!.url}/${roomId}`);
          if (page.ok) break;
        } catch {
          // Not reachable yet.
        }
        await Bun.sleep(2000);
      }
      expect(page!.ok).toBe(true);
      expect(await page!.text()).toContain("<title>");
    } finally {
      server.stop();
    }
  }, 40_000);
});
