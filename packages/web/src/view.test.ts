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
let overlayMessages: unknown[] = [];
const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
const BunWebSocket = RealWebSocket as unknown as new (
  url: string | URL,
  options: { headers: Record<string, string> },
) => WebSocket;

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
  // Browser sockets include the room cookie automatically. Bun's test
  // socket needs the same cookie supplied as an explicit header.
  g.WebSocket = function TestWebSocket(url: string | URL): WebSocket {
    return new BunWebSocket(url, { headers: { cookie } });
  };
  g.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input);
    const url = raw.startsWith("http") ? raw : server.url.replace(/\/$/, "") + raw;
    return realFetch(url, { ...init, headers: { ...(init?.headers as object), cookie } });
  }) as typeof fetch;
}

async function createRoom(
  content: string,
  contentType: "markdown" | "html" = "markdown",
): Promise<{
  roomId: string;
  agentToken: string;
  participant: { id: string; name: string; color: string };
}> {
  const created = await realFetch(`${server.url}/api/rooms`, {
    method: "POST",
    body: JSON.stringify({ title: "Chat test", content, contentType, hostName: "Nethum" }),
  });
  cookie = (created.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const body = await created.json();
  return { roomId: body.roomId, agentToken: body.agentToken, participant: body.state.you };
}

async function openRoom(
  content: string,
  savedTheme?: "dark" | "light",
): Promise<{
  roomId: string;
  agentToken: string;
  participant: { id: string; name: string; color: string };
}> {
  const room = await createRoom(content);
  await openExistingRoom(room.roomId, cookie, savedTheme);
  return room;
}

async function openExistingRoom(
  roomId: string,
  sessionCookie: string,
  savedTheme?: "dark" | "light",
): Promise<void> {
  cookie = sessionCookie;
  win = new Window({ url: `${server.url}/${roomId}` });
  if (savedTheme) win.localStorage.setItem("theme", savedTheme);
  doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="app"></div>';
  setGlobals();
  await boot();
  await Bun.sleep(50);
  connectFakeOverlay();
}

function frame(): HTMLIFrameElement {
  return doc.querySelector("iframe.plan-frame") as HTMLIFrameElement;
}

function postFromOverlay(data: unknown, origin = "null", source: unknown = null): void {
  const event = new win.MessageEvent("message", {
    data,
    origin,
    source: (source ?? frame().contentWindow) as any,
  });
  win.dispatchEvent(event);
}

function connectFakeOverlay(snapshot = '<main><h1>Plan</h1><p>first paragraph</p></main>'): void {
  overlayMessages = [];
  const contentWindow = frame().contentWindow!;
  contentWindow.postMessage = ((message: unknown) => {
    overlayMessages.push(message);
    const request = message as { type?: string; requestId?: string };
    if (request.type === "snapshot-request" && request.requestId) {
      queueMicrotask(() =>
        postFromOverlay({ type: "snapshot", requestId: request.requestId!, html: snapshot }),
      );
    }
  }) as typeof contentWindow.postMessage;
  postFromOverlay({ type: "ready" });
}

async function joinRoom(
  roomId: string,
  name: string,
): Promise<{ cookie: string; participant: { id: string; name: string; color: string } }> {
  const response = await realFetch(`${server.url}/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const state = await response.json();
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    participant: state.you,
  };
}

function connectRelay(roomId: string, peerCookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new BunWebSocket(
      `${server.url.replace("http", "ws")}/api/rooms/${roomId}/relay`,
      { headers: { cookie: peerCookie } },
    );
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("connection failed"));
  });
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

function pressSpace(target: Element): boolean {
  const event = new win.KeyboardEvent("keydown", {
    key: " ",
    bubbles: true,
    cancelable: true,
  }) as unknown as Event;
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  server = startServer();
});

afterEach(() => {
  resetView();
  server.stop();
  const g = globalThis as Record<string, unknown>;
  g.fetch = realFetch;
  g.WebSocket = RealWebSocket;
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
    expect(doc.querySelector(".send select")).toBeNull();
    expect(doc.querySelector(".end-button")?.textContent).toBe("End session");

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
    expect(doc.querySelector(".bubble .hint")).toBeNull();
    expect(doc.querySelector(".bubble.working")).not.toBeNull();

    const state = await realFetch(`${server.url}/api/rooms/${roomId}/state`, { headers: { cookie } });
    const view = await state.json();
    expect(view.rounds[0].instructions[0].words).toBe("Also cover timeouts.");
    expect(view.rounds[0].instructions[1].anchor.guard).toBe("first paragraph");
    expect(view.rounds[0].verdict).toBeUndefined();
  });

  test("send controls omit the verdict select and its styles", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const send = doc.querySelector(".send-button");
    const end = doc.querySelector(".end-button");
    const stack = doc.querySelector(".sidebar-button-stack");
    const controls = doc.querySelector(".sidebar-controls");
    expect(send?.textContent).toBe("Send to agent");
    expect(doc.querySelector(".send h2")).toBeNull();
    expect(doc.querySelector(".send select")).toBeNull();
    expect(end?.textContent).toBe("End session");
    expect(controls?.children[0]?.classList.contains("message-composer")).toBe(true);
    expect(controls?.children[1]?.classList.contains("send")).toBe(true);
    expect(stack?.children[0] ?? null).toBe(send);
    expect(stack?.children[1] ?? null).toBe(end);
    expect(stack?.nextElementSibling?.classList.contains("note")).toBe(true);

    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    expect(html).not.toContain(".send select");
  });

  test("sidebar composer and action controls share dimensions and alignment", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    const insetRule =
      html.match(/\.message-composer,\s*\.sidebar-button-stack \{([^}]*)\}/)?.[1] ?? "";
    const composerRule = html.match(/\.message-composer \{([^}]*)\}/)?.[1] ?? "";
    const controlsRule = html.match(/\.sidebar-controls \{([^}]*)\}/)?.[1] ?? "";
    const composerControlsRule =
      html.match(/\.message-composer textarea,\s*\.queue-button \{([^}]*)\}/)?.[1] ?? "";
    const actionStackRule =
      [...html.matchAll(/\.sidebar-button-stack \{([^}]*)\}/g)]
        .map((match) => match[1] ?? "")
        .find((rule) => rule.includes("display: grid")) ?? "";
    const actionButtonsRule =
      html.match(/\.send-button,\s*\.end-button \{([^}]*)\}/)?.[1] ?? "";
    const endRule = html.match(/\.end-button \{([^}]*)\}/)?.[1] ?? "";

    expect(insetRule).toContain("padding-inline: 2px");
    expect(controlsRule).toContain("gap: 8px");
    expect(composerRule).toContain("align-items: stretch");
    expect(composerControlsRule).toContain("height: 40px");
    expect(composerControlsRule).toContain("min-height: 40px");
    expect(composerControlsRule).toContain("border-radius: 10px");
    expect(actionStackRule).toContain("gap: 8px");
    expect(actionButtonsRule).toContain("width: 100%");
    expect(actionButtonsRule).toContain("height: 40px");
    expect(actionButtonsRule).toContain("min-height: 40px");
    expect(actionButtonsRule).toContain("border-radius: 10px");
    expect(endRule).not.toContain("margin-top");
  });

  test("host sidebar omits guest permissions and keeps End session", async () => {
    await openRoom("# Plan\n\nfirst paragraph");

    expect(doc.querySelector(".permissions")).toBeNull();
    expect(doc.querySelector(".grant-row")).toBeNull();
    expect(doc.body.textContent).not.toContain("Guest send permission");
    expect(doc.body.textContent).not.toContain("No guests yet.");
    expect(doc.querySelector(".end-button")?.textContent).toBe("End session");

    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    expect(html).not.toContain(".grant-row");
  });

  test("queued icon buttons stay crisp in the bottom-right footer", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    postFromOverlay({
      type: "pin",
      words: "Review this one.",
      anchor: { type: "stamp", selector: "p", guard: "first paragraph" },
    });
    await Bun.sleep(150);

    const edit = doc.querySelector('.bubble-action[aria-label="Edit"]');
    const remove = doc.querySelector('.bubble-action[aria-label="Delete"]');
    const footer = edit?.closest(".bubble-footer");
    expect(edit?.closest(".bubble")?.getAttribute("tabindex")).toBeNull();
    expect(footer?.querySelector(".hint")).toBeNull();
    expect(footer?.querySelector(".bubble-actions")).not.toBeNull();
    expect(footer?.lastElementChild?.classList.contains("bubble-actions")).toBe(true);
    expect(edit?.getAttribute("title")).toBeNull();
    expect(remove?.getAttribute("title")).toBeNull();
    for (const button of [edit, remove]) {
      expect(button?.classList.contains("icon-tooltip")).toBe(true);
      const svg = button?.querySelector("svg");
      expect(svg?.getAttribute("width")).toBe("16");
      expect(svg?.getAttribute("height")).toBe("16");
      expect(svg?.getAttribute("stroke")).toBe("currentColor");
      expect(svg?.getAttribute("stroke-width")).toBe("2");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("opacity")).toBeNull();
      expect(svg?.getAttribute("filter")).toBeNull();
      expect(svg?.getAttribute("transform")).toBeNull();
    }
  });

  test("bubble actions are always visible, unboxed, and do not transform the icons", async () => {
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    const actionsRule = html.match(/\.bubble-actions \{([^}]*)\}/)?.[1] ?? "";
    const actionRule = html.match(/\.bubble-action \{([^}]*)\}/)?.[1] ?? "";
    const mineActionRule = html.match(/\.bubble\.user\.mine \.bubble-action \{([^}]*)\}/)?.[1] ?? "";
    const mineActionActiveRule =
      html.match(
        /\.bubble\.user\.mine \.bubble-action:hover,\s*\.bubble\.user\.mine \.bubble-action:focus-visible \{([^}]*)\}/,
      )?.[1] ?? "";
    const svgRule = html.match(/\.bubble-action svg \{([^}]*)\}/)?.[1] ?? "";
    const queuedRule = html.match(/\.bubble\.queued \{([^}]*)\}/)?.[1] ?? "";

    expect(html).toContain(".icon-tooltip::before, .icon-tooltip::after");
    expect(html).not.toContain(".bubble-action::before");
    expect(html).not.toContain(".bubble:focus-within .bubble-actions");
    expect(html).not.toContain(".bubble:hover .bubble-actions");
    expect(html).not.toContain("@media (hover: none)");
    expect(actionsRule).toContain("margin-inline-start: auto");
    expect(actionsRule).not.toContain("margin-left");
    expect(actionsRule).not.toContain("opacity");
    expect(actionsRule).not.toContain("pointer-events");
    expect(actionRule).toContain("border: 0");
    expect(actionRule).toContain("background: transparent");
    expect(actionRule).not.toContain("transform");
    expect(mineActionRule).toContain("color: var(--on-accent); opacity: 0.8");
    expect(mineActionActiveRule).toContain("opacity: 1");
    expect(svgRule).toContain("width: 16px");
    expect(svgRule).toContain("height: 16px");
    expect(svgRule).not.toContain("opacity");
    expect(svgRule).not.toContain("filter");
    expect(svgRule).not.toContain("transform");
    expect(queuedRule).not.toContain("opacity");
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

  test("an agent reply renders with its meta line", async () => {
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
    expect(agent?.querySelector(".hint")?.textContent).toBe("tests green");
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
    expect(rows[0]?.querySelector(".person-name")?.textContent).toBe("Nethum");
    expect(rows[0]?.querySelector(".person-tag")).toBeNull();
    expect(icon?.closest(".toolbar-actions")?.querySelector(".theme-toggle")).not.toBeNull();

    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    const peopleRule = html.match(/\.people \{([^}]*)\}/)?.[1] ?? "";
    const menuRule = html.match(/\.people-menu \{([^}]*)\}/)?.[1] ?? "";
    const delayedOpenRule =
      html.match(
        /\.people:hover \.people-menu,\s*\.people:focus-within \.people-menu \{([^}]*)\}/,
      )?.[1] ?? "";
    const immediateOpenRule =
      html.match(
        /\.people \.people-menu:hover,\s*\.people \.people-menu:focus-within \{([^}]*)\}/,
      )?.[1] ?? "";
    const tooltipWindowRule =
      html.match(
        /\.people:hover \.people-icon::before,\s*\.people:hover \.people-icon::after,\s*\.people:focus-within \.people-icon::before,\s*\.people:focus-within \.people-icon::after \{([^}]*)\}/,
      )?.[1] ?? "";
    const menuTooltipRule =
      html.match(
        /\.people:has\(\.people-menu:hover\) \.people-icon::before,\s*\.people:has\(\.people-menu:hover\) \.people-icon::after,\s*\.people:has\(\.people-menu:focus-within\) \.people-icon::before,\s*\.people:has\(\.people-menu:focus-within\) \.people-icon::after \{([^}]*)\}/,
      )?.[1] ?? "";
    expect(peopleRule).toContain("--people-menu-open-delay: 500ms");
    expect(menuRule).toContain("padding-top: 8px");
    expect(menuRule).toContain("transition: visibility 0s linear 300ms");
    expect(menuRule).not.toContain("transition: opacity");
    expect(delayedOpenRule).toContain(
      "transition: visibility 0s linear var(--people-menu-open-delay)",
    );
    expect(immediateOpenRule).toContain("transition: visibility 0s linear 0s");
    expect(html).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\.people:hover \.people-menu,[\s\S]*?transition: opacity 160ms ease var\(--people-menu-open-delay\), visibility 0s linear;/,
    );
    expect(tooltipWindowRule).toContain(
      "animation: hide-people-tooltip 1ms linear var(--people-menu-open-delay) forwards",
    );
    expect(tooltipWindowRule).not.toContain("visibility: hidden");
    expect(menuTooltipRule).toContain("opacity: 0");
    expect(menuTooltipRule).toContain("visibility: hidden");
  });

  test("a host grants and revokes guest send permission from the people menu", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const hostCookie = cookie;
    const guest = await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, hostCookie);

    const rows = [...doc.querySelectorAll(".person-row")];
    const hostRow = rows.find((row) => row.querySelector(".person-name")?.textContent === "Nethum");
    const guestRow = rows.find((row) => row.querySelector(".person-name")?.textContent === "Sam");
    expect(hostRow?.querySelector(".permission-switch")).toBeNull();
    let permission = guestRow?.querySelector(".permission-switch") as HTMLButtonElement;
    expect(permission?.getAttribute("role")).toBe("switch");
    expect(permission?.getAttribute("aria-label")).toBe("Allow Sam to send");
    expect(permission?.getAttribute("aria-checked")).toBe("false");
    expect(permission?.classList.contains("is-checked")).toBe(false);
    expect(permission?.dataset.participantId).toBe(guest.participant.id);
    expect(permission?.querySelector(".permission-switch-thumb")?.getAttribute("aria-hidden")).toBe(
      "true",
    );

    click(permission);
    expect(permission.getAttribute("aria-checked")).toBe("true");
    expect(permission.classList.contains("is-checked")).toBe(true);
    expect(permission.getAttribute("aria-busy")).toBe("true");
    expect(doc.activeElement).toBe(permission);
    await Bun.sleep(150);

    let response = await realFetch(`${server.url}/api/rooms/${room.roomId}/state`, {
      headers: { cookie: hostCookie },
    });
    let state = await response.json();
    expect(
      state.participants.find(
        (participant: { id: string }) => participant.id === guest.participant.id,
      )?.canSend,
    ).toBe(true);
    expect(doc.querySelector('.permission-switch[aria-label="Allow Sam to send"]')).toBe(
      permission,
    );
    expect(permission.getAttribute("aria-checked")).toBe("true");
    expect(permission.classList.contains("is-checked")).toBe(true);
    expect(permission.getAttribute("aria-busy")).toBeNull();
    expect(doc.activeElement).toBe(permission);

    expect(pressSpace(permission)).toBe(true);
    expect(permission.getAttribute("aria-checked")).toBe("false");
    expect(permission.classList.contains("is-checked")).toBe(false);
    expect(permission.getAttribute("aria-busy")).toBe("true");
    await Bun.sleep(150);
    response = await realFetch(`${server.url}/api/rooms/${room.roomId}/state`, {
      headers: { cookie: hostCookie },
    });
    state = await response.json();
    expect(
      state.participants.find(
        (participant: { id: string }) => participant.id === guest.participant.id,
      )?.canSend,
    ).toBe(false);
    expect(doc.querySelector('.permission-switch[aria-label="Allow Sam to send"]')).toBe(
      permission,
    );
    expect(permission.getAttribute("aria-busy")).toBeNull();
    expect(doc.activeElement).toBe(permission);

    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    const checkedRule = html.match(/\.permission-switch\.is-checked \{([^}]*)\}/)?.[1] ?? "";
    const busyRule =
      html.match(/\.permission-switch\[aria-busy="true"\] \{([^}]*)\}/)?.[1] ?? "";
    const thumbRule = html.match(/\.permission-switch-thumb \{([^}]*)\}/)?.[1] ?? "";
    expect(checkedRule).toContain("background: var(--accent-text)");
    expect(busyRule).toContain("opacity: 0.55");
    expect(busyRule).toContain("cursor: wait");
    expect(thumbRule).not.toContain("transition");
    expect(html).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\.permission-switch-thumb \{\s*transition: transform 150ms cubic-bezier\(0\.77, 0, 0\.175, 1\);/,
    );
  });

  test("a failed send permission change restores the switch", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const hostCookie = cookie;
    const guest = await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, hostCookie);
    const permission = doc.querySelector(".permission-switch") as HTMLButtonElement;

    cookie = guest.cookie;
    click(permission);
    expect(permission.getAttribute("aria-checked")).toBe("true");
    expect(permission.classList.contains("is-checked")).toBe(true);
    expect(permission.getAttribute("aria-busy")).toBe("true");
    await Bun.sleep(150);

    expect(permission.getAttribute("aria-checked")).toBe("false");
    expect(permission.classList.contains("is-checked")).toBe(false);
    expect(permission.getAttribute("aria-busy")).toBeNull();
    expect(doc.activeElement).toBe(permission);
    const response = await realFetch(`${server.url}/api/rooms/${room.roomId}/state`, {
      headers: { cookie: hostCookie },
    });
    const state = await response.json();
    expect(
      state.participants.find(
        (participant: { id: string }) => participant.id === guest.participant.id,
      )?.canSend,
    ).toBe(false);
  });

  test("polling preserves an open people menu and its focused switch", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const hostCookie = cookie;
    await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, hostCookie);
    const permission = doc.querySelector(".permission-switch") as HTMLButtonElement;
    permission.focus();

    await joinRoom(room.roomId, "Alex");
    await Bun.sleep(2100);

    expect(doc.activeElement).toBe(permission);
    expect(doc.querySelector(".permission-switch")).toBe(permission);
    expect(doc.querySelectorAll(".person-row")).toHaveLength(2);

    permission.blur();
    await Bun.sleep(2100);
    expect(doc.querySelectorAll(".person-row")).toHaveLength(3);
  }, 6000);

  test("a guest sees no send permission switches", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const guest = await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, guest.cookie);

    expect(doc.querySelectorAll(".person-row")).toHaveLength(2);
    expect(doc.querySelector(".permission-switch")).toBeNull();
  });

  test("the document frame fills its column and owns document scrolling", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    const bodyRule = html.match(/\.body \{([^}]*)\}/)?.[1] ?? "";
    const leftRule = html.match(/\.left \{([^}]*)\}/)?.[1] ?? "";
    const frameRule = html.match(/\.plan-frame \{([^}]*)\}/)?.[1] ?? "";
    const narrow = html.match(/@media \(max-width: 840px\) \{([\s\S]*?)\n      \}/)?.[1] ?? "";

    expect(bodyRule).toContain("grid-template-columns: minmax(0, 1fr) 320px");
    expect(bodyRule).toContain("height: calc(100vh - 53px)");
    expect(bodyRule).toContain("overflow: hidden");
    expect(leftRule).toContain("height: 100%");
    expect(leftRule).toContain("padding: 0");
    expect(leftRule).toContain("overflow: hidden");
    expect(frameRule).toContain("width: 100%");
    expect(frameRule).toContain("height: 100%");
    expect(frameRule).toContain("margin: 0");
    expect(frameRule).toContain("border: 0");
    expect(frameRule).toContain("border-radius: 0");
    expect(frameRule).toContain("box-shadow: none");
    expect(frame().parentElement?.classList.contains("left")).toBe(true);
    expect(doc.querySelector(".plan-shell")).toBeNull();
    expect(html).toContain("border-inline-start: 1px solid var(--line)");
    expect(html).not.toContain("border-left: 1px solid var(--line)");
    expect(narrow).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  test("HTML documents use the same edge-to-edge frame", async () => {
    const room = await createRoom("<!doctype html><html><body><main>Demo</main></body></html>", "html");
    await openExistingRoom(room.roomId, cookie);

    expect(frame().parentElement?.classList.contains("left")).toBe(true);
    expect(doc.querySelector(".plan-shell")).toBeNull();
  });

  test("theme starts dark and the sun toggle saves a light choice", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const toggle = doc.querySelector(".theme-toggle") as HTMLButtonElement;

    expect(doc.documentElement.dataset.theme).toBe("dark");
    expect(toggle.getAttribute("aria-label")).toBe("Use light theme");
    expect(toggle.classList.contains("icon-tooltip")).toBe(true);
    expect(toggle.classList.contains("icon-tooltip-below")).toBe(true);
    expect(toggle.classList.contains("icon-tooltip-end")).toBe(true);
    expect(toggle.dataset.theme).toBe("dark");
    expect(toggle.querySelectorAll("svg")).toHaveLength(2);
    expect(toggle.querySelector(".theme-icon-sun circle")?.getAttribute("r")).toBe("4");
    expect(toggle.querySelector(".theme-icon-sun svg")?.getAttribute("stroke")).toBe(
      "currentColor",
    );

    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    const endRule = html.match(/\.icon-tooltip-end::after \{([^}]*)\}/)?.[1] ?? "";
    expect(endRule).toContain("inset-inline-end: 0");
    expect(endRule).toContain("inset-inline-start: auto");
    expect(endRule).toContain("transform: translateY(2px)");
    expect(html).not.toContain(".icon-tooltip-end::before");
    expect(html).toContain(
      ".icon-tooltip-end:dir(rtl)::after { transform-origin: bottom left; }",
    );
    expect(html).toContain(
      ".icon-tooltip-below.icon-tooltip-end:dir(rtl)::after { transform-origin: top left; }",
    );

    click(toggle);

    expect(doc.documentElement.dataset.theme).toBe("light");
    expect(win.localStorage.getItem("theme")).toBe("light");
    expect(toggle.getAttribute("aria-label")).toBe("Use dark theme");
    expect(toggle.dataset.theme).toBe("light");
    expect(toggle.querySelector(".theme-icon-moon path")?.getAttribute("d")).toContain(
      "M20.985 12.486",
    );
    const transitionGuard = doc.head.querySelector(
      "style[data-theme-transition-guard]",
    ) as HTMLStyleElement;
    expect(transitionGuard.textContent).toBe(
      "*,*::before,*::after{transition:none !important}",
    );
    await new Promise<void>((resolve) => {
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
    });
    expect(doc.head.querySelector("style[data-theme-transition-guard]")).toBeNull();
  });

  test("a saved light choice wins when the room opens", async () => {
    await openRoom("# Plan\n\nfirst paragraph", "light");
    const toggle = doc.querySelector(".theme-toggle") as HTMLButtonElement;

    expect(doc.documentElement.dataset.theme).toBe("light");
    expect(toggle.getAttribute("aria-label")).toBe("Use dark theme");
    expect(toggle.dataset.theme).toBe("light");
    expect(toggle.querySelector(".theme-icon-moon path")?.getAttribute("d")).toContain(
      "M20.985 12.486",
    );
  });

  test("the page applies the saved theme before its styles", async () => {
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
    const themeBootstrap = html.indexOf("document.documentElement.dataset.theme");

    expect(themeBootstrap).toBeGreaterThan(-1);
    expect(themeBootstrap).toBeLessThan(html.indexOf("<style>"));
  });

  test("both themes use the sapphire palette", async () => {
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();

    expect(html.match(/--accent: #0d1b2a;/g)).toHaveLength(2);
    expect(html).toContain("--accent-text: color-mix(in srgb, var(--accent) 35%, white);");
    expect(html).toContain("--paper: #10141b;");
    expect(html).toContain("--surface: #171c25;");
    expect(html).toContain("--paper: #f3f5f8;");
  });

  test("uses one persistent sandboxed frame and rejects untrusted overlay messages", async () => {
    await openRoom("# Plan\n\nfirst paragraph");
    const original = frame();
    expect(original.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups");
    expect(original.src).toContain("/api/rooms/");
    expect(original.src).toEndWith("/document");

    postFromOverlay({ type: "pin", words: "bad", anchor: { type: "stamp", selector: "p" } }, "https://evil.test");
    postFromOverlay({ type: "pin", words: "bad", anchor: { type: "stamp", selector: "p" } }, "null", win);
    postFromOverlay({ type: "pin", words: "bad", anchor: { nope: true } });
    await Bun.sleep(100);
    expect(doc.querySelector(".bubble.queued")).toBeNull();

    postFromOverlay({
      type: "pin",
      words: "good",
      anchor: { type: "stamp", selector: "p", guard: "first paragraph" },
    });
    await Bun.sleep(150);
    expect(doc.querySelector(".bubble.queued")?.textContent).toContain("good");
    expect(frame()).toBe(original);
  });
});

describe("live cursors", () => {
  test("shows a peer at normalized plan coordinates with their state color and name", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const guest = await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, cookie);
    const peer = await connectRelay(room.roomId, guest.cookie);

    peer.send(
      JSON.stringify({
        type: "cursor",
        participantId: guest.participant.id,
        x: 0.25,
        y: 0.75,
        color: "#ff0000",
      }),
    );
    await Bun.sleep(50);

    const cursorMessage = overlayMessages
      .filter((message: any) => message.type === "cursors")
      .at(-1) as any;
    expect(cursorMessage.cursors).toEqual([
      { participantId: guest.participant.id, x: 0.25, y: 0.75, stale: false },
    ]);

    await Bun.sleep(3200);
    const faded = overlayMessages.filter((message: any) => message.type === "cursors").at(-1) as any;
    expect(faded.cursors).toEqual([]);
    peer.close();
  }, 5000);

  test("rejects invalid, unknown, and self-asserted cursor frames", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const guest = await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, cookie);
    const peer = await connectRelay(room.roomId, guest.cookie);

    for (const frame of [
      { type: "cursor", participantId: guest.participant.id, x: -0.1, y: 0.5 },
      { type: "cursor", participantId: "unknown", x: 0.5, y: 0.5 },
      { type: "cursor", participantId: room.participant.id, x: 0.5, y: 0.5 },
    ]) {
      peer.send(JSON.stringify(frame));
    }
    peer.send("null");
    await Bun.sleep(50);

    const cursorMessage = overlayMessages
      .filter((message: any) => message.type === "cursors")
      .at(-1) as any;
    expect(cursorMessage.cursors).toEqual([]);
    peer.close();
  });

  test("keeps a live cursor across a room state re-render", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const hostCookie = cookie;
    const guest = await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, hostCookie);
    const peer = await connectRelay(room.roomId, guest.cookie);
    peer.send(
      JSON.stringify({
        type: "cursor",
        participantId: guest.participant.id,
        x: 0.25,
        y: 0.75,
      }),
    );
    await Bun.sleep(50);
    const before = frame();
    expect((overlayMessages.filter((message: any) => message.type === "cursors").at(-1) as any).cursors)
      .toHaveLength(1);

    await joinRoom(room.roomId, "Alex");
    await Bun.sleep(2100);

    expect(doc.querySelectorAll(".person-row")).toHaveLength(3);
    const after = frame();
    expect(after).toBe(before);
    const stateMessage = overlayMessages
      .filter((message: any) => message.type === "state")
      .at(-1) as any;
    expect(stateMessage.participants.map((person: any) => person.name)).toEqual([
      "Nethum",
      "Sam",
      "Alex",
    ]);
    expect((overlayMessages.filter((message: any) => message.type === "cursors").at(-1) as any).cursors)
      .toHaveLength(1);
    peer.close();
  }, 4000);

  test("throttles pointer updates and sends the latest plan-relative position", async () => {
    const room = await createRoom("# Plan\n\nfirst paragraph");
    const guest = await joinRoom(room.roomId, "Sam");
    await openExistingRoom(room.roomId, cookie);
    const peer = await connectRelay(room.roomId, guest.cookie);
    const messages: Array<{
      type: string;
      participantId: string;
      x?: number;
      y?: number;
    }> = [];
    peer.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    for (const [x, y] of [
      [0.05, 0.05],
      [0.15, 0.15],
      [0.25, 0.25],
      [0.35, 0.35],
      [0.5, 0.5],
    ]) postFromOverlay({ type: "cursor", x, y });
    await Bun.sleep(100);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBeLessThanOrEqual(2);
    expect(messages.at(-1)).toEqual({
      type: "cursor",
      participantId: room.participant.id,
      x: 0.5,
      y: 0.5,
    });
    postFromOverlay({ type: "cursor-leave" });
    await Bun.sleep(50);
    expect(messages.at(-1)).toEqual({
      type: "cursor-leave",
      participantId: room.participant.id,
    });
    peer.close();
  });
});
