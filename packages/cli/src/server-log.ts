import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";

export const SERVER_LOG_MAX_BYTES = 256 * 1024;
const SERVER_LOG_RETAIN_BYTES = SERVER_LOG_MAX_BYTES / 2;
const SERVER_LOG_MAX_MESSAGE_CHARS = 8 * 1024;

function line(message: string, now: Date): Buffer {
  const safeMessage = message
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .slice(0, SERVER_LOG_MAX_MESSAGE_CHARS);
  return Buffer.from(`${now.toISOString()} ${safeMessage}\n`);
}

function trimFor(fd: number, incomingBytes: number, now: Date): void {
  const size = fstatSync(fd).size;
  if (size + incomingBytes <= SERVER_LOG_MAX_BYTES) return;

  const marker = line("log truncated", now);
  const retainedLength = Math.min(
    size,
    SERVER_LOG_RETAIN_BYTES,
    Math.max(0, SERVER_LOG_MAX_BYTES - incomingBytes - marker.byteLength),
  );
  const retained = Buffer.alloc(retainedLength);
  if (retainedLength > 0) readSync(fd, retained, 0, retainedLength, size - retainedLength);

  // The retained bytes can start in the middle of a line. Drop that
  // fragment so every remaining line still starts with a timestamp.
  const firstNewline = retained.indexOf(10);
  const completeLines = firstNewline === -1 ? Buffer.alloc(0) : retained.subarray(firstNewline + 1);

  ftruncateSync(fd, 0);
  writeSync(fd, marker);
  writeSync(fd, completeLines);
}

export function writeLifecycleLog(logPath: string, message: string, now = new Date()): void {
  const entry = line(message, now);
  const fd = openSync(logPath, "a+", 0o600);
  try {
    trimFor(fd, entry.byteLength, now);
    writeSync(fd, entry);
  } finally {
    closeSync(fd);
  }
}
