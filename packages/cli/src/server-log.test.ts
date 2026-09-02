import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_LOG_MAX_BYTES, writeLifecycleLog } from "./server-log.ts";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("server lifecycle log", () => {
  test("caps the file and keeps complete timestamped lines", async () => {
    dir = await mkdtemp(join(tmpdir(), "peanut-server-log-"));
    const path = join(dir, "session.log");
    for (let index = 0; index < 200; index += 1) {
      writeLifecycleLog(path, `viewer accepted sequence=${index} ${"x".repeat(4096)}`);
    }

    expect((await stat(path)).size).toBeLessThanOrEqual(SERVER_LOG_MAX_BYTES);
    const log = await Bun.file(path).text();
    expect(log).toContain("log truncated");
    expect(log).toContain("viewer accepted sequence=199");
    for (const entry of log.trim().split("\n")) {
      expect(entry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }
  });
});
