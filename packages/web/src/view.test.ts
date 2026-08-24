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
  await openExistingRoom(room.roomId, cookie);
  return room;
}

async function openExistingRoom(roomId: string, sessionCookie: string): Promise<void> {
  cookie = sessionCookie;
  win = new Window({ url: `${server.url}/${roomId}` });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="app"></div>';
  setGlobals();
  await boot();
  await Bun.sleep(50);
}

// happy-dom event classes are not the lib.dom ones; the cast keeps
// tsc out of the way.
function click(target: Element): void {
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

function pressEnter(target: Element, shiftKey = false): boolean {
  const event = new win.KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey,
    bubbles: true,
    cancelable: true,
  }) as unknown as Event;
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function pressEscape(target: Element): void {
  target.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
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

  test("queued icon buttons use the shared tooltip class and accessible labels", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const input = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    input.value = "Review this one.";
    pressEnter(input);
    await Bun.sleep(150);

    const edit = doc.querySelector('.bubble-action[aria-label="Edit"]');
    const remove = doc.querySelector('.bubble-action[aria-label="Delete"]');
    expect(edit?.getAttribute("title")).toBeNull();
    expect(remove?.getAttribute("title")).toBeNull();
    for (const button of [edit, remove]) {
      expect(button?.classList.contains("icon-tooltip")).toBe(true);
      const svg = button?.querySelector("svg");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("icon tooltip styles are shared instead of tied to bubble actions", async () => {
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    expect(html).toContain(".icon-tooltip::before, .icon-tooltip::after");
    expect(html).not.toContain(".bubble-action::before");
  });

  test("Enter saves an inline edit and updates the queued bubble", async () => {
    const { roomId } = await openRoom("# Plan\n\nfirst paragraph");
    const composer = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    composer.value = "Old words.";
    pressEnter(composer);
    await Bun.sleep(150);

    click(doc.querySelector('.bubble-action[aria-label="Edit"]')!);
    const input = doc.querySelector(".inline-edit") as HTMLTextAreaElement;
    expect(input.value).toBe("Old words.");
    input.value = "New words.";
    pressEnter(input);
    await Bun.sleep(150);

    expect(doc.querySelector(".inline-edit")).toBeNull();
    expect(doc.querySelector(".bubble.queued .words")?.textContent).toBe("New words.");
    const response = await realFetch(`${server.url}/api/rooms/${roomId}/state`, {
      headers: { cookie },
    });
    const state = await response.json();
    expect(state.instructions[0].words).toBe("New words.");
  });

  test("a multiline edit keeps line breaks and Shift+Enter does not save", async () => {
    const { roomId } = await openRoom("# Plan\n\nfirst paragraph");
    const composer = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    composer.value = "First line.\nSecond line.";
    pressEnter(composer);
    await Bun.sleep(150);

    click(doc.querySelector('.bubble-action[aria-label="Edit"]')!);
    const input = doc.querySelector(".inline-edit") as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.value).toBe("First line.\nSecond line.");
    expect(pressEnter(input, true)).toBe(false);
    expect(doc.querySelector(".inline-edit")).toBe(input);
    input.value = "First line.\nUpdated second line.\nThird line.";
    pressEnter(input);
    await Bun.sleep(150);

    const response = await realFetch(`${server.url}/api/rooms/${roomId}/state`, {
      headers: { cookie },
    });
    const state = await response.json();
    expect(state.instructions[0].words).toBe(
      "First line.\nUpdated second line.\nThird line.",
    );
    expect(doc.querySelector(".bubble.queued .words")?.textContent).toBe(
      "First line.\nUpdated second line.\nThird line.",
    );
  });

  test("Escape cancels an inline edit and polling does not replace it", async () => {
    const { roomId } = await openRoom("# Plan\n\nfirst paragraph");
    const composer = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    composer.value = "Keep these words.";
    pressEnter(composer);
    await Bun.sleep(150);

    click(doc.querySelector('.bubble-action[aria-label="Edit"]')!);
    const input = doc.querySelector(".inline-edit") as HTMLTextAreaElement;
    input.value = "Unsaved words.";
    const stateResponse = await realFetch(`${server.url}/api/rooms/${roomId}/state`, {
      headers: { cookie },
    });
    const state = await stateResponse.json();
    await realFetch(`${server.url}/api/rooms/${roomId}/instructions/${state.instructions[0].id}`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ words: "Words from another refresh." }),
    });
    await Bun.sleep(2300);

    expect(doc.querySelector(".inline-edit")).toBe(input);
    expect(input.value).toBe("Unsaved words.");
    pressEscape(input);
    expect(doc.querySelector(".inline-edit")).toBeNull();
    expect(doc.querySelector(".bubble.queued .words")?.textContent).toBe("Keep these words.");
  }, 10_000);

  test("a failed inline save shows an error and keeps the textarea open", async () => {
    const { roomId } = await openRoom("# Plan\n\nfirst paragraph");
    const composer = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    composer.value = "Edit after end.";
    pressEnter(composer);
    await Bun.sleep(150);

    click(doc.querySelector('.bubble-action[aria-label="Edit"]')!);
    const input = doc.querySelector(".inline-edit") as HTMLTextAreaElement;
    await realFetch(`${server.url}/api/rooms/${roomId}/end`, {
      method: "POST",
      headers: { cookie },
    });
    input.value = "This save must fail.";
    pressEnter(input);
    await Bun.sleep(100);

    expect(doc.querySelector(".inline-edit")).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(doc.querySelector(".inline-edit-error")?.textContent).not.toBe("");
  });

  test("the delete button removes a queued message and the bubble goes away", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const input = doc.querySelector(".message-composer textarea") as HTMLTextAreaElement;
    input.value = "Drop this one.";
    pressEnter(input);
    await Bun.sleep(150);
    expect(doc.querySelector(".bubble.queued")).not.toBeNull();

    click(doc.querySelector('.bubble-action[aria-label="Delete"]')!);
    await Bun.sleep(150);
    expect(doc.querySelector(".bubble.queued")).toBeNull();
  });

  test("edit and delete follow author, host, and granted guest rights", async () => {
    const { roomId } = await createRoom("# Plan\n\nfirst paragraph");
    const hostCookie = cookie;
    await realFetch(`${server.url}/api/rooms/${roomId}/instructions`, {
      method: "POST",
      headers: { cookie: hostCookie },
      body: JSON.stringify({ words: "Host note.", anchor: { type: "chat" } }),
    });
    const joined = await realFetch(`${server.url}/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ name: "Sam" }),
    });
    const guestCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const guestState = await joined.json();

    await openExistingRoom(roomId, guestCookie);
    expect(doc.querySelector(".bubble-actions")).toBeNull();

    await realFetch(`${server.url}/api/rooms/${roomId}/grants`, {
      method: "POST",
      headers: { cookie: hostCookie },
      body: JSON.stringify({ participantId: guestState.you.id, canSend: true }),
    });
    resetView();
    await openExistingRoom(roomId, guestCookie);
    expect(doc.querySelectorAll(".bubble-action")).toHaveLength(2);

    await realFetch(`${server.url}/api/rooms/${roomId}/instructions`, {
      method: "POST",
      headers: { cookie: guestCookie },
      body: JSON.stringify({ words: "Guest note.", anchor: { type: "chat" } }),
    });
    resetView();
    await openExistingRoom(roomId, hostCookie);
    expect(doc.querySelectorAll(".bubble-action")).toHaveLength(4);
  });

  test("a granted guest can remove an instruction from a stamped card", async () => {
    const { roomId } = await createRoom("# Plan\n\nfirst paragraph");
    const hostCookie = cookie;
    await realFetch(`${server.url}/api/rooms/${roomId}/instructions`, {
      method: "POST",
      headers: { cookie: hostCookie },
      body: JSON.stringify({
        words: "Host stamp.",
        anchor: {
          type: "stamp",
          selector: "p:nth-of-type(1)",
          guard: "first paragraph",
        },
      }),
    });
    const joined = await realFetch(`${server.url}/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ name: "Sam" }),
    });
    const guestCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const guestState = await joined.json();
    await realFetch(`${server.url}/api/rooms/${roomId}/grants`, {
      method: "POST",
      headers: { cookie: hostCookie },
      body: JSON.stringify({ participantId: guestState.you.id, canSend: true }),
    });

    await openExistingRoom(roomId, guestCookie);
    click(doc.querySelector(".stamp-toggle")!);
    click(doc.querySelector("#plan p")!);
    expect(doc.querySelector(".card .remove")).not.toBeNull();
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
    const icon = doc.querySelector(".people-icon");
    expect(icon?.tagName).toBe("BUTTON");
    expect(icon?.classList.contains("icon-tooltip")).toBe(true);
    expect(icon?.classList.contains("icon-tooltip-below")).toBe(true);
    expect(icon?.getAttribute("aria-label")).toBe("Participants");
    expect(icon?.getAttribute("title")).toBeNull();
    expect(icon?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
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
