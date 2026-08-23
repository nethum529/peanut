import { renderMarkdown } from "./markdown.ts";

interface ParticipantView {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  canSend: boolean;
  you: boolean;
}

interface RoomStateView {
  id: string;
  title: string;
  content: string;
  status: string;
  participants: ParticipantView[];
}

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
      render((await response.json()) as RoomStateView);
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

  const plan = el("main", "plan");
  plan.innerHTML = renderMarkdown(state.content);

  root.append(bar, plan);

  if (state.status === "ended") {
    const done = el("div", "ended", "This session has ended.");
    root.append(done);
  }
}

async function boot(): Promise<void> {
  const roomId = roomIdFromPath();
  if (!roomId) {
    showMessage("No room", "Open a room link to start.");
    return;
  }
  const response = await fetch(`/api/rooms/${roomId}/state`);
  if (response.ok) {
    render((await response.json()) as RoomStateView);
  } else if (response.status === 403) {
    showJoinDialog(roomId);
  } else {
    showMessage("Room not found", "This link does not point to a live room.");
  }
}

boot();
