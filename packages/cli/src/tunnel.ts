// Cloudflared quick tunnel. The process prints its public url on
// stderr; we watch that stream until the url appears or the deadline
// passes. A missing binary or a failed start returns null, and the
// review keeps working on the local link.

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function findTunnelUrl(text: string): string | null {
  return text.match(TUNNEL_URL)?.[0] ?? null;
}

export interface Tunnel {
  url: string;
  pid: number;
}

export async function startTunnel(port: number, timeoutMs = 20_000): Promise<Tunnel | null> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(
      ["cloudflared", "tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
  } catch {
    return null;
  }
  child.unref();

  const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => null),
      ]);
      if (next === null || next.done) break;
      seen += decoder.decode(next.value, { stream: true });
      const url = findTunnelUrl(seen);
      if (url) return { url, pid: child.pid };
    }
  } finally {
    reader.releaseLock();
  }
  child.kill();
  return null;
}

// Best effort: put the link on the clipboard when a known tool exists.
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const command of [["wl-copy"], ["xclip", "-selection", "clipboard"]]) {
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
