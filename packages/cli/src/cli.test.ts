import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type PeanutServer } from "../../server/src/http.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

let server: PeanutServer;
let dir: string;

beforeEach(async () => {
  server = startServer();
  dir = await mkdtemp(join(tmpdir(), "peanut-cli-"));
});

afterEach(async () => {
  server.stop();
  await rm(dir, { recursive: true, force: true });
});

function run(args: string[]) {
  return Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function writePlan(): Promise<string> {
  const path = join(dir, "plan.md");
  await Bun.write(path, "# Plan\n\nRetry forever on failure.\n");
  return path;
}

interface SessionFile {
  roomId: string;
  agentToken: string;
}

async function waitForSession(path: string): Promise<SessionFile> {
  for (let tries = 0; tries < 100; tries += 1) {
    const file = Bun.file(path);
    if (await file.exists()) {
      const parsed = (await file.json().catch(() => null)) as SessionFile | null;
      if (parsed?.roomId) return parsed;
    }
    await Bun.sleep(50);
  }
  throw new Error("no session file appeared");
}

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function joinAsHost(roomId: string): Promise<string> {
  const response = await fetch(`${server.url}/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ name: "Nethum" }),
  });
  return cookieFrom(response);
}

async function pinAndFlush(
  roomId: string,
  cookie: string,
  words: string,
  verdict?: string,
): Promise<void> {
  await fetch(`${server.url}/api/rooms/${roomId}/instructions`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      words,
      anchor: { type: "range", selector: "p", nodePath: [], startOffset: 0, endOffset: 5, quote: "Retry" },
    }),
  });
  const flushed = await fetch(`${server.url}/api/rooms/${roomId}/flush`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ domSnapshot: "<p>x</p>", nextStep: "Reload.", ...(verdict ? { verdict } : {}) }),
  });
  if (flushed.status !== 201) throw new Error(`flush failed: ${flushed.status}`);
}

describe("peanut cli", () => {
  test("share creates a hostless room, prints the link, and delivers a round", async () => {
    const plan = await writePlan();
    const proc = run(["share", plan, "--server", server.url]);
    const session = await waitForSession(join(dir, ".peanut-session.json"));

    const cookie = await joinAsHost(session.roomId);
    const state = await fetch(`${server.url}/api/rooms/${session.roomId}/state`, {
      headers: { cookie },
    }).then((r) => r.json());
    expect(state.you.isHost).toBe(true);
    expect(state.content).toContain("Retry forever");

    await pinAndFlush(session.roomId, cookie, "Cap the backoff.");
    expect(await proc.exited).toBe(0);
    const out = await new Response(proc.stdout).text();
    expect(out).toContain(`${server.url}/${session.roomId}`);
    expect(out).toContain("== Round 1 ==");
    expect(out).toContain("[Nethum] Cap the backoff.");
    // The round is acked, so the room accepts the next flush.
    const again = await fetch(`${server.url}/api/rooms/${session.roomId}/instructions`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ words: "More.", anchor: { type: "stamp", selector: "p" } }),
    });
    expect(again.status).toBe(201);
  }, 15000);

  test("reply lands on the last round and the verdict ends with exit 0 on approve", async () => {
    const plan = await writePlan();
    const first = run(["share", plan, "--server", server.url]);
    const session = await waitForSession(join(dir, ".peanut-session.json"));
    const cookie = await joinAsHost(session.roomId);
    await pinAndFlush(session.roomId, cookie, "Cap the backoff.");
    expect(await first.exited).toBe(0);

    const second = run(["reply", "Backoff capped at 30s.", "--meta", "tests: 12 passed"]);
    await Bun.sleep(300);
    const state = await fetch(`${server.url}/api/rooms/${session.roomId}/state`, {
      headers: { cookie },
    }).then((r) => r.json());
    expect(state.rounds[0].reply.message).toBe("Backoff capped at 30s.");
    expect(state.rounds[0].reply.meta).toBe("tests: 12 passed");

    await pinAndFlush(session.roomId, cookie, "Looks good.", "approve");
    expect(await second.exited).toBe(0);
    const out = await new Response(second.stdout).text();
    expect(out).toContain("Verdict: approve");
    // The session file is gone after the review ends.
    expect(await Bun.file(join(dir, ".peanut-session.json")).exists()).toBe(false);
  }, 15000);

  test("an end without approve exits nonzero", async () => {
    const plan = await writePlan();
    const proc = run(["share", plan, "--server", server.url]);
    const session = await waitForSession(join(dir, ".peanut-session.json"));
    const cookie = await joinAsHost(session.roomId);
    await fetch(`${server.url}/api/rooms/${session.roomId}/end`, {
      method: "POST",
      headers: { cookie },
    });
    expect(await proc.exited).toBe(1);
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("Verdict: end");
  }, 15000);

  test("share without a server starts one and stops it at the end", async () => {
    const plan = await writePlan();
    const proc = run(["share", plan]);
    const session = (await waitForSession(join(dir, ".peanut-session.json"))) as SessionFile & {
      server: string;
    };
    expect(session.server).toStartWith("http://127.0.0.1:");
    const cookie = await (async () => {
      const response = await fetch(`${session.server}/api/rooms/${session.roomId}/join`, {
        method: "POST",
        body: JSON.stringify({ name: "Nethum" }),
      });
      return cookieFrom(response);
    })();
    await fetch(`${session.server}/api/rooms/${session.roomId}/end`, {
      method: "POST",
      headers: { cookie },
    });
    expect(await proc.exited).toBe(1);
    // The started server goes down with the review.
    await Bun.sleep(300);
    let alive = true;
    try {
      await fetch(`${session.server}/api/rooms/x/state`, { signal: AbortSignal.timeout(1000) });
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 20000);

  test("a missing file or unknown command fails with exit 2", async () => {
    const missing = run(["share", join(dir, "nope.md"), "--server", server.url]);
    expect(await missing.exited).toBe(2);
    const unknown = run(["frobnicate"]);
    expect(await unknown.exited).toBe(2);
  }, 15000);
});
