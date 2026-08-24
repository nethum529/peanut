import {
  isOverlayToChromeMessage,
  type ChromeToOverlayMessage,
  type OverlayInstruction,
  type OverlayParticipant,
  type OverlayToChromeMessage,
} from "./protocol.ts";

type ParticipantView = OverlayParticipant;
type InstructionView = OverlayInstruction;

interface RoundView {
  number: number;
  instructions: {
    words: string;
    anchor: InstructionView["anchor"];
    author: { id: string; name: string; color: string };
  }[];
  flushedBy: string;
  flushedAt: number;
  nextStep: string;
  verdict?: "approve" | "request_changes";
  reply?: { message: string; meta?: string; repliedAt: number };
}

interface RoomStateView {
  id: string;
  title: string;
  content: string;
  contentType: "markdown" | "html";
  status: string;
  endedBy?: string;
  verdict?: string;
  you: ParticipantView;
  participants: ParticipantView[];
  instructions: InstructionView[];
  rounds: RoundView[];
}

const POLL_MS = 2000;
const CURSOR_SEND_MS = 40;
const CURSOR_STALE_MS = 3000;
const CURSOR_FADE_MS = 180;
const TOAST_VISIBLE_MS = 3000;
const TOAST_EXIT_MS = 400;

interface CursorMessage {
  type: "cursor";
  participantId: string;
  x: number;
  y: number;
}

interface CursorLeaveMessage {
  type: "cursor-leave";
  participantId: string;
}

interface RemoteCursor {
  x: number;
  y: number;
  staleTimer: ReturnType<typeof setTimeout>;
  removeTimer: ReturnType<typeof setTimeout> | null;
}

// The Lucide users icon, verbatim (lucide.dev, ISC license). The
// toolbar shows it in place of participant chips.
const USERS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
  '<circle cx="9" cy="7" r="4"/>' +
  '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
  '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

// The Lucide sun icon, verbatim (lucide.dev, ISC license).
const SUN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="4"/>' +
  '<path d="M12 2v2"/><path d="M12 20v2"/>' +
  '<path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>' +
  '<path d="M2 12h2"/><path d="M20 12h2"/>' +
  '<path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';

// The Lucide moon icon, verbatim (lucide.dev, ISC license).
const MOON_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>';

type Theme = "dark" | "light";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function initializeTheme(): void {
  const saved = window.localStorage.getItem("theme");
  document.documentElement.dataset.theme = saved === "light" ? "light" : "dark";
}

function updateThemeToggle(button: HTMLButtonElement): void {
  const dark = currentTheme() === "dark";
  button.dataset.theme = dark ? "dark" : "light";
  const label = dark ? "Use light theme" : "Use dark theme";
  button.setAttribute("aria-label", label);
  for (const svg of button.querySelectorAll("svg")) {
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
  }
}

function renderThemeToggle(): HTMLButtonElement {
  const button = el(
    "button",
    "theme-toggle icon-tooltip icon-tooltip-below icon-tooltip-end",
  );
  button.type = "button";
  button.innerHTML =
    `<span class="theme-icon theme-icon-sun">${SUN_ICON}</span>` +
    `<span class="theme-icon theme-icon-moon">${MOON_ICON}</span>`;
  updateThemeToggle(button);
  button.onclick = () => {
    const transitionGuard = document.createElement("style");
    transitionGuard.dataset.themeTransitionGuard = "";
    transitionGuard.textContent = "*,*::before,*::after{transition:none !important}";
    document.head.append(transitionGuard);

    const theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("theme", theme);
    updateThemeToggle(button);
    postToOverlay({ type: "theme", theme });

    void document.body.offsetHeight;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => transitionGuard.remove());
    });
  };
  return button;
}

function setAuthorColor(node: HTMLElement, color: string, className: string): void {
  node.classList.add(className);
  node.style.setProperty("--author-color", color);
}

