import { closeSync, openSync, watch as watchFileChanges } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DESIGN_REFERENCE, formatDesignReference } from "./design.ts";
import { formatEnded, formatRound, isApproved, type WireEnded, type WireRound } from "./format.ts";
import { formatPlaybookList, formatUnknownPlaybook, getPlaybook } from "./playbooks.ts";
import { writeLifecycleLog } from "./server-log.ts";
import { copyToClipboard, startTunnel } from "./tunnel.ts";

// The peanut CLI. Each invocation blocks until the next round or the
// final verdict, prints it, and exits. The room lives in a session
// file, so a later invocation continues the same review.
//
//   peanut share <file> [--watch] [--no-hint] [--title t] [--server url] [--port n] [--session path]
//   peanut reply <message> [--meta m] [--session path]
//   peanut push [--session path]
//   peanut wait [--session path]
//   peanut serve [--state path] [--port n]
//   peanut design [--json]
//   peanut playbook [id]
//
// Exit codes: 0 for a delivered round or an approve, 1 for a review
// that ended without approve, 2 for a usage or file error.

const POLL_TIMEOUT_MS = 25_000;
const DOCUMENT_WORD_BUDGET = 700;

interface Session {
  server: string;
  roomId: string;
  agentToken: string;
  lastRound: number;
  filePath?: string;
  // Set only when this CLI started the server, so only then is the
  // server stopped at the end of the review.
  serverPid?: number;
  serverLog?: string;
  tunnelPid?: number;
}

