// Cloudflared quick tunnel. The process prints its public url on
// stderr. The stderr goes to a temp file, not a pipe: a pipe to this
// short-lived CLI would fill up or raise SIGPIPE after the CLI exits,
// and that stalls or kills the tunnel mid-review. We poll the file
// until the url appears or the deadline passes. A missing binary or
// a failed start returns null, and the review keeps working on the
// local link.

import { unlink } from "node:fs/promises";

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function findTunnelUrl(text: string): string | null {
  return text.match(TUNNEL_URL)?.[0] ?? null;
}

export interface Tunnel {
  url: string;
  pid: number;
}

export async function startTunnel(origin: string, timeoutMs = 20_000): Promise<Tunnel | null> {
  // Bun.which reads the startup environment unless PATH is passed;
  // the live value keeps this honest under tests that stub the PATH.
  const binary = Bun.which("cloudflared", { PATH: process.env.PATH ?? "" });
  if (!binary) return null;
  const logPath = `${process.env.TMPDIR ?? "/tmp"}/peanut-tunnel-${process.pid}-${Math.random().toString(36).slice(2)}.log`;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(
      [binary, "tunnel", "--url", origin, "--no-autoupdate"],
      { stdin: "ignore", stdout: "ignore", stderr: Bun.file(logPath) },
    );
  } catch {
    return null;
  }
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = await Bun.file(logPath).text().catch(() => "");
    const url = findTunnelUrl(log);
    if (url) {
      await unlink(logPath).catch(() => {});
      return { url, pid: child.pid };
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(200);
  }
  child.kill();
  await unlink(logPath).catch(() => {});
  return null;
}

// Best effort: put the link on the clipboard when a known tool exists.
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const command of [["wl-copy"], ["xclip", "-selection", "clipboard"], ["pbcopy"]]) {
    if (!Bun.which(command[0]!)) continue;
    try {
      const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      child.stdin.write(text);
      await child.stdin.end();
      if ((await child.exited) === 0) return true;
    } catch {
      // Try the next tool.
    }
  }
  return false;
}
