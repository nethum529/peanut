import {
  restoreAnchor,
  restoreStamp,
  selectorFor,
  stampGuard,
  type RangeAnchor,
  type StampAnchor,
} from "./anchors.ts";
import {
  isChromeToOverlayMessage,
  type ChromeToOverlayMessage,
  type OverlayCursor,
  type OverlayInstruction,
  type OverlayParticipant,
  type OverlayToChromeMessage,
} from "./protocol.ts";

const INLINE_TAGS = new Set(["MARK", "STRONG", "EM", "CODE", "A", "SPAN"]);
const NON_TARGET_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"]);

export interface OverlayRuntime {
  receive(event: MessageEvent): void;
  destroy(): void;
}

function parentOrigin(document: Document): string {
  for (const candidate of [document.referrer, document.baseURI]) {
    try {
      const origin = new URL(candidate).origin;
      if (origin !== "null") return origin;
    } catch {
      // Try the next source.
    }
  }
  return "";
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function authorColor(node: HTMLElement, color: string, className: string): void {
  node.classList.add(className);
  node.style.setProperty("--peanut-author-color", color);
}

export function stampTarget(root: HTMLElement, node: EventTarget | null): HTMLElement | null {
  if (!node || (node as Node).nodeType !== 1) return null;
  let target = node as Element;
  if (target.closest(".peanut-overlay")) return null;
  while (target !== root && INLINE_TAGS.has(target.tagName)) target = target.parentElement!;
  if (
    !target ||
    target === root ||
    !root.contains(target) ||
    NON_TARGET_TAGS.has(target.tagName)
  ) {
    return null;
  }
  return target as HTMLElement;
}

export function createOverlayRuntime(
  view: Window = window,
  document: Document = view.document,
  expectedParentOrigin = parentOrigin(document),
  host: Window = view.parent,
): OverlayRuntime {
  const root = document.body;
  let state: Extract<ChromeToOverlayMessage, { type: "state" }> = {
    type: "state",
    instructions: [],
    participants: [],
    ended: false,
  };
  let cursors: OverlayCursor[] = [];
  let hovered: HTMLElement | null = null;
  let markedStamps = new Map<HTMLElement, OverlayInstruction[]>();

  const send = (message: OverlayToChromeMessage): void => {
    if (expectedParentOrigin) host.postMessage(message, expectedParentOrigin);
  };

  const closeFloating = (): void => {
    root.querySelectorAll(".composer.peanut-overlay, .card.peanut-overlay").forEach((node) =>
      node.remove(),
    );
  };

  const clearHover = (): void => {
    hovered?.classList.remove("stamp-hover");
    hovered = null;
  };

  const positionNear = (box: HTMLElement, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    box.style.left = `${Math.max(8, rect.left + view.scrollX)}px`;
    box.style.top = `${rect.bottom + view.scrollY + 6}px`;
    root.append(box);
  };

  const canRemove = (instruction: OverlayInstruction): boolean => {
    const you = state.participants.find((participant) => participant.you);
    return !state.ended && Boolean(instruction.mine || you?.isHost || you?.canSend);
  };

  const showCard = (target: HTMLElement, list: OverlayInstruction[]): void => {
    closeFloating();
    const card = element(document, "div", "card peanut-overlay");
    for (const instruction of list) {
      const row = element(document, "div", "instruction");
      const author = element(document, "span", "author", instruction.author.name);
      authorColor(author, instruction.author.color, "peanut-author-text");
      row.append(author, element(document, "span", "words", instruction.words));
      if (canRemove(instruction)) {
        const remove = element(document, "button", "remove", "Remove");
        remove.type = "button";
        remove.onclick = (event) => {
          event.stopPropagation();
          send({ type: "unpin", instructionId: instruction.id });
          card.remove();
        };
        row.append(remove);
      }
      card.append(row);
    }
    positionNear(card, target);
  };

  const clearMarks = (): void => {
    root.querySelectorAll("mark.pin[data-instruction-id]").forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent?.normalize();
    });
    root.querySelectorAll("[data-peanut-stamped]").forEach((node) => {
      node.classList.remove("stamped", "peanut-author-outline");
      delete (node as HTMLElement).dataset.peanutStamped;
      (node as HTMLElement).style.removeProperty("--peanut-author-color");
    });
  };

  const renderMarks = (): void => {
    clearMarks();
    closeFloating();
    const stamps = new Map<HTMLElement, OverlayInstruction[]>();
    for (const instruction of state.instructions) {
      if (instruction.anchor.type === "chat") continue;
      if (instruction.anchor.type === "stamp") {
        const target = restoreStamp(root, instruction.anchor as StampAnchor) as HTMLElement | null;
        if (target) stamps.set(target, [...(stamps.get(target) ?? []), instruction]);
        continue;
      }
      if (instruction.anchor.type !== "range") continue;
      const segments = restoreAnchor(root, instruction.anchor as RangeAnchor);
      if (!segments) continue;
      for (const segment of segments) {
        let node = segment.node;
        if (segment.start > 0) node = node.splitText(segment.start);
        if (segment.end - segment.start < node.data.length) {
          node.splitText(segment.end - segment.start);
        }
        const mark = element(document, "mark", "pin");
        mark.dataset.instructionId = instruction.id;
        authorColor(mark, instruction.author.color, "peanut-author-mark");
        node.parentNode?.replaceChild(mark, node);
        mark.append(node);
        mark.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          showCard(mark, [instruction]);
        };
      }
    }
    for (const [target, instructions] of stamps) {
      target.classList.add("stamped");
      target.dataset.peanutStamped = "true";
      authorColor(
        target,
        instructions[instructions.length - 1]!.author.color,
        "peanut-author-outline",
      );
    }
    markedStamps = stamps;
  };

  const cursorNode = (
    participant: OverlayParticipant,
    cursor: OverlayCursor,
  ): HTMLElement => {
    const node = element(document, "div", "live-cursor peanut-overlay");
    node.dataset.participantId = participant.id;
    node.setAttribute("aria-hidden", "true");
    authorColor(node, participant.color, "peanut-author-cursor");
    node.innerHTML =
      '<svg viewBox="0 0 20 24" aria-hidden="true" focusable="false">' +
      '<path d="M2 1.5v17.8l4.4-4.2 3.6 7.4 3.7-1.8-3.6-7.2h6.1L2 1.5Z"/></svg>';
    node.append(element(document, "span", "cursor-name", participant.name));
    node.style.left = `${cursor.x * 100}%`;
    node.style.top = `${cursor.y * 100}%`;
    node.classList.toggle("right-edge", cursor.x > 0.75);
    node.classList.toggle("bottom-edge", cursor.y > 0.9);
    node.classList.toggle("stale", cursor.stale);
    return node;
  };

  const renderCursors = (): void => {
    root.querySelector(".peanut-cursor-layer")?.remove();
    if (cursors.length === 0) return;
    const layer = element(document, "div", "peanut-cursor-layer peanut-overlay");
    const participants = new Map(state.participants.map((person) => [person.id, person]));
    for (const cursor of cursors) {
      const participant = participants.get(cursor.participantId);
      if (participant && !participant.you) layer.append(cursorNode(participant, cursor));
    }
    root.append(layer);
  };

  const openComposer = (anchor: StampAnchor, target: HTMLElement): void => {
    closeFloating();
    const composer = element(document, "div", "composer peanut-overlay");
    const input = element(document, "input");
    input.placeholder = "Pin an instruction to this block";
    input.maxLength = 2000;
    const pin = element(document, "button", undefined, "Pin");
    pin.type = "button";
    composer.append(input, pin);
    positionNear(composer, target);
    input.focus();
    const submit = (): void => {
      const words = input.value.trim();
      if (!words) return;
      send({ type: "pin", words, anchor });
      composer.remove();
      view.getSelection()?.removeAllRanges();
    };
    pin.onclick = (event) => {
      event.stopPropagation();
      submit();
    };
    input.onkeydown = (event) => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") composer.remove();
    };
  };

  const onMouseOver = (event: MouseEvent): void => {
    if (state.ended) return;
    const target = stampTarget(root, event.target);
    if (target === hovered) return;
    clearHover();
    if (target) {
      target.classList.add("stamp-hover");
      hovered = target;
    }
    send({ type: "hover", selector: target ? selectorFor(target, root) : null });
  };

  const onMouseLeave = (): void => {
    clearHover();
    send({ type: "hover", selector: null });
  };

  const onClick = (event: MouseEvent): void => {
    if ((event.target as Element | null)?.closest?.(".peanut-overlay")) return;
    closeFloating();
    if (state.ended) return;
    const target = stampTarget(root, event.target);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const stamped = markedStamps.get(target);
    if (stamped) {
      showCard(target, stamped);
      return;
    }
    const selector = selectorFor(target, root);
    if (selector) openComposer({ type: "stamp", selector, guard: stampGuard(target) }, target);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (state.ended) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    send({
      type: "cursor",
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
  };

  const onPointerLeave = (): void => send({ type: "cursor-leave" });

  const receive = (event: MessageEvent): void => {
    if (event.source !== host || event.origin !== expectedParentOrigin) return;
    if (!isChromeToOverlayMessage(event.data)) return;
    const message = event.data;
    if (message.type === "state") {
      state = message;
      if (state.ended) clearHover();
      renderMarks();
      renderCursors();
    } else if (message.type === "cursors") {
      cursors = message.cursors;
      renderCursors();
    } else if (message.type === "theme") {
      document.documentElement.dataset.theme = message.theme;
    } else {
      send({ type: "snapshot", requestId: message.requestId, html: root.innerHTML });
    }
  };

  view.addEventListener("message", receive);
  root.addEventListener("mouseover", onMouseOver);
  root.addEventListener("mouseleave", onMouseLeave);
  root.addEventListener("click", onClick);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerleave", onPointerLeave);
  send({ type: "ready" });

  return {
    receive,
    destroy() {
      view.removeEventListener("message", receive);
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener("mouseleave", onMouseLeave);
      root.removeEventListener("click", onClick);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
      clearHover();
      closeFloating();
      clearMarks();
      root.querySelector(".peanut-cursor-layer")?.remove();
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.currentScript) {
  createOverlayRuntime();
}
