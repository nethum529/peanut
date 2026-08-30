import { describe, expect, test } from "bun:test";
import { PLAYBOOK_IDS } from "./playbooks.ts";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

async function runPlaybook(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, MAIN, "playbook", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("peanut playbook", () => {
  for (const id of PLAYBOOK_IDS) {
    test(`${id} prints guidance and exits 0`, async () => {
      const result = await runPlaybook([id]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      expect(result.stdout).toContain(`# ${id[0]!.toUpperCase()}${id.slice(1)} playbook`);
      expect(result.stderr).toBe("");
    });
  }

  test("no id lists every playbook with a description", async () => {
    const result = await runPlaybook([]);

    expect(result.exitCode).toBe(0);
    for (const id of PLAYBOOK_IDS) expect(result.stdout).toContain(`  ${id}: `);
    expect(result.stderr).toBe("");
  });

  test("an unknown id lists valid ids on stderr and exits 2", async () => {
    const result = await runPlaybook(["unknown"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    for (const id of PLAYBOOK_IDS) expect(result.stderr).toContain(id);
  });
});
