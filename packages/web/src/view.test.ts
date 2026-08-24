import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { startServer, type PeanutServer } from "../../server/src/http.ts";
import { boot, resetView } from "./view.ts";

// The view runs against the browser DOM and talks to the server with
// relative URLs and a session cookie. happy-dom stands in for the DOM;
// a fetch wrapper adds the base URL and the cookie.

let server: PeanutServer;
let win: Window;
let doc: Document;
let cookie = "";
const realFetch = globalThis.fetch;

const INSTALLED_GLOBALS = [
  "window",
  "document",
  "location",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "MouseEvent",
  "KeyboardEvent",
] as const;

function setGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.location = win.location;
  g.Node = win.Node;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.Text = win.Text;
  g.MouseEvent = win.MouseEvent;
  g.KeyboardEvent = win.KeyboardEvent;
  g.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input);
    const url = raw.startsWith("http") ? raw : server.url.replace(/\/$/, "") + raw;
    return realFetch(url, { ...init, headers: { ...(init?.headers as object), cookie } });
  }) as typeof fetch;
}

async function createRoom(content: string): Promise<{ roomId: string; agentToken: string }> {
  const created = await realFetch(`${server.url}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ title: "Chat test", content, hostName: "Nethum" }),
  });
  cookie = (created.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const body = await created.json();
  return { roomId: body.roomId, agentToken: body.agentToken };
}

async function openRoom(content: string): Promise<{ roomId: string; agentToken: string }> {
  const room = await createRoom(content);
  win = new Window({ url: `${server.url}/${room.roomId}` });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="app"></div>';
  setGlobals();
  await boot();
  await Bun.sleep(50);
  return room;
}

// happy-dom event classes are not the lib.dom ones; the cast keeps
// tsc out of the way.
function click(target: Element): void {
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

function pressEnter(target: Element): void {
  target.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
  );
}

beforeEach(() => {
  server = startServer();
});

afterEach(() => {
  resetView();
  server.stop();
  const g = globalThis as Record<string, unknown>;
  g.fetch = realFetch;
  for (const name of INSTALLED_GLOBALS) delete g[name];
});

describe("chat sidebar", () => {
  test("a typed message queues as a chat bubble and flushes with the round", async () => {
    const { roomId } = await openRoom("# Plan\n\nfirst paragraph");
    const input = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    input.value = "Also cover timeouts.";
    pressEnter(input);
    await Bun.sleep(150);

    const queued = doc.querySelector(".bubble.user.queued");
    expect(queued?.textContent).toContain("Also cover timeouts.");

    await realFetch(`${server.url}/api/rooms/${roomId}/instructions`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        words: "Tighten this block.",
        anchor: { type: "stamp", selector: "p:nth-of-type(1)", guard: "first paragraph" },
      }),
    });
    (doc.querySelector(".send-button") as HTMLButtonElement).click();
    await Bun.sleep(150);
    expect(doc.querySelector(".bubble.queued")).toBeNull();
    const sent = doc.querySelector(".bubble.user");
    expect(sent?.textContent).toContain("Also cover timeouts.");
    expect(sent?.classList.contains("mine")).toBe(true);
    const hints = [...doc.querySelectorAll(".bubble.user .hint")].map((h) => h.textContent);
    expect(hints).toContain('on "first paragraph"');
    expect(doc.querySelector(".bubble.working")).not.toBeNull();

    const state = await realFetch(`${server.url}/api/rooms/${roomId}/state`, { headers: { cookie } });
    const view = await state.json();
    expect(view.rounds[0].instructions[0].words).toBe("Also cover timeouts.");
  });

  test("the remove control deletes a queued message and the bubble goes away", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const input = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    input.value = "Drop this one.";
    pressEnter(input);
    await Bun.sleep(150);
    expect(doc.querySelector(".bubble.queued")).not.toBeNull();

    click(doc.querySelector(".bubble .unpin")!);
    await Bun.sleep(150);
    expect(doc.querySelector(".bubble.queued")).toBeNull();
  });

  test("an agent reply renders as an agent bubble with its meta line", async () => {
    const { roomId, agentToken } = await openRoom("# Plan\n\nfirst paragraph");
    const input = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    input.value = "Do the thing.";
    pressEnter(input);
    await Bun.sleep(150);
    (doc.querySelector(".send-button") as HTMLButtonElement).click();
    await Bun.sleep(150);

    await realFetch(`${server.url}/api/rooms/${roomId}/agent/reply`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ message: "Done.", meta: "tests green" }),
    });
    await Bun.sleep(2300);
    const agent = doc.querySelector(".bubble.agent:not(.working)");
    expect(agent?.textContent).toContain("Done.");
    expect(agent?.textContent).toContain("tests green");
    expect(doc.querySelector(".bubble.working")).toBeNull();
  }, 10_000);

  test("participants sit behind the users icon in a dropdown panel", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    expect(doc.querySelector(".people-icon svg")).not.toBeNull();
    const rows = [...doc.querySelectorAll(".person-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Nethum");
    expect(rows[0]?.textContent).toContain("you");
    expect(rows[0]?.textContent).toContain("host");
  });

  test("a stamp composer closes when a click lands outside it", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const para = doc.querySelector("#plan p")!;
    click(para);
    expect(doc.querySelector(".composer")).not.toBeNull();
    click(doc.querySelector(".sidebar")!);
    expect(doc.querySelector(".composer")).toBeNull();
  });
});
