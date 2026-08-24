import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createOverlayRuntime, stampTarget, type OverlayRuntime } from "./overlay.ts";

let win: HappyWindow;
let document: Document;
let runtime: OverlayRuntime;
let sent: Array<{ message: any; origin: string }>;
let host: Window;

const state = (instructions: any[] = []) => ({
  type: "state",
  instructions,
  participants: [
    {
      id: "me",
      name: "Nethum",
      color: "#626689",
      isHost: true,
      canSend: true,
      you: true,
    },
  ],
  ended: false,
});

function receive(data: unknown, origin = "http://chrome.test", source: unknown = host): void {
  runtime.receive({ data, origin, source } as MessageEvent);
}

beforeEach(() => {
  win = new HappyWindow({ url: "http://frame.test/api/rooms/room/document" });
  document = win.document as unknown as Document;
  document.body.innerHTML = "<main><p>first <strong>paragraph</strong></p><p>second</p></main>";
  (globalThis as Record<string, unknown>).Node = win.Node;
  sent = [];
  host = {
    postMessage(message: unknown, origin: string) {
      sent.push({ message, origin });
    },
  } as unknown as Window;
  runtime = createOverlayRuntime(
    win as unknown as Window,
    document,
    "http://chrome.test",
    host,
  );
});

afterEach(() => {
  runtime.destroy();
  delete (globalThis as Record<string, unknown>).Node;
});

