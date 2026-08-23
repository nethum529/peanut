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
  // The boundary sits before children[offset], or at the end of node
  // when offset points past the last child.
  const children = [...node.childNodes];
  const boundary = children[offset] ?? null;
  for (const text of textNodesUnder(element)) {
    if (boundary) {
      if (boundary === text || boundary.contains(text)) return total;
      if (boundary.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) return total;
    } else {
      const position = node.compareDocumentPosition(text);
      if (
        position & Node.DOCUMENT_POSITION_FOLLOWING &&
        !(position & Node.DOCUMENT_POSITION_CONTAINED_BY)
      ) {
        return total;
      }
    }
    total += text.data.length;
  }
  return total;
}

// The direct child of root that holds node, or null.
function blockOf(node: Node, root: Element): Element | null {
  let block = elementFor(node);
  while (block && block !== root && block.parentElement !== root) {
    block = block.parentElement;
  }
  return block && block !== root ? block : null;
}

export function captureRange(range: Range, root: Element): RangeAnchor | null {
  if (range.collapsed) return null;
  let ancestor = elementFor(range.commonAncestorContainer);
  if (!ancestor || !root.contains(ancestor)) return null;
  let workRange = range;
  if (ancestor === root) {
    // A selection across blocks trims to the block that holds the
    // start. The common triple click shape ends at the start of the
    // next block, so the trim keeps what the reviewer sees selected.
    const startNode =
      range.startContainer === root
        ? (root.childNodes[range.startOffset] ?? null)
        : range.startContainer;
    const block = startNode ? blockOf(startNode, root) : null;
    if (!block) return null;
    workRange = range.cloneRange();
    workRange.setEnd(block, block.childNodes.length);
    ancestor = block;
  }
  const selector = selectorFor(ancestor, root);
  if (!selector) return null;
  const start = charOffset(ancestor, workRange.startContainer, workRange.startOffset);
  const end = charOffset(ancestor, workRange.endContainer, workRange.endOffset);
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
