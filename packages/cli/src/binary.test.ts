import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End to end against the compiled binary: build it, run share from a
// directory outside the repo, and check that the embedded assets and
// the self re-exec server work.

const ROOT = new URL("../../..", import.meta.url).pathname;
const BINARY = join(ROOT, "dist", "peanut");
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
    await Bun.write(join(dir, "plan.md"), "# Plan\n\nShip it.\n");
    const proc = Bun.spawn([BINARY, "share", "plan.md", "--session", SESSION], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const session = await waitForSession();

    // The page and the client script come from the embedded assets;
    // there are no web sources next to the binary or the cwd.
    const page = await fetch(`${session.server}/${session.roomId}`);
    expect(page.ok).toBe(true);
    expect(await page.text()).toContain("<title>Peanut</title>");
    const script = await fetch(`${session.server}/app.js`);
    expect(script.ok).toBe(true);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await script.text()).length).toBeGreaterThan(1000);

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