interface Flags {
  positional: string[];
  named: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(["json", "no-hint", "tunnel", "watch"]);

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

function serverLogPath(flags: Flags): string {
  const path = resolve(sessionPath(flags));
  const extension = extname(path);
  return join(dirname(path), `${basename(path, extension)}.log`);
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
  try {
    return await fetch(`${session.server}${path}`, {
      method,
      headers: { authorization: `Bearer ${session.agentToken}` },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const log = session.serverLog ? ` Server log: ${session.serverLog}.` : "";
    throw new Error(`Could not reach ${session.server}: ${detail}.${log}`);
  }
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
async function startDetachedServer(
  logPath: string,
  port?: string,
): Promise<{ url: string; pid: number }> {
  const stateFile = `${process.env.TMPDIR ?? "/tmp"}/peanut-server-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  const serveArgs = ["serve", "--state", stateFile, "--log", logPath];
  if (port) serveArgs.push("--port", port);
  const command = IS_COMPILED
    ? [process.execPath, ...serveArgs]
    : [process.execPath, new URL("./main.ts", import.meta.url).pathname, ...serveArgs];
  const logFd = openSync(logPath, "w", 0o600);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command, {
      detached: true,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
  } finally {
    closeSync(logFd);
  }
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
  fail(`Could not start the peanut server. Server log: ${logPath}.`);
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
        process.kill(session.serverPid, process.platform === "win32" ? "SIGTERM" : "SIGUSR2");
      } catch {
        // The process was already gone; nothing to stop.
      }
    }
    if (session.tunnelPid) {
      try {
        process.kill(session.tunnelPid);
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
        const log = session.serverLog ? ` Server log: ${session.serverLog}.` : "";
        fail(`Lost the connection to ${session.server}. Run peanut wait to keep waiting.${log}`);
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

function markdownBenefitsFromHtml(content: string): boolean {
  const hasPipeTable =
    /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m.test(
      content,
    );
  const hasImage = /!\[[^\r\n]*?\](?:\([^\r\n)]+\)|\[[^\r\n]+\])/.test(content);
  const hasDiagramFence =
    /^(?: {0,3})(?:`{3,}|~{3,})[ \t]*(?:diagram|mermaid|plantuml|graphviz|dot)\b[^\r\n]*$/im.test(
      content,
    );
  return hasPipeTable || hasImage || hasDiagramFence;
}

function countVisibleWords(content: string, contentType: "html" | "markdown"): number {
  const visibleText =
    contentType === "html"
      ? content
          .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
          .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
          .replace(/<[^>]*>/g, " ")
          .replace(/&(?:#\d+|#x[\da-f]+|[a-z][\w-]*);/gi, " ")
      : content;
  return visibleText.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

async function share(flags: Flags): Promise<never> {
  const filePath = flags.positional[0];
  if (!filePath) {
    fail(
      "Usage: peanut share <file> [--watch] [--no-hint] [--title t] [--server url] [--port n]",
    );
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) fail(`No such file: ${filePath}`);
  const content = await file.text();
  const contentType = /\.html?$/i.test(filePath) ? "html" : "markdown";
  if (!flags.named.has("no-hint")) {
    if (contentType === "markdown" && markdownBenefitsFromHtml(content)) {
      console.error(
        'Hint: Tables, images, and diagrams render better in an HTML artifact. Try "peanut design" or "peanut playbook". Sharing the Markdown file anyway.',
      );
    }
    const wordCount = countVisibleWords(content, contentType);
    if (wordCount > DOCUMENT_WORD_BUDGET) {
      console.error(
        `Note: This document has ${wordCount} visible words; the default budget is ${DOCUMENT_WORD_BUDGET}. Sharing it anyway.`,
      );
    }
  }

  let server = flags.named.get("server") ?? "";
  let serverPid: number | undefined;
  let serverLog: string | undefined;
  if (server) {
    if (!(await serverAlive(server))) fail(`No peanut server answers at ${server}.`);
  } else {
    serverLog = serverLogPath(flags);
    const started = await startDetachedServer(serverLog, flags.named.get("port"));
    server = started.url;
    serverPid = started.pid;
  }

  let created: Response;
  try {
    created = await fetch(`${server}/api/rooms`, {
      method: "POST",
      body: JSON.stringify({
        title: flags.named.get("title") ?? filePath,
        content,
        contentType,
        documentDirectory: dirname(resolve(filePath)),
        hostless: true,
      }),
    });
  } catch {
    const log = serverLog ? ` Server log: ${serverLog}.` : "";
    fail(`Could not reach the peanut server at ${server}.${log}`);
  }
  if (!created.ok) {
    const log = serverLog ? ` Server log: ${serverLog}.` : "";
    fail(`Could not create the room (${created.status}).${log}`);
  }
  const body = (await created.json()) as { roomId: string; agentToken: string };

  const session: Session = {
    server,
    roomId: body.roomId,
    agentToken: body.agentToken,
    lastRound: 0,
    filePath: resolve(filePath),
    ...(serverPid === undefined ? {} : { serverPid }),
    ...(serverLog === undefined ? {} : { serverLog }),
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
  const logPath = flags.named.get("log");
  if (!logPath) {
    const server = startServer({ port });
    console.log(`peanut server on ${server.url}`);
    await new Promise(() => {});
    return;
  }

  let ending = false;
  let server: ReturnType<typeof startServer> | undefined;
  const log = (message: string) => {
    try {
      writeLifecycleLog(logPath, message);
    } catch {
      // A missing log directory must not keep a stopped server alive.
    }
  };
  const end = (reason: string, code: number) => {
    if (ending) return;
    ending = true;
    log(`server ended reason=${reason}`);
    try {
      server?.stop();
    } finally {
      process.exit(code);
    }
  };
  const stack = (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  if (process.platform === "win32") {
    process.once("SIGTERM", () => end("normal stop", 0));
  } else {
    process.once("SIGUSR2", () => end("normal stop", 0));
    process.once("SIGTERM", () => end("signal signal=SIGTERM", 143));
    process.once("SIGHUP", () => end("signal signal=SIGHUP", 129));
  }
  process.once("SIGINT", () => end("signal signal=SIGINT", 130));
  process.once("uncaughtException", (error) => {
    log(`uncaught exception stack=${stack(error)}`);
    end("uncaught error", 1);
  });
  process.once("unhandledRejection", (error) => {
    log(`unhandled rejection stack=${stack(error)}`);
    end("uncaught error", 1);
  });

  log(`server started pid=${process.pid}`);
  try {
    server = startServer({ port, onViewerAccepted: () => log("viewer accepted") });
  } catch (error) {
    log(`uncaught exception stack=${stack(error)}`);
    end("uncaught error", 1);
    return;
  }
  const stateFile = flags.named.get("state");
  if (stateFile) {
    await Bun.write(stateFile, JSON.stringify({ url: server.url, pid: process.pid }));
  }
  log(`server listening url=${server.url}`);
  await new Promise(() => {});
}

function design(flags: Flags): void {
  const output = flags.named.has("json")
    ? JSON.stringify(DESIGN_REFERENCE, null, 2)
    : formatDesignReference();
  console.log(output);
}

function playbook(flags: Flags): void {
  const id = flags.positional[0];
  if (!id) {
    console.log(formatPlaybookList());
    return;
  }
  const guidance = getPlaybook(id);
  if (!guidance) fail(formatUnknownPlaybook(id));
  console.log(guidance);
}

const flags = parseArgs(process.argv.slice(2));
const command = flags.positional.shift();

try {
  if (command === "share") await share(flags);
  else if (command === "reply") await reply(flags);
  else if (command === "push") await push(flags);
  else if (command === "wait") await wait(flags);
  else if (command === "serve") await serve(flags);
  else if (command === "design") design(flags);
  else if (command === "playbook") playbook(flags);
  else fail("Usage: peanut <share|reply|push|wait|serve|design|playbook> ...");
} catch (error) {
  // A transport failure must not look like a review verdict. Exit 1
  // is reserved for a review that ended without approve.
  fail(`peanut hit an error: ${error instanceof Error ? error.message : String(error)}`);
}
