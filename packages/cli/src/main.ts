import { unlink } from "node:fs/promises";
import { formatEnded, formatRound, isApproved, type WireEnded, type WireRound } from "./format.ts";

// The peanut CLI. Each invocation blocks until the next round or the
// final verdict, prints it, and exits. The room lives in a session
// file, so a later invocation continues the same review.
//
//   peanut share <file> [--title t] [--server url] [--session path]
//   peanut reply <message> [--meta m] [--session path]
//   peanut serve [--state path] [--port n]
//
// Exit codes: 0 for a delivered round or an approve, 1 for a review
// that ended without approve, 2 for a usage or file error.

const POLL_TIMEOUT_MS = 25_000;

interface Session {
  server: string;
  roomId: string;
  agentToken: string;
  lastRound: number;
  // Set only when this CLI started the server, so only then is the
  // server stopped at the end of the review.
  serverPid?: number;
}

interface Flags {
  positional: string[];
  named: Map<string, string>;
}

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      named.set(arg.slice(2), argv[index + 1] ?? "");
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, named };
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// The default session file lives outside the working directory: it
// holds the agent token, and a secret in cwd is one git add -A away
// from a commit. The path is keyed by cwd, so a later invocation from
// the same directory finds the same review.
function sessionPath(flags: Flags): string {
  const explicit = flags.named.get("session");
  if (explicit) return explicit;
  const key = Bun.hash(process.cwd()).toString(36);
  return `${process.env.TMPDIR ?? "/tmp"}/peanut-session-${key}.json`;
}

async function loadSession(flags: Flags): Promise<Session> {
  const file = Bun.file(sessionPath(flags));
  if (!(await file.exists())) {
    fail(`No review session found at ${sessionPath(flags)}. Start one with: peanut share <file>`);
  }
  return (await file.json()) as Session;
}

async function saveSession(flags: Flags, session: Session): Promise<void> {
  await Bun.write(sessionPath(flags), JSON.stringify(session, null, 2));
}

