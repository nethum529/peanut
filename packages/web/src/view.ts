import {
  captureRange,
  restoreAnchor,
  restoreStamp,
  stampGuard,
  selectorFor,
  type RangeAnchor,
  type StampAnchor,
} from "./anchors.ts";
import { renderMarkdown } from "./markdown.ts";

interface ParticipantView {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  canSend: boolean;
  you: boolean;
}

interface InstructionView {
  id: string;
  words: string;
  anchor: { type: string } & Record<string, unknown>;
  author: { name: string; color: string; isHost: boolean };
  mine: boolean;
  pinnedAt: number;
}

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
  status: string;
  endedBy?: string;
  verdict?: string;
  you: ParticipantView;
  participants: ParticipantView[];
  instructions: InstructionView[];
  rounds: RoundView[];
}

const POLL_MS = 2000;

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
  button.innerHTML = dark ? SUN_ICON : MOON_ICON;
  const label = dark ? "Use light theme" : "Use dark theme";
  button.setAttribute("aria-label", label);
  button.querySelector("svg")?.setAttribute("aria-hidden", "true");
  button.querySelector("svg")?.setAttribute("focusable", "false");
}

function renderThemeToggle(): HTMLButtonElement {
  const button = el("button", "theme-toggle");
  button.type = "button";
  updateThemeToggle(button);
  button.onclick = () => {
    const theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("theme", theme);
    updateThemeToggle(button);
  };
  return button;
}

function setAuthorColor(node: HTMLElement, color: string, className: string): void {
  node.classList.add(className);
  node.style.setProperty("--author-color", color);
}

let lastRendered = "";
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Stamp mode lives outside render, so a state refresh keeps the
// current choice. It starts on: block stamping is the main gesture,
// and text selection pinning is one toggle away.
let stampMode = true;
// The host's chosen verdict also survives the re-renders between
// choosing and pressing Send.
let pendingVerdict = "";

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

function showMessage(title: string, detail: string): void {
  const root = document.getElementById("app")!;
  root.replaceChildren();
  const box = el("div", "notice");
  box.append(el("h1", undefined, title), el("p", undefined, detail));
  root.append(box);
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

function render(state: RoomStateView): void {
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
  root.replaceChildren();
  // Floating boxes live on document.body; a re-render must not leave
  // one pointing at a view that no longer exists.
  closeCard();
  document.querySelector(".composer")?.remove();

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
    if (participant.you) row.append(el("span", "person-tag", "you"));
    if (participant.isHost) row.append(el("span", "person-tag", "host"));
    panel.append(row);
  }
  menu.append(panel);
  people.append(icon, menu);
  bar.append(brand, title, people, renderThemeToggle());
  if (state.status !== "ended") {
    const stamp = el("button", "stamp-toggle", "Stamp");
    if (stampMode) stamp.classList.add("on");
    stamp.onclick = () => {
      stampMode = !stampMode;
      stamp.classList.toggle("on", stampMode);
      if (!stampMode) clearHover();
    };
    bar.append(stamp);
  }

  const body = el("div", "body");
  const left = el("div", "left");
  const plan = el("main", "plan");
  plan.id = "plan";
  plan.innerHTML = renderMarkdown(state.content);
  left.append(plan);

  const unanchored = renderInstructionMarks(plan, state);
  const lostIds = new Set(unanchored.map((instruction) => instruction.id));

  body.append(left, renderSidebar(state, plan, lostIds, chatScroll));
  root.append(bar, body);

  if (state.status === "ended") {
    // Drop the selection handler from an earlier render, so no new
    // composer can open into an ended room.
    document.onmouseup = null;
  } else {
    wireComposer(plan, state);
  }
}

function verdictLabel(verdict: string): string {
  if (verdict === "approve") return "Approved";
  if (verdict === "request_changes") return "Changes requested";
  return "Ended";
}

async function postJson(path: string, payload: unknown): Promise<Response> {
  return fetch(path, { method: "POST", body: JSON.stringify(payload) });
}

