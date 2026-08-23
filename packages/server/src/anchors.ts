// An anchor is where an instruction points. The server stores it and hands
// it back untouched; resolving it against a DOM happens in the browser.

export interface StampAnchor {
  type: "stamp";
  selector: string;
}

export interface RangeAnchor {
  type: "range";
  selector: string;
  nodePath: number[];
  startOffset: number;
  endOffset: number;
  quote: string;
}

export interface PointAnchor {
  type: "point";
  selector: string;
  x: number;
  y: number;
}

export type Anchor = StampAnchor | RangeAnchor | PointAnchor;

export function parseAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const selector = typeof value.selector === "string" ? value.selector.trim() : "";
  if (!selector || selector.length > 1000) return null;

  switch (value.type) {
    case "stamp":
      return { type: "stamp", selector };
    case "range": {
      const nodePath = value.nodePath;
      if (
        !Array.isArray(nodePath) ||
        nodePath.length > 32 ||
        !nodePath.every((step) => Number.isInteger(step) && step >= 0)
      ) {
        return null;
      }
      const startOffset = value.startOffset;
      const endOffset = value.endOffset;
      if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return null;
      if ((startOffset as number) < 0 || (endOffset as number) < (startOffset as number)) return null;
      const quote = typeof value.quote === "string" ? value.quote : "";
      if (quote.length > 2000) return null;
      return {
        type: "range",
        selector,
        nodePath: nodePath as number[],
        startOffset: startOffset as number,
        endOffset: endOffset as number,
        quote,
      };
    }
    case "point": {
      const { x, y } = value;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      return { type: "point", selector, x, y };
    }
    default:
      return null;
  }
}
