import {
  captureRange,
  restoreAnchor,
  restoreStamp,
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

interface RoomStateView {
  id: string;
  title: string;
  content: string;
  status: string;
  you: ParticipantView;
  participants: ParticipantView[];
  instructions: InstructionView[];
}

const POLL_MS = 2000;

let lastRendered = "";
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Stamp mode lives outside render, so a state refresh keeps it on.
let stampMode = false;

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
  root.replaceChildren();
  // Floating boxes live on document.body; a re-render must not leave
  // one pointing at a view that no longer exists.
  closeCard();
  document.querySelector(".composer")?.remove();

  const bar = el("header", "toolbar");
  const brand = el("span", "wordmark", "Peanut");
  const title = el("span", "title", state.title || "Untitled review");
  const people = el("div", "people");
  for (const participant of state.participants) {
    const chip = el("span", "person", participant.name);
    chip.style.borderColor = participant.color;
    if (participant.you) chip.classList.add("you");
    if (participant.isHost) chip.title = "Host";
    people.append(chip);
  }
  bar.append(brand, title, people);
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

  const plan = el("main", "plan");
  plan.id = "plan";
  plan.innerHTML = renderMarkdown(state.content);

  root.append(bar, plan);

  const unanchored = renderInstructionMarks(plan, state);
  if (unanchored.length > 0) {
    const box = el("section", "unanchored");
    box.append(el("h2", undefined, "Instructions without a place"));
    const list = el("ul");
    for (const instruction of unanchored) {
      list.append(instructionRow(state, instruction, "li"));
    }
    box.append(list);
    root.append(box);
  }

  if (state.status === "ended") {
    // Drop the selection handler from an earlier render, so no new
    // composer can open into an ended room.
    document.onmouseup = null;
    root.append(el("div", "ended", "This session has ended."));
  } else {
    wireComposer(plan, state);
  }
}

// Marks every restorable instruction in the plan and returns the
// instructions whose anchor no longer matches the content.
function renderInstructionMarks(plan: HTMLElement, state: RoomStateView): InstructionView[] {
  const unanchored: InstructionView[] = [];
  const stamps = new Map<Element, InstructionView[]>();
  for (const instruction of state.instructions) {
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
      mark.style.textDecorationColor = instruction.author.color;
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
    element.style.outlineColor = list[list.length - 1]!.author.color;
    element.onclick = (event) => {
      if (stampMode) return;
      event.stopPropagation();
      showCard(element, state, list);
    };
  }
  return unanchored;
}

function instructionRow(
  state: RoomStateView,
  instruction: InstructionView,
  tag: "li" | "div",
): HTMLElement {
  const row = el(tag, "instruction");
  const author = el("span", "author", instruction.author.name);
  author.style.color = instruction.author.color;
  row.append(author, el("span", "words", instruction.words));
  if (instruction.mine || state.you.isHost) {
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
    card.append(instructionRow(state, instruction, "div"));
  }
  positionNear(card, mark);
}

let hovered: HTMLElement | null = null;

function clearHover(): void {
  hovered?.classList.remove("stamp-hover");
  hovered = null;
}

// The stamp target is the element under the pointer, lifted out of a
// range mark so a stamp never targets the highlight span itself.
function stampTarget(plan: HTMLElement, node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  let element: Element | null = node;
  while (element && (element.tagName === "MARK" || element === plan)) {
    element = element === plan ? null : element.parentElement;
  }
  if (!element || !plan.contains(element)) return null;
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
  document.onclick = () => {
    closeCard();
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
    openComposer(state, { type: "stamp", selector }, target, "Pin an instruction to this block");
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
  // Never re-render over an open composer; the pin in progress wins.
  if (document.querySelector(".composer")) return;
  lastRendered = serialized;
  render(state);
}

function start(roomId: string, state: RoomStateView): void {
  lastRendered = JSON.stringify(state);
  render(state);
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(roomId), POLL_MS);
}

async function boot(): Promise<void> {
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

boot();
