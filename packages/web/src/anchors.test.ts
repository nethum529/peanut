import { Window } from "happy-dom";
import { beforeEach, describe, expect, test } from "bun:test";
import { captureRange, restoreAnchor, selectorFor, type RangeAnchor } from "./anchors.ts";

// The anchor module runs against the browser DOM; happy-dom stands in
// for it here. The globals it reads (Node) are registered per test.
let window: Window;
let document: Document;

function setup(html: string): Element {
  window = new Window();
  document = window.document as unknown as Document;
  (globalThis as Record<string, unknown>).Node = window.Node;
  document.body.innerHTML = `<main id="plan">${html}</main>`;
  return document.getElementById("plan")!;
}

function rangeOver(node: Node, start: number, endNode: Node, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  return range;
}

beforeEach(() => {
  setup("");
});

describe("selectorFor", () => {
  test("builds an nth-of-type path from the root", () => {
    const plan = setup("<p>a</p><p>b</p><ul><li>x</li><li>y</li></ul>");
    const second = plan.querySelectorAll("li")[1]!;
    expect(selectorFor(second, plan)).toBe("ul > li:nth-of-type(2)");
    expect(plan.querySelector(selectorFor(second, plan))).toBe(second);
  });

  test("caps the path at the first id", () => {
    const plan = setup('<section id="intro"><p>a</p><p>b</p></section>');
    const p = plan.querySelectorAll("p")[1]!;
    expect(selectorFor(p, plan)).toBe("section#intro > p:nth-of-type(2)");
  });

  test("keeps at most five parts", () => {
    const plan = setup("<div><div><div><div><div><div><p>deep</p></div></div></div></div></div></div>");
    const p = plan.querySelector("p")!;
    expect(selectorFor(p, plan).split(" > ").length).toBeLessThanOrEqual(5);
  });
});

describe("captureRange", () => {
  test("captures offsets and quote inside one text node", () => {
    const plan = setup("<p>the quick brown fox</p>");
    const text = plan.querySelector("p")!.firstChild!;
    const anchor = captureRange(rangeOver(text, 4, text, 9), plan);
    expect(anchor).toEqual({
      type: "range",
      selector: "p",
      nodePath: [],
      startOffset: 4,
      endOffset: 9,
      quote: "quick",
    });
  });

  test("captures across inline markup with element offsets", () => {
    const plan = setup("<p>one <strong>two</strong> three</p>");
    const p = plan.querySelector("p")!;
    const first = p.firstChild!;
    const last = p.lastChild!;
    const anchor = captureRange(rangeOver(first, 0, last, 6), plan)!;
    expect(anchor.quote).toBe("one two three");
    expect(anchor.startOffset).toBe(0);
    expect(anchor.endOffset).toBe(13);
  });

  test("handles an element boundary at the end of inline markup", () => {
    const plan = setup("<p>Hello <strong>world</strong> tail</p>");
    const p = plan.querySelector("p")!;
    const strong = plan.querySelector("strong")!;
    const anchor = captureRange(rangeOver(p.firstChild!, 0, strong, 1), plan)!;
    expect(anchor).not.toBeNull();
    expect(anchor.quote).toBe("Hello world");
    expect(anchor.startOffset).toBe(0);
    expect(anchor.endOffset).toBe(11);
  });

  test("an element boundary after the last child counts the whole subtree", () => {
    const plan = setup("<p>one <em>two</em></p>");
    const p = plan.querySelector("p")!;
    const anchor = captureRange(rangeOver(p.firstChild!, 0, p, 2), plan)!;
    expect(anchor.quote).toBe("one two");
  });

  test("a selection across two blocks trims to the start block", () => {
    const plan = setup("<p>first block</p><p>second block</p>");
    const paragraphs = plan.querySelectorAll("p");
    const anchor = captureRange(
      rangeOver(paragraphs[0]!.firstChild!, 6, paragraphs[1]!.firstChild!, 0),
      plan,
    )!;
    expect(anchor).not.toBeNull();
    expect(anchor.selector).toBe("p:nth-of-type(1)");
    expect(anchor.quote).toBe("block");
  });

  test("refuses a collapsed or whitespace selection", () => {
    const plan = setup("<p>a   b</p>");
    const text = plan.querySelector("p")!.firstChild!;
    expect(captureRange(rangeOver(text, 1, text, 1), plan)).toBeNull();
    expect(captureRange(rangeOver(text, 1, text, 4), plan)).toBeNull();
  });
});

describe("restoreAnchor", () => {
  const anchor = (over: Partial<RangeAnchor>): RangeAnchor => ({
    type: "range",
    selector: "p",
    nodePath: [],
    startOffset: 4,
    endOffset: 9,
    quote: "quick",
    ...over,
  });

  test("restores the same segment after a rebuild of the dom", () => {
    const plan = setup("<p>the quick brown fox</p>");
    const segments = restoreAnchor(plan, anchor({}))!;
    expect(segments).toHaveLength(1);
    expect(segments[0]!.node.data.slice(segments[0]!.start, segments[0]!.end)).toBe("quick");
  });

  test("spans several text nodes through inline markup", () => {
    const plan = setup("<p>one <strong>two</strong> three</p>");
    const segments = restoreAnchor(
      plan,
      anchor({ startOffset: 0, endOffset: 13, quote: "one two three" }),
    )!;
    const covered = segments
      .map((s) => s.node.data.slice(s.start, s.end))
      .join("");
    expect(covered).toBe("one two three");
  });

  test("falls back to the quote when offsets drift", () => {
    const plan = setup("<p>NEW WORDS the quick brown fox</p>");
    const segments = restoreAnchor(plan, anchor({}))!;
    expect(segments[0]!.node.data.slice(segments[0]!.start, segments[0]!.end)).toBe("quick");
  });

  test("returns null when the quote is gone", () => {
    const plan = setup("<p>totally different words</p>");
    expect(restoreAnchor(plan, anchor({}))).toBeNull();
  });

  test("returns null for a missing element or a bad selector", () => {
    const plan = setup("<ul><li>x</li></ul>");
    expect(restoreAnchor(plan, anchor({}))).toBeNull();
    expect(restoreAnchor(plan, anchor({ selector: ":::nope" }))).toBeNull();
  });
});
