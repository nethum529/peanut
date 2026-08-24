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

  test("validates messages and owns theme, cursors, and snapshots", () => {
    receive({ type: "theme", theme: "light" }, "https://evil.test");
    receive({ type: "theme", theme: "purple" });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    receive({ type: "theme", theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");

    receive(state());
    receive({ type: "cursors", cursors: [{ participantId: "me", x: 0.5, y: 0.5, stale: false }] });
    expect(document.querySelector(".live-cursor")).toBeNull();
    receive({ type: "snapshot-request", requestId: "one" });
    expect(sent.at(-1)?.message.type).toBe("snapshot");
    expect(sent.at(-1)?.message.requestId).toBe("one");
    expect(sent.at(-1)?.message.html).toContain("<main>");
  });
});
