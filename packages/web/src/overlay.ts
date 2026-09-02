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
  isQuestionKey,
  type ChromeToOverlayMessage,
  type OverlayCursor,
  type OverlayInstruction,
  type OverlayParticipant,
  type OverlayToChromeMessage,
} from "./protocol.ts";
import { renderDiagramBlocks } from "./diagram.ts";

// SPAN belongs with inline markup so word-level wrappers still stamp their
// containing block. A document made only of spans therefore needs a block
// ancestor before it has a stamp target.
const INLINE_TAGS = new Set(["MARK", "STRONG", "EM", "CODE", "A", "SPAN"]);
const NON_TARGET_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"]);

export interface OverlayRuntime {
  receive(event: MessageEvent): void;
  destroy(): void;
}

interface PeanutDocumentApi {
  answer(questionKey: unknown, answer: unknown): boolean;
}

type PeanutDocumentWindow = Window & { peanut?: PeanutDocumentApi };

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
  const diagram = target.closest<HTMLElement>(
    '[data-peanut-diagram][data-peanut-diagram-rendered="true"]',
  );
  if (diagram && diagram !== root && root.contains(diagram)) return diagram;
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
  renderDiagramBlocks(document);
  let state: Extract<ChromeToOverlayMessage, { type: "state" }> = {
    type: "state",
    instructions: [],
    participants: [],
    ended: false,
  };
  let cursors: OverlayCursor[] = [];
  let draftActive = false;
  let hovered: HTMLElement | null = null;
  let markedStamps = new Map<HTMLElement, OverlayInstruction[]>();
  const cursorNodes = new Map<string, HTMLElement>();
  const originalBodyPosition = root.style.position;
  const computedBodyPosition = view.getComputedStyle(root).position;
  const positionedBody = !computedBodyPosition || computedBodyPosition === "static";
  if (positionedBody) root.style.position = "relative";

  const send = (message: OverlayToChromeMessage): void => {
    if (expectedParentOrigin) host.postMessage(message, expectedParentOrigin);
  };

  const findQuestionBlock = (questionKey: string): HTMLElement | null => {
    const matches = [...root.querySelectorAll<HTMLElement>("[data-peanut-question]")].filter(
      (candidate) => candidate.dataset.peanutQuestion === questionKey,
    );
    return matches.length === 1 ? matches[0]! : null;
  };

  const answerStatus = (block: HTMLElement): HTMLElement | null =>
    block.querySelector<HTMLElement>("[data-peanut-answer-status]");

  const setAnswerStatus = (
    block: HTMLElement,
    status: "error" | "sending" | "sent",
    words: string,
  ): boolean => {
    const output = answerStatus(block);
    if (!output) return false;
    output.dataset.state = status;
    output.textContent = words;
    return true;
  };

  let apiActive = true;
  const api: PeanutDocumentApi = Object.freeze({
    answer(questionKey: unknown, answer: unknown): boolean {
      if (!apiActive || !isQuestionKey(questionKey)) return false;
      const block = findQuestionBlock(questionKey);
      if (!block || !answerStatus(block)) return false;
      if (state.ended) {
        setAnswerStatus(block, "error", "This review has ended.");
        return false;
      }
      if (!state.participants.some((participant) => participant.you)) {
        setAnswerStatus(block, "error", "Review controls are not ready.");
        return false;
      }
      if (typeof answer !== "string" || !answer.trim()) {
        setAnswerStatus(block, "error", "Write an answer before sending.");
        return false;
      }
      const question = (block.querySelector("legend")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const chosen = answer.replace(/\s+/g, " ").trim();
      if (!question || question.length > 800 || chosen.length > 1000) {
        setAnswerStatus(block, "error", "The question or answer is too long.");
        return false;
      }
      const selector = selectorFor(block, root);
      const words = `Question: ${question}\nAnswer: ${chosen}`;
      if (!selector || words.length > 2000) {
        setAnswerStatus(block, "error", "This question cannot be sent.");
        return false;
      }
      const anchor: StampAnchor = { type: "stamp", selector, guard: question.slice(0, 80) };
      setAnswerStatus(block, "sending", "Sending answer...");
      send({
        type: "pin",
        words,
        anchor,
        questionKey,
      });
      return true;
    },
  });
  const documentView = view as PeanutDocumentWindow;
  let apiInstalled = false;
  try {
    Object.defineProperty(documentView, "peanut", {
      configurable: true,
      enumerable: true,
      value: api,
      writable: false,
    });
    apiInstalled = true;
  } catch {
    apiActive = false;
  }

  const setDraftActive = (active: boolean): void => {
    if (draftActive === active) return;
    draftActive = active;
    send({ type: "draft-state", hasDraft: active });
  };

  const closeFloating = (): void => {
    if (root.querySelector(".composer.peanut-overlay")) setDraftActive(false);
    root.querySelectorAll(".composer.peanut-overlay, .card.peanut-overlay").forEach((node) =>
      node.remove(),
    );
  };

  const closeCards = (): void => {
    root.querySelectorAll(".card.peanut-overlay").forEach((node) => node.remove());
  };

  const clearHover = (): void => {
    hovered?.classList.remove("stamp-hover");
    hovered = null;
  };

  const positionNear = (box: HTMLElement, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    root.append(box);
    const boxRect = box.getBoundingClientRect();
    const viewportStart = view.scrollX + 8;
    const viewportEnd = view.scrollX + view.innerWidth - boxRect.width - 8;
    const desiredLeft = rect.left + view.scrollX;
    const pageLeft = Math.max(viewportStart, Math.min(desiredLeft, viewportEnd));

    const below = rect.bottom + view.scrollY + 8;
    const above = rect.top + view.scrollY - boxRect.height - 8;
    const viewportTop = view.scrollY + 8;
    const viewportBottom = view.scrollY + view.innerHeight - 8;
    const shouldPlaceAbove = below + boxRect.height > viewportBottom && above >= viewportTop;
    const pageTop = shouldPlaceAbove ? above : below;
    const rootRect = root.getBoundingClientRect();
    box.style.left = `${pageLeft - (rootRect.left + view.scrollX)}px`;
    box.style.top = `${pageTop - (rootRect.top + view.scrollY)}px`;
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
    // Cards point at marks that are about to be rebuilt. A composer points
    // at the underlying document and must keep the reviewer's typed text.
    closeCards();
    const stamps = new Map<HTMLElement, OverlayInstruction[]>();
    const missingInstructionIds: string[] = [];
    for (const instruction of state.instructions) {
      if (instruction.anchor.type === "chat") continue;
      if (instruction.anchor.type === "stamp") {
        const target = restoreStamp(root, instruction.anchor as StampAnchor) as HTMLElement | null;
        if (target) {
          stamps.set(target, [...(stamps.get(target) ?? []), instruction]);
        } else {
          missingInstructionIds.push(instruction.id);
        }
        continue;
      }
      if (instruction.anchor.type !== "range") continue;
      const segments = restoreAnchor(root, instruction.anchor as RangeAnchor);
      if (!segments) {
        missingInstructionIds.push(instruction.id);
        continue;
      }
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
    send({ type: "anchor-state", missingInstructionIds });
  };

  const cursorNode = (participant: OverlayParticipant): HTMLElement => {
    const node = element(document, "div", "live-cursor peanut-overlay");
    node.dataset.participantId = participant.id;
    node.setAttribute("aria-hidden", "true");
    authorColor(node, participant.color, "peanut-author-cursor");
    node.innerHTML =
      '<svg viewBox="0 0 20 24" aria-hidden="true" focusable="false">' +
      '<path d="M2 1.5v17.8l4.4-4.2 3.6 7.4 3.7-1.8-3.6-7.2h6.1L2 1.5Z"/></svg>';
    node.append(element(document, "span", "cursor-name", participant.name));
    return node;
  };

  const updateCursorNode = (
    node: HTMLElement,
    participant: OverlayParticipant,
    cursor: OverlayCursor,
  ): void => {
    authorColor(node, participant.color, "peanut-author-cursor");
    const name = node.querySelector(".cursor-name");
    if (name) name.textContent = participant.name;
    node.style.left = `${cursor.x * 100}%`;
    node.style.top = `${cursor.y * 100}%`;
    node.classList.toggle("right-edge", cursor.x > 0.75);
    node.classList.toggle("bottom-edge", cursor.y > 0.9);
    node.classList.toggle("leaving", cursor.leaving);
  };

  const renderCursors = (): void => {
    let layer = root.querySelector<HTMLElement>(".peanut-cursor-layer");
    if (!layer) {
      layer = element(document, "div", "peanut-cursor-layer peanut-overlay");
      root.append(layer);
      cursorNodes.clear();
    }
    const participants = new Map(state.participants.map((person) => [person.id, person]));
    const visible = new Set<string>();
    for (const cursor of cursors) {
      const participant = participants.get(cursor.participantId);
      if (!participant || participant.you) continue;
      visible.add(cursor.participantId);
      let node = cursorNodes.get(cursor.participantId);
      if (!node) {
        node = cursorNode(participant);
        cursorNodes.set(cursor.participantId, node);
        layer.append(node);
      }
      updateCursorNode(node, participant, cursor);
    }
    for (const [participantId, node] of cursorNodes) {
      if (visible.has(participantId)) continue;
      node.remove();
      cursorNodes.delete(participantId);
    }
  };

  const snapshotHtml = (): string => {
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll<HTMLElement>("[data-peanut-diagram]").forEach((block) => {
      block.querySelector(":scope > .peanut-diagram-canvas")?.remove();
      delete block.dataset.peanutDiagramRendered;
      delete block.dataset.peanutDiagramInvalid;
    });
    clone
      .querySelectorAll(
        '.peanut-overlay, link[href="/overlay.css"], script[src="/overlay.js"]',
      )
      .forEach((node) => node.remove());
    clone.querySelectorAll("mark.pin[data-instruction-id]").forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent?.normalize();
    });
    clone.querySelectorAll("[data-peanut-stamped]").forEach((node) => {
      node.classList.remove("stamped", "peanut-author-outline");
      delete (node as HTMLElement).dataset.peanutStamped;
      (node as HTMLElement).style.removeProperty("--peanut-author-color");
    });
    clone.querySelectorAll(".stamp-hover").forEach((node) => node.classList.remove("stamp-hover"));
    return clone.innerHTML;
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
    setDraftActive(true);
    input.focus();
    const submit = (): void => {
      const words = input.value.trim();
      if (!words) return;
      setDraftActive(false);
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
      if (event.key === "Escape") {
        setDraftActive(false);
        composer.remove();
      }
    };
  };

  const showNewVersionBanner = (): void => {
    const composer = root.querySelector<HTMLElement>(".composer.peanut-overlay");
    if (!composer || !draftActive || composer.querySelector(".new-version-banner")) return;
    const banner = element(document, "div", "new-version-banner");
    banner.append(document.createTextNode("New version. "));
    const reload = element(document, "button", undefined, "Reload");
    reload.type = "button";
    reload.onclick = (event) => {
      event.stopPropagation();
      send({ type: "reload-document" });
    };
    banner.append(reload);
    composer.prepend(banner);
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
    const clicked = event.target as Element | null;
    if (clicked?.closest?.(".peanut-overlay")) return;
    if (
      clicked?.closest?.("[data-peanut-question]") &&
      clicked.closest("input, button, label, textarea, select")
    ) {
      closeFloating();
      return;
    }
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

  const selectedAnswer = (block: HTMLElement): { answer: string; label: string } => {
    const selected = block.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    if (!selected) return { answer: "", label: "No option" };
    if (selected.hasAttribute("data-peanut-write-own")) {
      const own = block.querySelector<HTMLInputElement>("[data-peanut-own-answer]");
      const answer = own?.value.trim() ?? "";
      return { answer, label: answer || "Write my own" };
    }
    const answer = selected.value.trim();
    return { answer, label: answer || "No option" };
  };

  const showSelection = (block: HTMLElement): void => {
    const output = block.querySelector<HTMLElement>("[data-peanut-selection-status]");
    if (output) output.textContent = `Selected: ${selectedAnswer(block).label}`;
  };

  const onQuestionChange = (event: Event): void => {
    const changed = event.target as Element | null;
    const block = changed?.closest?.<HTMLElement>("[data-peanut-question]");
    if (block && changed?.matches('input[type="radio"]')) showSelection(block);
  };

  const onQuestionInput = (event: Event): void => {
    const changed = event.target as Element | null;
    const block = changed?.closest?.<HTMLElement>("[data-peanut-question]");
    if (block && changed?.matches("[data-peanut-own-answer]")) showSelection(block);
  };

  const onQuestionSubmit = (event: SubmitEvent): void => {
    const block = (event.target as Element | null)?.closest?.<HTMLElement>(
      "[data-peanut-question]",
    );
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    api.answer(block.dataset.peanutQuestion, selectedAnswer(block).answer);
  };

  const receive = (event: MessageEvent): void => {
    if (event.source !== host || event.origin !== expectedParentOrigin) return;
    if (!isChromeToOverlayMessage(event.data)) return;
    const message = event.data;
    if (message.type === "state") {
      state = message;
      if (state.ended) {
        clearHover();
        closeFloating();
      }
      renderMarks();
      renderCursors();
    } else if (message.type === "cursors") {
      cursors = message.cursors;
      renderCursors();
    } else if (message.type === "theme") {
      document.documentElement.dataset.theme = message.theme;
    } else if (message.type === "new-version") {
      showNewVersionBanner();
    } else if (message.type === "answer-result") {
      const block = findQuestionBlock(message.questionKey);
      if (block) {
        if (message.ok) setAnswerStatus(block, "sent", `Sent: ${message.answer}`);
        else setAnswerStatus(block, "error", message.error);
      }
    } else {
      send({ type: "snapshot", requestId: message.requestId, html: snapshotHtml() });
    }
  };

  view.addEventListener("message", receive);
  root.addEventListener("mouseover", onMouseOver);
  root.addEventListener("mouseleave", onMouseLeave);
  root.addEventListener("click", onClick);
  root.addEventListener("change", onQuestionChange);
  root.addEventListener("input", onQuestionInput);
  root.addEventListener("submit", onQuestionSubmit);
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
      root.removeEventListener("change", onQuestionChange);
      root.removeEventListener("input", onQuestionInput);
      root.removeEventListener("submit", onQuestionSubmit);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
      clearHover();
      closeFloating();
      clearMarks();
      root.querySelector(".peanut-cursor-layer")?.remove();
      cursorNodes.clear();
      apiActive = false;
      if (apiInstalled && documentView.peanut === api) delete documentView.peanut;
      if (positionedBody) root.style.position = originalBodyPosition;
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.currentScript) {
  createOverlayRuntime();
}