async function api(
  session: Session,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Response> {
  return fetch(`${session.server}${path}`, {
    method,
    headers: { authorization: `Bearer ${session.agentToken}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function serverAlive(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/rooms/none/state`, { signal: AbortSignal.timeout(1500) });
    return response.status === 404 || response.status === 403;
  } catch {
    return false;
  }
}

// Starts a detached peanut server and reads its url from the state
// file it writes once it listens.
async function startDetachedServer(): Promise<{ url: string; pid: number }> {
  const stateFile = `${process.env.TMPDIR ?? "/tmp"}/peanut-server-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  const child = Bun.spawn(
    [process.execPath, new URL("./main.ts", import.meta.url).pathname, "serve", "--state", stateFile],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const file = Bun.file(stateFile);
    if (await file.exists()) {
      const state = (await file.json().catch(() => null)) as { url?: string } | null;
      if (state?.url) {
        await unlink(stateFile).catch(() => {});
        return { url: state.url, pid: child.pid };
      }
    }
    await Bun.sleep(100);
  }
  child.kill();
  fail("Could not start the peanut server.");
}

async function finishReview(
  flags: Flags,
  session: Session,
  ended: boolean,
  code: number,
): Promise<never> {
  if (ended) {
    if (session.serverPid) {
      try {
        process.kill(session.serverPid);
      } catch {
        // The server was already gone; nothing to stop.
      }
    }
    await unlink(sessionPath(flags)).catch(() => {});
  }
  process.exit(code);
}

// The room refuses new flushes until the round is acknowledged, so a
// failed ack would wedge the review. Retry, and treat a conflict as
// already acknowledged only after the server confirms the round exists.
async function ackRound(session: Session, round: number): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await api(session, "POST", `/api/rooms/${session.roomId}/agent/ack`, {
        round,
      });
      if (response.ok) return;
      lastStatus = response.status;
    } catch {
      lastStatus = 0;
    }
    await Bun.sleep(200);
  }
  fail(`Could not acknowledge round ${round} (status ${lastStatus}). Run peanut reply to retry.`);
}

// Blocks until the next round or the end of the review, prints it,
// acknowledges a round, and exits.
async function waitAndPrint(flags: Flags, session: Session): Promise<never> {
  while (true) {
    const response = await api(
      session,
      "GET",
      `/api/rooms/${session.roomId}/agent/poll?timeoutMs=${POLL_TIMEOUT_MS}`,
    );
    if (!response.ok) {
      fail(`The server refused the poll (${response.status}). The review may be gone.`);
    }
    const result = (await response.json()) as { status: "waiting" } | WireRound | WireEnded;
    if (result.status === "waiting") continue;
    if (result.status === "ended") {
      console.log(formatEnded(result));
      return finishReview(flags, session, true, isApproved(result) ? 0 : 1);
    }
    console.log(formatRound(result));
    // The session records the round before the ack, so a reply after a
    // wedged ack still targets the round that was printed.
    session.lastRound = result.round;
    await saveSession(flags, session);
    await ackRound(session, result.round);
    if (result.session_ended) {
      return finishReview(flags, session, true, isApproved(result) ? 0 : 1);
    }
    return finishReview(flags, session, false, 0);
  }
}

async function share(flags: Flags): Promise<never> {
  const filePath = flags.positional[0];
  if (!filePath) fail("Usage: peanut share <file> [--title t] [--server url]");
  const file = Bun.file(filePath);
  if (!(await file.exists())) fail(`No such file: ${filePath}`);
  const content = await file.text();

  let server = flags.named.get("server") ?? "";
  let serverPid: number | undefined;
  if (server) {
    if (!(await serverAlive(server))) fail(`No peanut server answers at ${server}.`);
  } else {
    const started = await startDetachedServer();
    server = started.url;
    serverPid = started.pid;
  }

  const created = await fetch(`${server}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({
      title: flags.named.get("title") ?? filePath,
      content,
      hostless: true,
    }),
  });
  if (!created.ok) fail(`Could not create the room (${created.status}).`);
  const body = (await created.json()) as { roomId: string; agentToken: string };

  const session: Session = {
    server,
    roomId: body.roomId,
    agentToken: body.agentToken,
    lastRound: 0,
    ...(serverPid === undefined ? {} : { serverPid }),
  };
  await saveSession(flags, session);

  console.log(`Review room is open. Share this link: ${server}/${body.roomId}`);
  console.log("Waiting for the first round...");
  return waitAndPrint(flags, session);
}

async function reply(flags: Flags): Promise<never> {
  const message = flags.positional.join(" ").trim();
  if (!message) fail('Usage: peanut reply "<what you did>" [--meta m]');
  const session = await loadSession(flags);
  const meta = flags.named.get("meta");
  const response = await api(session, "POST", `/api/rooms/${session.roomId}/agent/reply`, {
    message,
    ...(meta ? { meta } : {}),
    ...(session.lastRound > 0 ? { round: session.lastRound } : {}),
  });
  if (!response.ok) fail(`The reply was refused (${response.status}).`);
  console.log("Reply sent. Waiting for the next round...");
  return waitAndPrint(flags, session);
}

async function serve(flags: Flags): Promise<void> {
  const { startServer } = await import("../../server/src/http.ts");
  const port = Number(flags.named.get("port") ?? 0) || 0;
  const server = startServer({ port });
  const stateFile = flags.named.get("state");
  if (stateFile) {
    await Bun.write(stateFile, JSON.stringify({ url: server.url, pid: process.pid }));
  }
  console.log(`peanut server on ${server.url}`);
  // Serve until killed.
  await new Promise(() => {});
}

const flags = parseArgs(process.argv.slice(2));
const command = flags.positional.shift();

try {
  if (command === "share") await share(flags);
  else if (command === "reply") await reply(flags);
  else if (command === "serve") await serve(flags);
  else fail("Usage: peanut <share|reply|serve> ...");
} catch (error) {
  // A transport failure must not look like a review verdict. Exit 1
  // is reserved for a review that ended without approve.
  fail(`peanut hit an error: ${error instanceof Error ? error.message : String(error)}`);
}