describe("document overlay", () => {
  test("keeps the T-44 popover styling in the document stylesheet", async () => {
    const css = await Bun.file(new URL("../public/overlay.css", import.meta.url)).text();
    expect(css).toContain("max-width: calc(100vw - 16px)");
    expect(css).toContain("border-radius: 14px");
    expect(css).toContain("box-shadow: 0 8px 24px var(--peanut-shadow)");
    expect(css).toContain("overflow-wrap: anywhere");
  });

  test("captures a guarded selector and keeps overlay controls out of stamp targets", () => {
    expect(sent[0]).toEqual({ message: { type: "ready" }, origin: "http://chrome.test" });
    receive(state());
    const paragraph = document.querySelector("p")!;
    paragraph.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    const composer = document.querySelector(".composer.peanut-overlay")!;
    expect(composer).not.toBeNull();
    expect(stampTarget(document.body, composer)).toBeNull();
    const input = composer.querySelector("input") as HTMLInputElement;
    input.value = "Tighten this block.";
    input.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
    );
    expect(sent.at(-1)?.message).toEqual({
      type: "pin",
      words: "Tighten this block.",
      anchor: { type: "stamp", selector: "main > p:nth-of-type(1)", guard: "first paragraph" },
    });
  });

  test("clamps the composer to the viewport and preserves it across state updates", () => {
    Object.defineProperty(win, "innerWidth", { configurable: true, value: 300 });
    Object.defineProperty(win, "innerHeight", { configurable: true, value: 300 });
    const paragraph = document.querySelector("p") as HTMLElement;
    paragraph.getBoundingClientRect = () =>
      ({ left: 260, top: 270, right: 290, bottom: 290, width: 30, height: 20 }) as DOMRect;
    const originalRect = win.HTMLElement.prototype.getBoundingClientRect;
    win.HTMLElement.prototype.getBoundingClientRect = function (this: any) {
      if (this.classList.contains("composer")) {
        return {
          left: 0,
          top: 0,
          right: 180,
          bottom: 80,
          width: 180,
          height: 80,
        } as DOMRect;
      }
      return originalRect.call(this);
    } as any;

    receive(state());
    paragraph.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    const composer = document.querySelector(".composer.peanut-overlay") as HTMLElement;
    const input = composer.querySelector("input") as HTMLInputElement;
    input.value = "Keep this draft";
    expect(composer.style.left).toBe("112px");
    expect(composer.style.top).toBe("182px");

    receive(
      state([
        {
          id: "peer-stamp",
          words: "Peer note",
          anchor: { type: "stamp", selector: "main > p:nth-of-type(2)", guard: "second" },
          author: { name: "Sam", color: "#575d6d", isHost: false },
          mine: false,
          pinnedAt: 1,
        },
      ]),
    );
    expect(document.querySelector(".composer.peanut-overlay")).toBe(composer);
    expect((composer.querySelector("input") as HTMLInputElement).value).toBe("Keep this draft");
    expect(document.querySelector("p.stamped")?.textContent).toBe("second");
    win.HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  test("restores stamp and range anchors, then relays an allowed unpin", () => {
    receive(
      state([
        {
          id: "stamp-1",
          words: "Block note",
          anchor: { type: "stamp", selector: "main > p:nth-of-type(2)", guard: "second" },
          author: { name: "Nethum", color: "#626689", isHost: true },
          mine: true,
          pinnedAt: 1,
        },
        {
          id: "range-1",
          words: "Word note",
          anchor: {
            type: "range",
            selector: "main > p:nth-of-type(1)",
            nodePath: [],
            startOffset: 6,
            endOffset: 11,
            quote: "parag",
          },
          author: { name: "Nethum", color: "#626689", isHost: true },
          mine: true,
          pinnedAt: 2,
        },
      ]),
    );
    expect(document.querySelector("p.stamped")?.textContent).toBe("second");
    expect(document.querySelector("mark.pin")?.textContent).toBe("parag");

    document.querySelector("p.stamped")!.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event,
    );
    (document.querySelector(".card .remove") as HTMLButtonElement).click();
    expect(sent.at(-1)?.message).toEqual({ type: "unpin", instructionId: "stamp-1" });
  });

  test("positions the cursor layer against the body and updates cursor nodes in place", () => {
    const body = document.body;
    body.getBoundingClientRect = () =>
      ({ left: 100, top: 200, right: 500, bottom: 1000, width: 400, height: 800 }) as DOMRect;
    const withPeer = state();
    withPeer.participants.push({
      id: "sam",
      name: "Sam",
      color: "#575d6d",
      isHost: false,
      canSend: false,
      you: false,
    });
    receive(withPeer);
    expect(body.style.position).toBe("relative");
    const layer = body.querySelector(".peanut-cursor-layer");
    expect(layer?.parentElement).toBe(body);

    body.dispatchEvent(
      new win.MouseEvent("pointermove", {
        bubbles: true,
        clientX: 300,
        clientY: 600,
      }) as unknown as Event,
    );
    expect(sent.at(-1)?.message).toEqual({ type: "cursor", x: 0.5, y: 0.5 });

    receive({
      type: "cursors",
      cursors: [{ participantId: "sam", x: 0.25, y: 0.75, stale: false }],
    });
    const first = body.querySelector(".live-cursor") as HTMLElement;
    expect(first.style.left).toBe("25%");
    expect(first.style.top).toBe("75%");
    receive({
      type: "cursors",
      cursors: [{ participantId: "sam", x: 0.5, y: 0.9, stale: true }],
    });
    const updated = body.querySelector(".live-cursor") as HTMLElement;
    expect(updated).toBe(first);
    expect(updated.style.left).toBe("50%");
    expect(updated.style.top).toBe("90%");
    expect(updated.classList.contains("stale")).toBe(true);
    expect(body.querySelector(".peanut-cursor-layer")).toBe(layer);
  });

  test("validates messages and owns theme and clean snapshots", () => {
    receive({ type: "theme", theme: "light" }, "https://evil.test");
    receive({ type: "theme", theme: "purple" });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    receive({ type: "theme", theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");

    receive(state());
    receive({ type: "cursors", cursors: [{ participantId: "me", x: 0.5, y: 0.5, stale: false }] });
    expect(document.querySelector(".live-cursor")).toBeNull();
    const link = document.createElement("link");
    link.href = "/overlay.css";
    const script = document.createElement("script");
    script.src = "/overlay.js";
    document.body.append(link, script);
    receive({ type: "snapshot-request", requestId: "one" });
    expect(sent.at(-1)?.message.type).toBe("snapshot");
    expect(sent.at(-1)?.message.requestId).toBe("one");
    expect(sent.at(-1)?.message.html).toContain("<main>");
    expect(sent.at(-1)?.message.html).not.toContain("peanut-overlay");
    expect(sent.at(-1)?.message.html).not.toContain("/overlay.css");
    expect(sent.at(-1)?.message.html).not.toContain("/overlay.js");
  });
});
