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

const SESSION = ".peanut-session.json";

function run(args: string[]) {
  return Bun.spawn([process.execPath, MAIN, ...args, "--session", SESSION], {
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
  filePath?: string;
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
    expect(state.contentType).toBe("markdown");

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

  test("share sends html and htm files as HTML", async () => {
    for (const name of ["artifact.html", "artifact.HTM"]) {
      const path = join(dir, name);
      await Bun.write(path, '<!doctype html><body><button onclick="window.clicked=true">Try</button></body>');
      const sessionPath = `${name}.session.json`;
      const proc = Bun.spawn(
        [process.execPath, MAIN, "share", path, "--server", server.url, "--session", sessionPath],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      const session = await waitForSession(join(dir, sessionPath));
      const htmlCookie = await joinAsHost(session.roomId);
      const state = await fetch(`${server.url}/api/rooms/${session.roomId}/state`, {
        headers: { cookie: htmlCookie },
      }).then((response) => response.json());
      expect(state.contentType).toBe("html");
      const document = await fetch(`${server.url}/api/rooms/${session.roomId}/document`, {
        headers: { cookie: htmlCookie },
      }).then((response) => response.text());
      expect(document).toContain('onclick="window.clicked=true"');
      expect(document).toContain('src="/overlay.js"');
      await fetch(`${server.url}/api/rooms/${session.roomId}/end`, {
        method: "POST",
        headers: { cookie: htmlCookie },
      });
      expect(await proc.exited).toBe(1);
    }
  }, 20_000);

  test("reply lands on the last round and the verdict ends with exit 0 on approve", async () => {
    const plan = await writePlan();
    const first = run(["share", plan, "--server", server.url]);
    const session = await waitForSession(join(dir, ".peanut-session.json"));
    const cookie = await joinAsHost(session.roomId);
    await pinAndFlush(session.roomId, cookie, "Cap the backoff.");
    expect(await first.exited).toBe(0);

    await Bun.write(plan, "# Plan\n\nBackoff is capped at 30 seconds.\n");

    const second = run(["reply", "Backoff capped at 30s.", "--meta", "tests: 12 passed"]);
    await Bun.sleep(300);
    const state = await fetch(`${server.url}/api/rooms/${session.roomId}/state`, {
      headers: { cookie },
    }).then((r) => r.json());
    expect(state.rounds[0].reply.message).toBe("Backoff capped at 30s.");
    expect(state.rounds[0].reply.meta).toBe("tests: 12 passed");
    expect(state.content).toContain("Backoff is capped at 30 seconds.");
    expect(state.contentVersion).toBe(2);

    await pinAndFlush(session.roomId, cookie, "Looks good.", "approve");
    expect(await second.exited).toBe(0);
    const out = await new Response(second.stdout).text();
    expect(out).toContain("Verdict: approve");
    // The session file is gone after the review ends.
    expect(await Bun.file(join(dir, ".peanut-session.json")).exists()).toBe(false);
  }, 15000);

  test("push sends changed content and returns without waiting for a round", async () => {
    const plan = await writePlan();
    const sharing = run(["share", plan, "--server", server.url]);
    const session = await waitForSession(join(dir, SESSION));
    const cookie = await joinAsHost(session.roomId);

    await Bun.write(plan, "# Plan\n\nCurrent without a reply.\n");
    const pushing = run(["push"]);
    expect(await pushing.exited).toBe(0);
    expect(await new Response(pushing.stdout).text()).toContain("Document pushed.");

    const unchanged = run(["push"]);
    expect(await unchanged.exited).toBe(0);
    expect(await new Response(unchanged.stdout).text()).toContain("Document unchanged.");

    const state = await fetch(`${server.url}/api/rooms/${session.roomId}/state`, {
      headers: { cookie },
    }).then((response) => response.json());
    expect(state.content).toContain("Current without a reply.");
    expect(state.contentVersion).toBe(2);

    await fetch(`${server.url}/api/rooms/${session.roomId}/end`, {
      method: "POST",
      headers: { cookie },
    });
    expect(await sharing.exited).toBe(1);
  }, 15000);

  test("reply warns after a host end, prints the verdict, and cleans up", async () => {
    const plan = await writePlan();
    const sharing = run(["share", plan, "--server", server.url]);
    const sessionPath = join(dir, SESSION);
    const session = await waitForSession(sessionPath);
    const cookie = await joinAsHost(session.roomId);
    await pinAndFlush(session.roomId, cookie, "Finish the work.");
    expect(await sharing.exited).toBe(0);

    await fetch(`${server.url}/api/rooms/${session.roomId}/end`, {
      method: "POST",
      headers: { cookie },
    });
    const replying = run(["reply", "Work finished."]);
    expect(await replying.exited).toBe(1);
    const output = await new Response(replying.stdout).text();
    expect(output).toContain("== Review ended ==");
    expect(output).toContain("Verdict: end (by user)");
    expect(await new Response(replying.stderr).text()).toContain(
      "Warning: The content update was refused (409).",
    );
    expect(await Bun.file(sessionPath).exists()).toBe(false);
  }, 15000);

  test("reply warns for a missing file, sends the reply, and keeps the content", async () => {
    const plan = await writePlan();
    const sharing = run(["share", plan, "--server", server.url]);
    const session = await waitForSession(join(dir, SESSION));
    const cookie = await joinAsHost(session.roomId);
    await pinAndFlush(session.roomId, cookie, "Remove the file.");
    expect(await sharing.exited).toBe(0);
    await rm(plan);

    const replying = run(["reply", "The file is gone."]);
    await Bun.sleep(300);
    const state = await fetch(`${server.url}/api/rooms/${session.roomId}/state`, {
      headers: { cookie },
    }).then((response) => response.json());
    expect(state.rounds[0].reply.message).toBe("The file is gone.");
    expect(state.content).toContain("Retry forever on failure.");
    expect(state.contentVersion).toBe(1);

    await pinAndFlush(session.roomId, cookie, "Done.", "approve");
    expect(await replying.exited).toBe(0);
    expect(await new Response(replying.stderr).text()).toContain(
      "Warning: The shared file no longer exists",
    );
  }, 15000);

  test("old sessions warn and skip content updates for push and reply", async () => {
    const plan = await writePlan();
    const sharing = run(["share", plan, "--server", server.url]);
    const sessionPath = join(dir, SESSION);
    const session = await waitForSession(sessionPath);
    const cookie = await joinAsHost(session.roomId);
    await pinAndFlush(session.roomId, cookie, "Keep compatibility.");
    expect(await sharing.exited).toBe(0);

    const stored = await Bun.file(sessionPath).json();
    delete stored.filePath;
    await Bun.write(sessionPath, JSON.stringify(stored));
    await Bun.write(plan, "# New content that must not be sent\n");

    const pushing = run(["push"]);
    expect(await pushing.exited).toBe(0);
    expect(await new Response(pushing.stderr).text()).toContain("older session has no file path");

    const replying = run(["reply", "Compatibility kept."]);
    await Bun.sleep(300);
    const state = await fetch(`${server.url}/api/rooms/${session.roomId}/state`, {
      headers: { cookie },
    }).then((response) => response.json());
    expect(state.rounds[0].reply.message).toBe("Compatibility kept.");
    expect(state.content).toContain("Retry forever on failure.");
    expect(state.contentVersion).toBe(1);
    await pinAndFlush(session.roomId, cookie, "Done.", "approve");
    expect(await replying.exited).toBe(0);
    expect(await new Response(replying.stderr).text()).toContain("older session has no file path");
  }, 15000);

  test("push refuses an ended room with no rounds", async () => {
    const plan = await writePlan();
    const created = await fetch(`${server.url}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({ title: "Ended", content: "# Plan", hostless: true }),
    }).then((response) => response.json());
    await fetch(`${server.url}/api/rooms/${created.roomId}/agent/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.agentToken}` },
    });
    await Bun.write(
      join(dir, SESSION),
      JSON.stringify({
        server: server.url,
        roomId: created.roomId,
        agentToken: created.agentToken,
        lastRound: 0,
        filePath: plan,
      }),
    );

    const pushing = run(["push"]);
    expect(await pushing.exited).toBe(2);
    expect(await new Response(pushing.stderr).text()).toContain(
      "The content update was refused (409).",
    );
  });

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

  test("wait survives dropped poll connections and resumes the review", async () => {
    // A proxy that kills the first two connections, then forwards.
    // The retrying poll must ride through and deliver the round.
    const targetPort = Number(new URL(server.url).port);
    let seen = 0;
    const proxy = Bun.listen<{ upstream?: Bun.Socket; pending: Uint8Array[] }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { pending: [] };
          seen += 1;
          if (seen <= 2) {
            socket.end();
            return;
          }
          Bun.connect({
            hostname: "127.0.0.1",
            port: targetPort,
            socket: {
              data(_upstream, chunk) {
                socket.write(chunk);
              },
              close() {
                socket.end();
              },
              error() {
                socket.end();
              },
            },
          }).then((upstream) => {
            socket.data.upstream = upstream;
            for (const chunk of socket.data.pending) upstream.write(chunk);
            socket.data.pending = [];
          });
        },
        data(socket, chunk) {
          if (socket.data.upstream) socket.data.upstream.write(chunk);
          else socket.data.pending.push(new Uint8Array(chunk));
        },
        close(socket) {
          socket.data.upstream?.end();
        },
        error(socket) {
          socket.data.upstream?.end();
        },
      },
    });

    const plan = await writePlan();
    const first = run(["share", plan, "--server", server.url]);
    const session = await waitForSession(join(dir, SESSION));
    const cookie = await joinAsHost(session.roomId);
    await pinAndFlush(session.roomId, cookie, "Cap the backoff.");
    expect(await first.exited).toBe(0);

    // Point the session at the flaky proxy and resume with wait.
    const stored = await Bun.file(join(dir, SESSION)).json();
    stored.server = `http://127.0.0.1:${proxy.port}`;
    await Bun.write(join(dir, SESSION), JSON.stringify(stored));
    const waiting = run(["wait"]);
    await Bun.sleep(500);
    await pinAndFlush(session.roomId, cookie, "Also log attempts.");
    expect(await waiting.exited).toBe(0);
    const out = await new Response(waiting.stdout).text();
    expect(out).toContain("== Round 2 ==");
    expect(out).toContain("Also log attempts.");
    expect(seen).toBeGreaterThan(2);
    proxy.stop(true);
  }, 20000);

  test("wait against a dead server exits 2 after bounded retries", async () => {
    await Bun.write(
      join(dir, SESSION),
      JSON.stringify({ server: "http://127.0.0.1:9", roomId: "x", agentToken: "y", lastRound: 0 }),
    );
    const proc = run(["wait"]);
    expect(await proc.exited).toBe(2);
    const err = await new Response(proc.stderr).text();
    expect(err).toContain("peanut wait");
  }, 20000);

  test("a dead server is a usage error, not a verdict", async () => {
    await Bun.write(
      join(dir, SESSION),
      JSON.stringify({ server: "http://127.0.0.1:9", roomId: "x", agentToken: "y", lastRound: 1 }),
    );
    const proc = run(["reply", "done"]);
    expect(await proc.exited).toBe(2);
  }, 15000);

  test("a missing file or unknown command fails with exit 2", async () => {
    const missing = run(["share", join(dir, "nope.md"), "--server", server.url]);
    expect(await missing.exited).toBe(2);
    const unknown = run(["frobnicate"]);
    expect(await unknown.exited).toBe(2);
  }, 15000);
});