let lastRendered = "";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let relaySocket: WebSocket | null = null;
let relayRoomId: string | null = null;
let relayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let cursorSendTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCursor: { x: number; y: number } | null = null;
let lastCursorSentAt = 0;
let currentState: RoomStateView | null = null;
const remoteCursors = new Map<string, RemoteCursor>();
let planFrame: HTMLIFrameElement | null = null;
let overlayReady = false;
let protocolWindow: Window | null = null;
let toastRegion: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastRemoveTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSnapshots = new Map<string, (html: string) => void>();
let connectionLost = false;

function roomIdFromPath(): string {
  return location.pathname.replace(/^\//, "").split("/")[0] ?? "";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ensureToastRegion(): HTMLElement {
  if (toastRegion?.isConnected) return toastRegion;
  toastRegion = el("div", "toast-region");
  toastRegion.setAttribute("role", "status");
  toastRegion.setAttribute("aria-live", "polite");
  toastRegion.setAttribute("aria-atomic", "true");
  document.body.append(toastRegion);
  return toastRegion;
}

function showToast(message: string): void {
  const region = ensureToastRegion();
  if (toastTimer !== null) clearTimeout(toastTimer);
  if (toastRemoveTimer !== null) clearTimeout(toastRemoveTimer);
  toastTimer = null;
  toastRemoveTimer = null;

  region.classList.remove("is-visible");
  region.replaceChildren(el("div", "chrome-toast", message));
  void region.offsetHeight;
  window.requestAnimationFrame(() => region.classList.add("is-visible"));

  toastTimer = setTimeout(() => {
    region.classList.remove("is-visible");
    toastTimer = null;
    toastRemoveTimer = setTimeout(() => {
      region.replaceChildren();
      toastRemoveTimer = null;
    }, TOAST_EXIT_MS);
  }, TOAST_VISIBLE_MS);
}

function showMessage(title: string, detail: string): void {
  const root = document.getElementById("app")!;
  root.replaceChildren();
  const box = el("div", "notice");
  box.append(el("h1", undefined, title), el("p", undefined, detail));
  root.append(box);
}

function ensureRoomBanner(): HTMLElement {
  const root = document.getElementById("app")!;
  const existing = root.querySelector<HTMLElement>(".room-banner");
  if (existing) return existing;
  const banner = el("div", "room-banner");
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.setAttribute("aria-atomic", "true");
  root.append(banner);
  return banner;
}

function syncRoomBanner(): void {
  const root = document.getElementById("app");
  if (!root) return;
  const kind = currentState?.status === "ended" ? "ended" : connectionLost ? "offline" : null;
  const banner = ensureRoomBanner();
  if (!kind) {
    banner.className = "room-banner";
    banner.textContent = "";
    return;
  }

  banner.className = `room-banner ${kind}`;
  banner.textContent =
    kind === "ended" ? "This review has ended" : "Connection lost. Trying again...";
  const toolbar = root.querySelector(".toolbar");
  if (toolbar && banner.previousElementSibling !== toolbar) toolbar.after(banner);
}

function setConnectionLost(lost: boolean): void {
  connectionLost = lost;
  syncRoomBanner();
}

function markRoomEnded(): void {
  connectionLost = false;
  if (!currentState) {
    syncRoomBanner();
    return;
  }
  const endedState = { ...currentState, status: "ended" };
  lastRendered = JSON.stringify(endedState);
  render(endedState);
  disconnectRelay();
}

function showJoinDialog(roomId: string): void {
  const root = document.getElementById("app")!;
  root.replaceChildren();
  const box = el("div", "join");
  box.append(el("h1", undefined, "Join the review"));
  const form = el("form");
  const input = el("input");
  input.placeholder = "Your name";
  input.maxLength = 40;
  const button = el("button", undefined, "Join");
  const error = el("p", "error");
  form.append(input, button, error);
  box.append(form);
  root.append(box);
  input.focus();

  form.onsubmit = async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    const response = await fetch(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (response.ok) {
      start(roomId, (await response.json()) as RoomStateView);
    } else if (response.status === 404) {
      showMessage("Room not found", "This link does not point to a live room.");
    } else {
      const body = await response.json().catch(() => ({}));
      error.textContent = body.message ?? "Could not join.";
    }
  };
}

function postToOverlay(message: ChromeToOverlayMessage): void {
  planFrame?.contentWindow?.postMessage(message, "*");
}

function postOverlayState(): void {
  if (!currentState) return;
  postToOverlay({
    type: "state",
    instructions: currentState.instructions,
    participants: currentState.participants,
    ended: currentState.status === "ended",
  });
}

function postRemoteCursors(): void {
  postToOverlay({
    type: "cursors",
    cursors: [...remoteCursors].map(([participantId, cursor]) => ({
      participantId,
      x: cursor.x,
      y: cursor.y,
      stale: cursor.removeTimer !== null,
    })),
  });
}

function removeRemoteCursor(participantId: string): void {
  const cursor = remoteCursors.get(participantId);
  if (!cursor) return;
  clearTimeout(cursor.staleTimer);
  if (cursor.removeTimer !== null) clearTimeout(cursor.removeTimer);
  remoteCursors.delete(participantId);
  postRemoteCursors();
}

function fadeRemoteCursor(participantId: string): void {
  const cursor = remoteCursors.get(participantId);
  if (!cursor || cursor.removeTimer !== null) return;
  cursor.removeTimer = setTimeout(() => removeRemoteCursor(participantId), CURSOR_FADE_MS);
  postRemoteCursors();
}

function clearRemoteCursors(): void {
  for (const participantId of [...remoteCursors.keys()]) removeRemoteCursor(participantId);
}

function receiveCursorFrame(data: unknown): void {
  if (typeof data !== "string" || !currentState) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    return;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return;
  const message = decoded as Partial<CursorMessage | CursorLeaveMessage>;
  if (
    typeof message.participantId !== "string" ||
    message.participantId === currentState.you.id
  ) {
    return;
  }
  const participant = currentState.participants.find(
    (person) => person.id === message.participantId,
  );
  if (!participant || participant.you) return;
  if (message.type === "cursor-leave") {
    fadeRemoteCursor(participant.id);
    return;
  }
  if (
    message.type !== "cursor" ||
    typeof message.x !== "number" ||
    typeof message.y !== "number" ||
    !Number.isFinite(message.x) ||
    !Number.isFinite(message.y) ||
    message.x < 0 ||
    message.x > 1 ||
    message.y < 0 ||
    message.y > 1
  ) {
    return;
  }

  const previous = remoteCursors.get(participant.id);
  if (previous) {
    clearTimeout(previous.staleTimer);
    if (previous.removeTimer !== null) clearTimeout(previous.removeTimer);
    previous.x = message.x;
    previous.y = message.y;
    previous.removeTimer = null;
    previous.staleTimer = setTimeout(() => fadeRemoteCursor(participant.id), CURSOR_STALE_MS);
    postRemoteCursors();
    return;
  }

  const cursor: RemoteCursor = {
    x: message.x,
    y: message.y,
    staleTimer: setTimeout(() => fadeRemoteCursor(participant.id), CURSOR_STALE_MS),
    removeTimer: null,
  };
  remoteCursors.set(participant.id, cursor);
  postRemoteCursors();
}

function disconnectRelay(): void {
  relayRoomId = null;
  if (relayReconnectTimer !== null) clearTimeout(relayReconnectTimer);
  relayReconnectTimer = null;
  const socket = relaySocket;
  relaySocket = null;
  socket?.close();
  clearRemoteCursors();
}

function connectRelay(roomId: string): void {
  if (relayRoomId === roomId && relaySocket) return;
  disconnectRelay();
  relayRoomId = roomId;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${roomId}/relay`);
  relaySocket = socket;
  socket.onmessage = (event) => receiveCursorFrame(event.data);
  socket.onclose = () => {
    if (relaySocket === socket) relaySocket = null;
    clearRemoteCursors();
    if (relayRoomId !== roomId) return;
    relayReconnectTimer = setTimeout(() => {
      relayReconnectTimer = null;
      if (relayRoomId === roomId && relaySocket === null) {
        relayRoomId = null;
        connectRelay(roomId);
      }
    }, 1000);
  };
}

function flushCursorPosition(): void {
  cursorSendTimer = null;
  const position = pendingCursor;
  pendingCursor = null;
  if (!position || !currentState || !relaySocket || relaySocket.readyState !== 1) return;
  const message: CursorMessage = {
    type: "cursor",
    participantId: currentState.you.id,
    x: position.x,
    y: position.y,
  };
  relaySocket.send(JSON.stringify(message));
  lastCursorSentAt = performance.now();
}

function sendCursorLeave(): void {
  if (cursorSendTimer !== null) clearTimeout(cursorSendTimer);
  cursorSendTimer = null;
  pendingCursor = null;
  if (!currentState || !relaySocket || relaySocket.readyState !== 1) return;
  const message: CursorLeaveMessage = {
    type: "cursor-leave",
    participantId: currentState.you.id,
  };
  relaySocket.send(JSON.stringify(message));
  lastCursorSentAt = performance.now();
}

function queueCursorPosition(x: number, y: number): void {
  pendingCursor = { x, y };
  if (cursorSendTimer !== null) return;
  const wait = Math.max(0, CURSOR_SEND_MS - (performance.now() - lastCursorSentAt));
  if (wait === 0) {
    flushCursorPosition();
  } else {
    cursorSendTimer = setTimeout(flushCursorPosition, wait);
  }
}

let snapshotSequence = 0;

function requestOverlaySnapshot(): Promise<string> {
  if (!overlayReady) return Promise.resolve("");
  const requestId = `snapshot-${++snapshotSequence}`;
  return new Promise((resolve) => {
    pendingSnapshots.set(requestId, resolve);
    postToOverlay({ type: "snapshot-request", requestId });
    setTimeout(() => {
      const pending = pendingSnapshots.get(requestId);
      if (!pending) return;
      pendingSnapshots.delete(requestId);
      pending("");
    }, 2000);
  });
}

async function actOnOverlayMessage(message: OverlayToChromeMessage): Promise<void> {
  if (!currentState) return;
  if (message.type === "ready") {
    overlayReady = true;
    postOverlayState();
    postRemoteCursors();
    postToOverlay({ type: "theme", theme: currentTheme() });
    return;
  }
  if (message.type === "pin") {
    const response = await postJson(`/api/rooms/${currentState.id}/instructions`, {
      words: message.words,
      anchor: message.anchor,
    });
    if (response?.ok) await refresh(currentState.id);
    return;
  }
  if (message.type === "unpin") {
    const response = await actionRequest(
      `/api/rooms/${currentState.id}/instructions/${message.instructionId}`,
      { method: "DELETE" },
    );
    if (response?.ok) await refresh(currentState.id);
    return;
  }
  if (message.type === "cursor") {
    queueCursorPosition(message.x, message.y);
    return;
  }
  if (message.type === "cursor-leave") {
    sendCursorLeave();
    return;
  }
  if (message.type === "snapshot") {
    const pending = pendingSnapshots.get(message.requestId);
    if (pending) {
      pendingSnapshots.delete(message.requestId);
      pending(message.html);
    }
  }
}

export function handleOverlayMessage(event: MessageEvent): boolean {
  if (
    !planFrame?.contentWindow ||
    event.source !== planFrame.contentWindow ||
    event.origin !== "null" ||
    !isOverlayToChromeMessage(event.data)
  ) {
    return false;
  }
  void actOnOverlayMessage(event.data);
  return true;
}

function installChromeProtocol(): void {
  if (protocolWindow === window) return;
  protocolWindow?.removeEventListener("message", handleOverlayMessage);
  protocolWindow = window;
  protocolWindow.addEventListener("message", handleOverlayMessage);
}

function ensurePlanFrame(roomId: string): HTMLIFrameElement {
  if (planFrame) return planFrame;
  // The injected overlay sends `ready` after it starts. The chrome never
  // reads contentDocument because the sandbox gives it an opaque origin.
  const frame = el("iframe", "plan-frame");
  frame.title = "Review document";
  frame.src = `/api/rooms/${roomId}/document`;
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  planFrame = frame;
  overlayReady = false;
  return frame;
}

function render(state: RoomStateView): void {
  currentState = state;
  const root = document.getElementById("app")!;
  // A reader scrolled up in the chat keeps their place across the
  // re-render; only a log already at the bottom follows new messages.
  const previousLog = document.querySelector(".chat");
  const chatScroll = {
    stick:
      !previousLog ||
      previousLog.scrollTop + previousLog.clientHeight >= previousLog.scrollHeight - 40,
    top: previousLog?.scrollTop ?? 0,
  };
  const bar = el("header", "toolbar");
  const brand = el("span", "wordmark", "Peanut");
  const title = el("span", "title", state.title || "Untitled review");
  const people = el("div", "people");
  const icon = iconButton("Participants", USERS_ICON, "people-icon icon-tooltip-below");
  const menu = el("div", "people-menu");
  const panel = el("div", "people-panel");
  for (const participant of state.participants) {
    const row = el("div", "person-row");
    const dot = el("span", "person-dot");
    setAuthorColor(dot, participant.color, "author-dot");
    row.append(dot, el("span", "person-name", participant.name));
    if (state.status !== "ended" && state.you.isHost && !participant.isHost) {
      row.append(renderSendPermissionSwitch(state, participant));
    }
    panel.append(row);
  }
  menu.append(panel);
  people.append(icon, menu);
  const toolbarActions = el("div", "toolbar-actions");
  toolbarActions.append(people, renderThemeToggle());
  bar.append(brand, title, toolbarActions);

  const sidebar = renderSidebar(state, chatScroll);
  const existingBody = root.querySelector<HTMLElement>(".body");
  const existingBar = root.querySelector<HTMLElement>(".toolbar");
  if (existingBody && planFrame?.isConnected) {
    existingBar?.replaceWith(bar);
    existingBody.querySelector(".sidebar")?.replaceWith(sidebar);
  } else {
    const body = el("div", "body");
    const left = el("div", "left");
    left.append(ensurePlanFrame(state.id));
    body.append(left, sidebar);
    root.replaceChildren(bar, ensureRoomBanner(), body);
  }
  postOverlayState();
  syncRoomBanner();
}

function verdictLabel(verdict: string): string {
  if (verdict === "approve") return "Approved";
  if (verdict === "request_changes") return "Changes requested";
  return "Ended";
}

async function responseIsRoomEnded(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = await response
    .clone()
    .json()
    .catch(() => ({}));
  return body.error === "room_ended";
}

async function actionRequest(path: string, init: RequestInit): Promise<Response | null> {
  try {
    const response = await fetch(path, init);
    if (await responseIsRoomEnded(response)) {
      markRoomEnded();
      return null;
    }
    return response;
  } catch {
    setConnectionLost(true);
    return null;
  }
}

async function postJson(path: string, payload: unknown): Promise<Response | null> {
  return actionRequest(path, { method: "POST", body: JSON.stringify(payload) });
}

// The Lucide pencil and trash-2 icons, verbatim (lucide.dev, ISC license).
const PENCIL_ICON = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="16"
  height="16"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  <path d="m15 5 4 4" />
</svg>`;

const TRASH_ICON = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="16"
  height="16"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M10 11v6" />
  <path d="M14 11v6" />
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  <path d="M3 6h18" />
  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
</svg>`;

function iconButton(label: string, icon: string, className: string): HTMLButtonElement {
  const button = el("button", `${className} icon-tooltip`);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  const svg = button.querySelector("svg")!;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return button;
}

function renderSendPermissionSwitch(
  state: RoomStateView,
  participant: ParticipantView,
): HTMLButtonElement {
  const button = el("button", "permission-switch");
  const thumb = el("span", "permission-switch-thumb");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", `Allow ${participant.name} to send`);
  button.dataset.participantId = participant.id;
  setPermissionSwitchChecked(button, participant.canSend);
  thumb.setAttribute("aria-hidden", "true");
  button.append(thumb);

  button.onclick = async () => {
    if (button.getAttribute("aria-busy") === "true") return;
    const previous = button.getAttribute("aria-checked") === "true";
    const canSend = !previous;
    button.setAttribute("aria-busy", "true");
    setPermissionSwitchChecked(button, canSend);
    button.focus();
    try {
      const response = await postJson(`/api/rooms/${state.id}/grants`, {
        participantId: participant.id,
        canSend,
      });
      if (!response?.ok) {
        setPermissionSwitchChecked(button, previous);
        return;
      }
      participant.canSend = canSend;
      lastRendered = JSON.stringify(state);
      showToast(
        canSend
          ? `${participant.name} can now send to the agent.`
          : `${participant.name} now needs approval to send.`,
      );
    } catch {
      setPermissionSwitchChecked(button, previous);
    } finally {
      button.removeAttribute("aria-busy");
      if (button.isConnected) button.focus();
    }
  };
  button.onkeydown = (event) => {
    if (event.key !== " ") return;
    event.preventDefault();
    button.click();
  };
  return button;
}

function setPermissionSwitchChecked(button: HTMLButtonElement, checked: boolean): void {
  button.setAttribute("aria-checked", String(checked));
  button.classList.toggle("is-checked", checked);
}

function userBubble(
  words: string,
  author: { name: string; color: string },
  mine: boolean,
): HTMLElement {
  const bubble = el("div", "bubble user", undefined);
  if (!mine) {
    const who = el("span", "who", author.name);
    setAuthorColor(who, author.color, "author-text");
    bubble.append(who);
  }
  bubble.append(el("span", "words", words));
  if (!mine) setAuthorColor(bubble, author.color, "author-border");
  if (mine) bubble.classList.add("mine");
  return bubble;
}

function renderConversation(state: RoomStateView): HTMLElement {
  const box = el("section", "chat-box");
  box.append(el("h2", undefined, "Conversation"));
  const log = el("div", "chat");
  const ended = state.status === "ended";

  const latest = state.rounds[state.rounds.length - 1];
  for (const round of state.rounds) {
    for (const instruction of round.instructions) {
      const mine = instruction.author.id === state.you.id;
      log.append(userBubble(instruction.words, instruction.author, mine));
    }
    if (round.verdict) log.append(el("span", "chip", verdictLabel(round.verdict)));
    if (round.reply) {
      const bubble = el("div", "bubble agent");
      bubble.append(el("span", "words", round.reply.message));
      if (round.reply.meta) bubble.append(el("span", "hint", round.reply.meta));
      log.append(bubble);
    } else if (!ended && round === latest) {
      // Only the newest round can still be in flight; an older round
      // without a reply was simply never answered.
      log.append(el("div", "bubble agent working", "Working..."));
    }
  }

  for (const instruction of state.instructions) {
    const bubble = userBubble(instruction.words, instruction.author, instruction.mine);
    bubble.classList.add("queued");
    if ((instruction.mine || state.you.isHost || state.you.canSend) && !ended) {
      const footer = el("div", "bubble-footer");
      const actions = el("div", "bubble-actions");
      const edit = iconButton("Edit", PENCIL_ICON, "bubble-action");
      const remove = iconButton("Delete", TRASH_ICON, "bubble-action");
      edit.onclick = () => {
        const shownWords = bubble.querySelector(".words");
        if (!shownWords) return;
        const editor = el("div", "inline-editor");
        const input = el("textarea", "inline-edit");
        const error = el("span", "inline-edit-error");
        error.id = `inline-edit-error-${instruction.id}`;
        error.setAttribute("role", "status");
        input.value = instruction.words;
        input.maxLength = 2000;
        input.setAttribute("aria-label", "Edit queued message");
        input.setAttribute("aria-describedby", error.id);
        editor.append(input, error);
        shownWords.replaceWith(editor);
        bubble.classList.add("editing");
        input.focus();
        input.select();

        input.oninput = () => {
          input.removeAttribute("aria-invalid");
          error.textContent = "";
        };

        input.onkeydown = async (key) => {
          if (key.key === "Escape") {
            key.preventDefault();
            editor.replaceWith(shownWords);
            bubble.classList.remove("editing");
            edit.focus();
            return;
          }
          if (key.key !== "Enter" || key.shiftKey) return;
          key.preventDefault();
          const words = input.value.trim();
          if (!words) {
            input.setAttribute("aria-invalid", "true");
            error.textContent = "Message cannot be empty.";
            return;
          }
          const response = await actionRequest(
            `/api/rooms/${state.id}/instructions/${instruction.id}`,
            {
              method: "PATCH",
              body: JSON.stringify({ words }),
            },
          );
          if (!response) return;
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            input.setAttribute("aria-invalid", "true");
            error.textContent = body.message ?? "Could not save changes.";
            return;
          }
          shownWords.textContent = words;
          editor.replaceWith(shownWords);
          bubble.classList.remove("editing");
          refresh(state.id);
        };
      };
      remove.onclick = async () => {
        const response = await actionRequest(
          `/api/rooms/${state.id}/instructions/${instruction.id}`,
          { method: "DELETE" },
        );
        if (response?.ok) refresh(state.id);
      };
      actions.append(edit, remove);
      footer.append(actions);
      bubble.append(footer);
    }
    log.append(bubble);
  }

  if (log.childElementCount === 0) {
    log.append(el("p", "empty", "No messages yet. Stamp a block or type below."));
  }
  box.append(log);
  return box;
}

function renderSidebar(
  state: RoomStateView,
  chatScroll: { stick: boolean; top: number },
): HTMLElement {
  const side = el("aside", "sidebar");
  const ended = state.status === "ended";

  if (ended) {
    const row = el("div", "verdict-row");
    row.append(el("strong", undefined, verdictLabel(state.verdict ?? "end")));
    if (state.endedBy) row.append(el("span", undefined, `ended by ${state.endedBy}`));
    side.append(row);
  }

  const conversation = renderConversation(state);
  side.append(conversation);
  queueMicrotask(() => {
    const log = conversation.querySelector(".chat");
    if (log) log.scrollTop = chatScroll.stick ? log.scrollHeight : chatScroll.top;
  });

  if (!ended) {
    const controls = el("div", "sidebar-controls");
    const composer = el("div", "message-composer");
    const input = el("textarea");
    input.placeholder = "Message the agent";
    input.maxLength = 500;
    const queueMessage = async (): Promise<void> => {
      const words = input.value.trim();
      if (!words) return;
      const response = await postJson(`/api/rooms/${state.id}/instructions`, {
        words,
        anchor: { type: "chat" },
      });
      if (response?.ok) {
        input.value = "";
        refresh(state.id);
      }
    };
    input.onkeydown = (key) => {
      if (key.key === "Enter" && !key.shiftKey) {
        key.preventDefault();
        queueMessage();
      }
    };
    const queueButton = el("button", "queue-button", "Queue");
    queueButton.onclick = queueMessage;
    composer.append(input, queueButton);
    controls.append(composer);
    if (state.you.isHost || state.you.canSend) controls.append(renderSendControls(state));
    side.append(controls);
  }

  return side;
}

function renderSendControls(state: RoomStateView): HTMLElement {
  const box = el("div", "send");
  const buttons = el("div", "sidebar-button-stack");
  const send = el("button", "send-button", "Send to agent");
  const note = el("p", "note");
  send.onclick = async () => {
    const domSnapshot = await requestOverlaySnapshot();
    if (!domSnapshot) {
      note.textContent = "The document overlay is not ready yet.";
      return;
    }
    const response = await postJson(`/api/rooms/${state.id}/flush`, {
      domSnapshot,
      nextStep: "",
    });
    if (!response) return;
    if (response.ok) {
      refresh(state.id);
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (body.error === "round_pending") {
      note.textContent = "The agent has not picked up the last round yet.";
    } else if (body.error === "empty_flush") {
      note.textContent = "Queue a message first.";
    } else {
      note.textContent = body.message ?? "Could not send.";
    }
  };
  buttons.append(send);
  if (state.you.isHost) {
    // Ending is irreversible, so the first click only arms the button.
    const end = el("button", "end-button", "End session");
    let armed = false;
    end.onclick = async () => {
      if (!armed) {
        armed = true;
        end.textContent = "Really end?";
        return;
      }
      const response = await postJson(`/api/rooms/${state.id}/end`, {});
      if (response?.ok) refresh(state.id);
    };
    buttons.append(end);
  }
  box.append(buttons, note);
  return box;
}

async function refresh(roomId: string): Promise<void> {
  let state: RoomStateView;
  try {
    const response = await fetch(`/api/rooms/${roomId}/state`);
    if (!response.ok) {
      setConnectionLost(true);
      return;
    }
    state = (await response.json()) as RoomStateView;
  } catch {
    setConnectionLost(true);
    return;
  }
  setConnectionLost(false);
  const serialized = JSON.stringify(state);
  if (serialized === lastRendered) return;
  // Never re-render over an inline sidebar edit; the textarea in
  // progress wins. The frame overlay owns its own composer.
  if (document.querySelector(".inline-edit")) return;
  // Keep the participants menu and its focused switch stable. A later
  // poll applies the room state after the pointer and focus leave.
  const people = document.querySelector(".people");
  if (people && (people.matches(":hover") || people.contains(document.activeElement))) return;
  const guestPermissionChanged =
    currentState !== null &&
    !state.you.isHost &&
    currentState.you.id === state.you.id &&
    currentState.you.canSend !== state.you.canSend;
  lastRendered = serialized;
  render(state);
  if (guestPermissionChanged) {
    showToast(
      state.you.canSend
        ? "You can now send to the agent."
        : "You now need approval to send.",
    );
  }
  if (state.status === "ended") disconnectRelay();
  else connectRelay(roomId);
}

function start(roomId: string, state: RoomStateView): void {
  installChromeProtocol();
  ensureToastRegion();
  connectionLost = false;
  lastRendered = JSON.stringify(state);
  render(state);
  if (state.status === "ended") disconnectRelay();
  else connectRelay(roomId);
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(roomId), POLL_MS);
}

// Tests boot repeatedly against fresh windows; this clears the module
// state a previous boot left behind.
export function resetView(): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  if (cursorSendTimer !== null) clearTimeout(cursorSendTimer);
  if (toastTimer !== null) clearTimeout(toastTimer);
  if (toastRemoveTimer !== null) clearTimeout(toastRemoveTimer);
  pollTimer = null;
  cursorSendTimer = null;
  toastTimer = null;
  toastRemoveTimer = null;
  pendingCursor = null;
  lastCursorSentAt = 0;
  currentState = null;
  connectionLost = false;
  overlayReady = false;
  planFrame = null;
  for (const pending of pendingSnapshots.values()) pending("");
  pendingSnapshots.clear();
  if (protocolWindow) protocolWindow.removeEventListener("message", handleOverlayMessage);
  protocolWindow = null;
  toastRegion?.remove();
  toastRegion = null;
  disconnectRelay();
  lastRendered = "";
}

export async function boot(): Promise<void> {
  initializeTheme();
  const roomId = roomIdFromPath();
  if (!roomId) {
    showMessage("No room", "Open a room link to start.");
    return;
  }
  ensureRoomBanner();
  try {
    const response = await fetch(`/api/rooms/${roomId}/state`);
    if (response.ok) {
      start(roomId, (await response.json()) as RoomStateView);
    } else if (response.status === 403) {
      showJoinDialog(roomId);
    } else {
      showMessage("Room not found", "This link does not point to a live room.");
    }
  } catch {
    setConnectionLost(true);
  }
}