// The Lucide pencil and trash-2 icons, verbatim (lucide.dev, ISC license).
const PENCIL_ICON = `<svg
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
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
  width="24"
  height="24"
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

// The short line under a bubble that says where the message points.
function anchorHint(anchor: InstructionView["anchor"], lost: boolean): string {
  if (lost) return "anchor lost";
  if (anchor.type === "range" && typeof anchor.quote === "string" && anchor.quote) {
    return `on "${anchor.quote}"`;
  }
  if (anchor.type === "stamp" && typeof anchor.guard === "string" && anchor.guard) {
    return `on "${anchor.guard}"`;
  }
  if (anchor.type === "stamp") return "on a block";
  return "";
}

function userBubble(
  words: string,
  author: { name: string; color: string },
  mine: boolean,
  hint: string,
): HTMLElement {
  const bubble = el("div", "bubble user", undefined);
  if (!mine) {
    const who = el("span", "who", author.name);
    setAuthorColor(who, author.color, "author-text");
    bubble.append(who);
  }
  bubble.append(el("span", "words", words));
  if (hint) bubble.append(el("span", "hint", hint));
  if (!mine) setAuthorColor(bubble, author.color, "author-border");
  if (mine) bubble.classList.add("mine");
  return bubble;
}

function renderConversation(state: RoomStateView, lostIds: Set<string>): HTMLElement {
  const box = el("section", "chat-box");
  box.append(el("h2", undefined, "Conversation"));
  const log = el("div", "chat");
  const ended = state.status === "ended";

  const latest = state.rounds[state.rounds.length - 1];
  for (const round of state.rounds) {
    for (const instruction of round.instructions) {
      const mine = instruction.author.id === state.you.id;
      log.append(
        userBubble(instruction.words, instruction.author, mine, anchorHint(instruction.anchor, false)),
      );
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
    const bubble = userBubble(
      instruction.words,
      instruction.author,
      instruction.mine,
      anchorHint(instruction.anchor, lostIds.has(instruction.id)),
    );
    bubble.classList.add("queued");
    if ((instruction.mine || state.you.isHost || state.you.canSend) && !ended) {
      bubble.classList.add("actionable");
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
          let response: Response;
          try {
            response = await fetch(`/api/rooms/${state.id}/instructions/${instruction.id}`, {
              method: "PATCH",
              body: JSON.stringify({ words }),
            });
          } catch {
            input.setAttribute("aria-invalid", "true");
            error.textContent = "Could not save changes.";
            return;
          }
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
        await fetch(`/api/rooms/${state.id}/instructions/${instruction.id}`, { method: "DELETE" });
        refresh(state.id);
      };
      actions.append(edit, remove);
      bubble.append(actions);
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
  plan: HTMLElement,
  lostIds: Set<string>,
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

  const conversation = renderConversation(state, lostIds);
  side.append(conversation);
  queueMicrotask(() => {
    const log = conversation.querySelector(".chat");
    if (log) log.scrollTop = chatScroll.stick ? log.scrollHeight : chatScroll.top;
  });

  if (!ended) {
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
      if (response.ok) {
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
    side.append(composer);
  }

  if (!ended && (state.you.isHost || state.you.canSend)) {
    side.append(renderSendControls(state, plan));
  }

  if (!ended && state.you.isHost) {
    side.append(renderPermissions(state));
    // Ending is irreversible, so the first click only arms the button.
    const end = el("button", "end-button", "End session");
    let armed = false;
    end.onclick = async () => {
      if (!armed) {
        armed = true;
        end.textContent = "Really end?";
        return;
      }
      await postJson(`/api/rooms/${state.id}/end`, {});
      refresh(state.id);
    };
    side.append(end);
  }

  return side;
}

function renderSendControls(state: RoomStateView, plan: HTMLElement): HTMLElement {
  const box = el("section", "send");
  box.append(el("h2", undefined, "Send to agent"));
  if (state.you.isHost) {
    const select = el("select");
    for (const [value, label] of [
      ["", "No verdict"],
      ["approve", "Approve"],
      ["request_changes", "Request changes"],
    ] as const) {
      const option = el("option", undefined, label);
      option.value = value;
      select.append(option);
    }
    select.value = pendingVerdict;
    select.onchange = () => {
      pendingVerdict = select.value;
    };
    box.append(select);
  }
  const send = el("button", "send-button", "Send to agent");
  const note = el("p", "note");
  send.onclick = async () => {
    // The current rendered plan is the round's DOM snapshot.
    const response = await postJson(`/api/rooms/${state.id}/flush`, {
      domSnapshot: plan.innerHTML,
      nextStep: "",
      ...(pendingVerdict ? { verdict: pendingVerdict } : {}),
    });
    if (response.ok) {
      pendingVerdict = "";
      refresh(state.id);
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (body.error === "round_pending") {
      note.textContent = "The agent has not picked up the last round yet.";
    } else if (body.error === "empty_flush") {
      note.textContent = "Queue a message or choose a verdict first.";
    } else {
      note.textContent = body.message ?? "Could not send.";
    }
  };
  box.append(send, note);
  return box;
}

function renderPermissions(state: RoomStateView): HTMLElement {
  const box = el("section", "permissions");
  box.append(el("h2", undefined, "Guest send permission"));
  const guests = state.participants.filter((participant) => !participant.isHost);
  if (guests.length === 0) {
    box.append(el("p", "empty", "No guests yet."));
    return box;
  }
  for (const guest of guests) {
    const row = el("label", "grant-row");
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.checked = guest.canSend;
    toggle.onchange = async () => {
      await postJson(`/api/rooms/${state.id}/grants`, {
        participantId: guest.id,
        canSend: toggle.checked,
      });
      refresh(state.id);
    };
    const name = el("span", undefined, guest.name);
    setAuthorColor(name, guest.color, "author-text");
    row.append(toggle, name);
    box.append(row);
  }
  return box;
}

// Marks every restorable instruction in the plan and returns the
// instructions whose anchor no longer matches the content.
function renderInstructionMarks(plan: HTMLElement, state: RoomStateView): InstructionView[] {
  const unanchored: InstructionView[] = [];
  const stamps = new Map<Element, InstructionView[]>();
  for (const instruction of state.instructions) {
    // A chat message points at nothing; it lives in the sidebar only.
    if (instruction.anchor.type === "chat") continue;
    if (instruction.anchor.type === "stamp") {
      const target = restoreStamp(plan, instruction.anchor as unknown as StampAnchor);
      if (!target) {
        unanchored.push(instruction);
        continue;
      }
      stamps.set(target, [...(stamps.get(target) ?? []), instruction]);
      continue;
    }
    if (instruction.anchor.type !== "range") {
      unanchored.push(instruction);
      continue;
    }
    const segments = restoreAnchor(plan, instruction.anchor as unknown as RangeAnchor);
    if (!segments) {
      unanchored.push(instruction);
      continue;
    }
    for (const segment of segments) {
      let node = segment.node;
      if (segment.start > 0) node = node.splitText(segment.start);
      if (segment.end - segment.start < node.data.length) node.splitText(segment.end - segment.start);
      const mark = document.createElement("mark");
      mark.className = "pin";
      mark.dataset.instructionId = instruction.id;
      setAuthorColor(mark, instruction.author.color, "author-mark");
      node.parentNode?.replaceChild(mark, node);
      mark.append(node);
      mark.onclick = (event) => {
        event.stopPropagation();
        showCard(mark, state, [instruction]);
      };
    }
  }
  for (const [target, list] of stamps) {
    const element = target as HTMLElement;
    element.classList.add("stamped");
    setAuthorColor(element, list[list.length - 1]!.author.color, "author-outline");
    element.onclick = (event) => {
      if (stampMode) return;
      event.stopPropagation();
      showCard(element, state, list);
    };
  }
  return unanchored;
}

function instructionRow(state: RoomStateView, instruction: InstructionView): HTMLElement {
  const row = el("div", "instruction");
  const author = el("span", "author", instruction.author.name);
  setAuthorColor(author, instruction.author.color, "author-text");
  row.append(author, el("span", "words", instruction.words));
  if (
    (instruction.mine || state.you.isHost || state.you.canSend) &&
    state.status !== "ended"
  ) {
    const remove = el("button", "remove", "Remove");
    remove.onclick = async () => {
      await fetch(`/api/rooms/${state.id}/instructions/${instruction.id}`, { method: "DELETE" });
      refresh(state.id);
    };
    row.append(remove);
  }
  return row;
}

function closeCard(): void {
  document.querySelector(".card")?.remove();
}

function showCard(mark: HTMLElement, state: RoomStateView, list: InstructionView[]): void {
  closeCard();
  const card = el("div", "card");
  for (const instruction of list) {
    card.append(instructionRow(state, instruction));
  }
  positionNear(card, mark);
}

let hovered: HTMLElement | null = null;

function clearHover(): void {
  hovered?.classList.remove("stamp-hover");
  hovered = null;
}

// Inline markup inside a block. A stamp always targets the block, so
// the pointer never jitters between a paragraph and its bold or link
// fragments, and a highlight span is never a target.
const INLINE_TAGS = new Set(["MARK", "STRONG", "EM", "CODE", "A"]);

function stampTarget(plan: HTMLElement, node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  let element: Element | null = node;
  while (element && element !== plan && INLINE_TAGS.has(element.tagName)) {
    element = element.parentElement;
  }
  if (!element || element === plan || !plan.contains(element)) return null;
  return element as HTMLElement;
}

function openComposer(
  state: RoomStateView,
  anchor: RangeAnchor | StampAnchor,
  target: Range | HTMLElement,
  placeholder: string,
): void {
  document.querySelector(".composer")?.remove();
  const composer = el("div", "composer");
  const input = el("input");
  input.placeholder = placeholder;
  input.maxLength = 500;
  const pin = el("button", undefined, "Pin");
  composer.append(input, pin);
  positionNear(composer, target);
  input.focus();

  const submit = async (): Promise<void> => {
    const words = input.value.trim();
    if (!words) return;
    const response = await fetch(`/api/rooms/${state.id}/instructions`, {
      method: "POST",
      body: JSON.stringify({ words, anchor }),
    });
    composer.remove();
    if (response.ok) {
      window.getSelection()?.removeAllRanges();
      refresh(state.id);
    }
  };
  pin.onclick = submit;
  input.onkeydown = (key) => {
    if (key.key === "Enter") submit();
    if (key.key === "Escape") composer.remove();
  };
}

// The pin gestures: a text selection opens the range composer, and in
// stamp mode a hover outlines the block while a click stamps it.
function wireComposer(plan: HTMLElement, state: RoomStateView): void {
  document.onclick = (event) => {
    closeCard();
    if (stampMode && !(event.target as HTMLElement).closest(".composer")) {
      document.querySelector(".composer")?.remove();
    }
  };
  document.onmouseup = (event) => {
    if (stampMode) return;
    if ((event.target as HTMLElement).closest(".composer, .card")) return;
    document.querySelector(".composer")?.remove();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const anchor = captureRange(range, plan);
    if (!anchor) return;
    openComposer(state, anchor, range, "Pin an instruction to this text");
  };
  plan.onmouseover = (event) => {
    if (!stampMode) return;
    const target = stampTarget(plan, event.target);
    if (target === hovered) return;
    clearHover();
    if (target) {
      target.classList.add("stamp-hover");
      hovered = target;
    }
  };
  plan.onmouseleave = () => {
    clearHover();
  };
  plan.onclick = (event) => {
    if (!stampMode) return;
    const target = stampTarget(plan, event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const selector = selectorFor(target, plan);
    if (!selector) return;
    openComposer(
      state,
      { type: "stamp", selector, guard: stampGuard(target) },
      target,
      "Pin an instruction to this block",
    );
  };
}

function positionNear(box: HTMLElement, target: Range | HTMLElement): void {
  const rect = target.getBoundingClientRect();
  box.style.position = "absolute";
  box.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  box.style.top = `${rect.bottom + window.scrollY + 6}px`;
  document.body.append(box);
}

async function refresh(roomId: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/state`);
  if (!response.ok) return;
  const state = (await response.json()) as RoomStateView;
  const serialized = JSON.stringify(state);
  if (serialized === lastRendered) return;
  // Never re-render over an open composer or inline edit; the textarea
  // in progress wins.
  if (document.querySelector(".composer, .inline-edit")) return;
  lastRendered = serialized;
  render(state);
}

function start(roomId: string, state: RoomStateView): void {
  lastRendered = JSON.stringify(state);
  render(state);
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(roomId), POLL_MS);
}

// Tests boot repeatedly against fresh windows; this clears the module
// state a previous boot left behind.
export function resetView(): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  lastRendered = "";
  pendingVerdict = "";
  stampMode = true;
  hovered = null;
}

export async function boot(): Promise<void> {
  initializeTheme();
  const roomId = roomIdFromPath();
  if (!roomId) {
    showMessage("No room", "Open a room link to start.");
    return;
  }
  const response = await fetch(`/api/rooms/${roomId}/state`);
  if (response.ok) {
    start(roomId, (await response.json()) as RoomStateView);
  } else if (response.status === 403) {
    showJoinDialog(roomId);
  } else {
    showMessage("Room not found", "This link does not point to a live room.");
  }
}
