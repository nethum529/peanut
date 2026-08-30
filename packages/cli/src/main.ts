import { watch as watchFileChanges } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { formatEnded, formatRound, isApproved, type WireEnded, type WireRound } from "./format.ts";
import { copyToClipboard, startTunnel } from "./tunnel.ts";

// The peanut CLI. Each invocation blocks until the next round or the
// final verdict, prints it, and exits. The room lives in a session
// file, so a later invocation continues the same review.
//
//   peanut share <file> [--watch] [--title t] [--server url] [--session path]
//   peanut reply <message> [--meta m] [--session path]
//   peanut push [--session path]
//   peanut wait [--session path]
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
  filePath?: string;
  // Set only when this CLI started the server, so only then is the
  // server stopped at the end of the review.
  serverPid?: number;
  tunnelPid?: number;
}

interface Flags {
  positional: string[];
  named: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(["tunnel", "watch"]);

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        named.set(name, "true");
      } else {
        named.set(name, argv[index + 1] ?? "");
        index += 1;
      }
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

type ContentUpdateResult = "updated" | "unchanged" | "skipped";

async function updateContentFromFile(
  session: Session,
  refusal: "fail" | "warn" = "fail",
): Promise<ContentUpdateResult> {
  if (!session.filePath) {
    console.error(
      "Warning: This older session has no file path. The room document was not updated.",
    );
    return "skipped";
  }
  const file = Bun.file(session.filePath);
  if (!(await file.exists())) {
    console.error(
      `Warning: The shared file no longer exists: ${session.filePath}. ` +
        "The room document was not updated.",
    );
    return "skipped";
  }
  let content: string;
  try {
    content = await file.text();
  } catch {
    console.error(
      `Warning: The shared file could not be read: ${session.filePath}. ` +
        "The room document was not updated.",
    );
    return "skipped";
  }
  const response = await api(
    session,
    "PUT",
    `/api/rooms/${session.roomId}/agent/content`,
    { content },
  );
  if (!response.ok) {
    if (refusal === "fail") fail(`The content update was refused (${response.status}).`);
    console.error(
      `Warning: The content update was refused (${response.status}). ` +
        "The review will continue.",
    );
    return "skipped";
  }
  const result = (await response.json()) as { updated: boolean };
  return result.updated ? "updated" : "unchanged";
}

const WATCH_DEBOUNCE_MS = 300;

// Watch the directory instead of the file itself so editors that save by
// replacing the file keep producing events after the first save.
function startContentWatcher(session: Session): () => void {
  const filePath = session.filePath;
  if (!filePath) return () => {};

  const fileName = basename(filePath);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let updating = false;
  let updatePending = false;

  const scheduleUpdate = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void pushUpdate();
    }, WATCH_DEBOUNCE_MS);
  };

  const pushUpdate = async () => {
    if (updating) {
      updatePending = true;
      return;
    }
    updating = true;
    try {
      await updateContentFromFile(session, "warn");
    } catch (error) {
      console.error(
        `Warning: The shared file could not be pushed: ${
          error instanceof Error ? error.message : String(error)
        }. The review will continue.`,
      );
    } finally {
      updating = false;
      if (updatePending) {
        updatePending = false;
        scheduleUpdate();
      }
    }
  };

  const watcher = watchFileChanges(dirname(filePath), (_event, changedFile) => {
    if (changedFile === null || changedFile.toString() === fileName) scheduleUpdate();
  });
  watcher.on("error", (error) => {
    console.error(`Warning: The shared file watcher stopped: ${error.message}`);
  });

  return () => {
    if (debounce) clearTimeout(debounce);
    watcher.close();
  };
}

