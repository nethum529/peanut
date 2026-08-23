// Range anchor capture and restore for the rendered plan.
//
// The wire format is selector + nodePath + offsets + quote. This client
// anchors with character offsets over the anchor element's whole text
// content and sends an empty nodePath. Element text offsets survive a
// markdown re-render better than child node indexes, and the quote is
// the guard: when the text at the offsets no longer matches, restore
// fails and the instruction is kept in the unanchored list.

export interface RangeAnchor {
  type: "range";
  selector: string;
  nodePath: number[];
  startOffset: number;
  endOffset: number;
  quote: string;
}

// A five part nth-of-type path, capped at the first ancestor with an id.
export function selectorFor(element: Element, root: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== root && parts.length < 5) {
    const tag = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${tag}#${node.id}`);
      break;
    }
    let part = tag;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((child) => child.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

function elementFor(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}

function textNodesUnder(element: Element): Text[] {
  const nodes: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      nodes.push(node as Text);
      return;
    }
    for (const child of [...node.childNodes]) walk(child);
  };
  walk(element);
  return nodes;
}

// The character offset of a (node, offset) boundary inside element,
// counted over the concatenation of the element's text nodes.
function charOffset(element: Element, node: Node, offset: number): number | null {
  let total = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    for (const text of textNodesUnder(element)) {
      if (text === node) return total + offset;
      total += text.data.length;
    }
    return null;
  }
  // An element boundary: count the text before the child at offset.
  const children = [...node.childNodes];
  const boundary = children[offset] ?? null;
  for (const text of textNodesUnder(element)) {
    if (boundary && boundary.contains(text)) return total;
    if (!boundary && !node.contains(text)) return total;
    total += text.data.length;
  }
  return boundary ? null : total;
}

export function captureRange(range: Range, root: Element): RangeAnchor | null {
  if (range.collapsed) return null;
  const ancestor = elementFor(range.commonAncestorContainer);
  if (!ancestor || !root.contains(ancestor)) return null;
  // Anchor to a direct block of the plan when possible, so the
  // selector stays short and stable.
  const selector = selectorFor(ancestor, root);
  if (!selector) return null;
  const start = charOffset(ancestor, range.startContainer, range.startOffset);
  const end = charOffset(ancestor, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const quote = (ancestor.textContent ?? "").slice(start, end);
  if (!quote.trim()) return null;
  return { type: "range", selector, nodePath: [], startOffset: start, endOffset: end, quote };
}

export interface RestoredSegment {
  node: Text;
  start: number;
  end: number;
}

// Restore returns the text node segments the anchor covers, or null
// when the anchor no longer matches the content.
export function restoreAnchor(root: Element, anchor: RangeAnchor): RestoredSegment[] | null {
  let element: Element | null = null;
  try {
    element = anchor.selector ? root.querySelector(anchor.selector) : null;
  } catch {
    return null;
  }
  if (!element) return null;
  const text = element.textContent ?? "";
  let start = anchor.startOffset;
  let end = anchor.endOffset;
  if (text.slice(start, end) !== anchor.quote) {
    // The offsets drifted; fall back to the first occurrence of the
    // quote inside the same element.
    const found = text.indexOf(anchor.quote);
    if (found === -1 || !anchor.quote) return null;
    start = found;
    end = found + anchor.quote.length;
  }
  const segments: RestoredSegment[] = [];
  let total = 0;
  for (const node of textNodesUnder(element)) {
    const nodeStart = total;
    const nodeEnd = total + node.data.length;
    total = nodeEnd;
    const from = Math.max(start, nodeStart);
    const to = Math.min(end, nodeEnd);
    if (from < to) segments.push({ node, start: from - nodeStart, end: to - nodeStart });
  }
  return segments.length > 0 ? segments : null;
}