async function serverAlive(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/rooms/none/state`, { signal: AbortSignal.timeout(1500) });
    return response.status === 404 || response.status === 403;
  } catch {
    return false;
  }
}

// In the compiled binary the modules live in an internal bunfs tree,
// not on disk, so the server must start by re-executing the binary
// itself. In the dev tree bun runs this source file again. This
// check is Unix only; a Windows build uses a different virtual path.
const IS_COMPILED = Bun.main.includes("$bunfs");

// Starts a detached peanut server and reads its url from the state
// file it writes once it listens.
async function startDetachedServer(): Promise<{ url: string; pid: number }> {
  const stateFile = `${process.env.TMPDIR ?? "/tmp"}/peanut-server-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  const command = IS_COMPILED
    ? [process.execPath, "serve", "--state", stateFile]
    : [process.execPath, new URL("./main.ts", import.meta.url).pathname, "serve", "--state", stateFile];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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
    for (const pid of [session.serverPid, session.tunnelPid]) {
      if (!pid) continue;
      try {
        process.kill(pid);
      } catch {
        // The process was already gone; nothing to stop.
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

// A human round can take hours, so the wait must survive a dropped
// socket. Only this many failures in a row mean the server is gone.
const POLL_RETRY_LIMIT = 5;
const POLL_RETRY_PAUSE_MS = 1_000;

// Blocks until the next round or the end of the review, prints it,
// acknowledges a round, and exits.
async function waitAndPrint(flags: Flags, session: Session): Promise<never> {
  let failures = 0;
  while (true) {
    let response: Response;
    let result: { status: "waiting" } | WireRound | WireEnded;
    try {
      response = await api(
        session,
        "GET",
        `/api/rooms/${session.roomId}/agent/poll?timeoutMs=${POLL_TIMEOUT_MS}`,
      );
      // The body read stays inside the retried section: a drop
      // between headers and body is a transport failure too.
      result = response.ok ? await response.json() : { status: "waiting" };
    } catch {
      failures += 1;
      if (failures >= POLL_RETRY_LIMIT) {
        fail(`Lost the connection to ${session.server}. Run peanut wait to keep waiting.`);
      }
      await Bun.sleep(POLL_RETRY_PAUSE_MS);
      continue;
    }
    failures = 0;
    // A refusal is final today because the CLI talks to its local
    // server; a remote server behind a proxy would need transient
    // 502 and 503 answers in the retryable class.
    if (!response.ok) {
      fail(`The server refused the poll (${response.status}). The review may be gone.`);
    }
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
  if (!filePath) fail("Usage: peanut share <file> [--watch] [--title t] [--server url]");
  const file = Bun.file(filePath);
  if (!(await file.exists())) fail(`No such file: ${filePath}`);
  const content = await file.text();
  const contentType = /\.html?$/i.test(filePath) ? "html" : "markdown";

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
      contentType,
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
    filePath: resolve(filePath),
    ...(serverPid === undefined ? {} : { serverPid }),
  };
  await saveSession(flags, session);

  if (flags.named.has("watch")) {
    const stopWatching = startContentWatcher(session);
    process.once("exit", stopWatching);
  }

  // The local link prints at once; the public link follows when the
  // tunnel is up, so a slow tunnel never delays the room.
  console.log(`Review room is open. Local link: ${server}/${body.roomId}`);
  if (flags.named.has("tunnel")) {
    const tunnel = await startTunnel(new URL(server).origin);
    if (tunnel) {
      const publicLink = `${tunnel.url}/${body.roomId}`;
      const copied = await copyToClipboard(publicLink);
      console.log(`Public link: ${publicLink}${copied ? " (copied to clipboard)" : ""}`);
      console.log("The public link can take a minute to go live.");
      session.tunnelPid = tunnel.pid;
      await saveSession(flags, session);
    } else {
      console.log("The tunnel did not start (is cloudflared installed?). The local link still works.");
    }
  }
  console.log("Waiting for the first round...");
  return waitAndPrint(flags, session);
}

async function reply(flags: Flags): Promise<never> {
  const message = flags.positional.join(" ").trim();
  if (!message) fail('Usage: peanut reply "<what you did>" [--meta m]');
  const session = await loadSession(flags);
  await updateContentFromFile(session, "warn");
  const meta = flags.named.get("meta");
  const response = await api(session, "POST", `/api/rooms/${session.roomId}/agent/reply`, {
    message,
    ...(meta ? { meta } : {}),
    ...(session.lastRound > 0 ? { round: session.lastRound } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    if (body.error === "reply_too_long") {
      fail(`The reply was refused: ${body.message}. Send a shorter reply, under 100 words.`);
    }
    if (body.error === "reply_meta_too_long") {
      fail(`The reply was refused: ${body.message}. Send shorter meta, at most 500 characters.`);
    }
    fail(`The reply was refused (${response.status}).`);
  }
  console.log("Reply sent. Waiting for the next round...");
  return waitAndPrint(flags, session);
}

async function push(flags: Flags): Promise<void> {
  const session = await loadSession(flags);
  const result = await updateContentFromFile(session);
  if (result === "updated") console.log("Document pushed.");
  if (result === "unchanged") console.log("Document unchanged.");
}

// Resumes blocking on an open review without sending anything. This
// is the recovery path after a wait died on a connection error.
async function wait(flags: Flags): Promise<never> {
  const session = await loadSession(flags);
  console.log("Waiting for the next round...");
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
  else if (command === "push") await push(flags);
  else if (command === "wait") await wait(flags);
  else if (command === "serve") await serve(flags);
  else fail("Usage: peanut <share|reply|push|wait|serve> ...");
} catch (error) {
  // A transport failure must not look like a review verdict. Exit 1
  // is reserved for a review that ended without approve.
  fail(`peanut hit an error: ${error instanceof Error ? error.message : String(error)}`);
}
