import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import {
  assignDiagramRanks,
  layoutDiagram,
  renderDiagramBlock,
  type DiagramBounds,
  type DiagramDeclaration,
} from "./diagram.ts";

const knownFlow: DiagramDeclaration = {
  direction: "down",
  nodes: [
    { id: "request", label: "Request" },
    { id: "validate", label: "Validate" },
    { id: "save", label: "Save" },
    { id: "reject", label: "Reject" },
    { id: "notify", label: "Notify" },
  ],
  edges: [
    { from: "request", to: "validate", label: "received" },
    { from: "validate", to: "save", label: "valid" },
    { from: "validate", to: "reject", label: "invalid" },
    { from: "save", to: "notify", label: "stored" },
    { from: "reject", to: "notify", label: "explained" },
    { from: "request", to: "notify", label: "audit trail" },
  ],
};

function overlaps(first: DiagramBounds, second: DiagramBounds): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

function pointIsOnEdge(
  point: { x: number; y: number },
  path: Array<{ x: number; y: number }>,
): boolean {
  return path.slice(1).some((end, index) => {
    const start = path[index]!;
    if (start.x === end.x && point.x === start.x) {
      return point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y);
    }
    if (start.y === end.y && point.y === start.y) {
      return point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x);
    }
    return false;
  });
}

describe("diagram layout", () => {
  test("assigns each node to the rank after all of its predecessors", () => {
    const ranks = assignDiagramRanks(knownFlow.nodes, knownFlow.edges);
    expect(Object.fromEntries(ranks!)).toEqual({
      request: 0,
      validate: 1,
      save: 2,
      reject: 2,
      notify: 3,
    });
  });

  test("places the known graph without overlapping node boxes", () => {
    const layout = layoutDiagram(knownFlow)!;
    for (let first = 0; first < layout.nodes.length; first += 1) {
      for (let second = first + 1; second < layout.nodes.length; second += 1) {
        expect(overlaps(layout.nodes[first]!, layout.nodes[second]!)).toBe(false);
      }
    }
  });

  test("places labels on connectors without touching nodes or other labels", () => {
    const layout = layoutDiagram(knownFlow)!;
    const labels = layout.edges.filter((edge) => edge.labelBounds);
    for (const edge of labels) {
      const bounds = edge.labelBounds!;
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      expect(pointIsOnEdge(center, edge.points)).toBe(true);
      expect(layout.nodes.some((node) => overlaps(bounds, node))).toBe(false);
    }
    for (let first = 0; first < labels.length; first += 1) {
      for (let second = first + 1; second < labels.length; second += 1) {
        expect(overlaps(labels[first]!.labelBounds!, labels[second]!.labelBounds!)).toBe(false);
      }
    }
  });

  test("wraps long node text and grows its box in both directions", () => {
    const longNode = "Validate the complete incoming request before saving any account changes";
    for (const direction of ["down", "right"] as const) {
      const layout = layoutDiagram({
        direction,
        nodes: [
          { id: "start", label: "Start" },
          { id: "validate", label: longNode },
        ],
        edges: [{ from: "start", to: "validate" }],
      })!;
      const node = layout.nodes.find((item) => item.id === "validate")!;
      expect(node.lines.length).toBeGreaterThan(1);
      expect(node.height).toBeGreaterThan(52);
      expect(node.lines.join(" ")).toBe(longNode);
    }
  });
});

describe("diagram declaration", () => {
  test("keeps a malformed relationship readable instead of rendering broken SVG", () => {
    const win = new HappyWindow();
    win.document.body.innerHTML = `<figure data-peanut-diagram="flow" data-direction="right">
      <figcaption>Release flow</figcaption>
      <div data-peanut-diagram-source>
        <ul><li data-node="draft">Draft</li></ul>
        <ul><li data-edge data-from="draft" data-to="missing">Draft to Missing</li></ul>
      </div>
    </figure>`;
    const block = win.document.querySelector("figure") as unknown as HTMLElement;

    expect(() => renderDiagramBlock(block)).not.toThrow();
    expect(block.dataset.peanutDiagramInvalid).toBe("true");
    expect(block.dataset.peanutDiagramRendered).toBeUndefined();
    expect(block.querySelector("svg")).toBeNull();
    expect(block.textContent).toContain("Draft to Missing");
  });

  test("renders a valid declaration while preserving its readable source", () => {
    const win = new HappyWindow();
    win.document.body.innerHTML = `<figure data-peanut-diagram="flow">
      <figcaption>Release flow</figcaption>
      <div data-peanut-diagram-source>
        <ul><li data-node="draft">Draft</li><li data-node="ship">Ship</li></ul>
        <ul><li data-edge data-from="draft" data-to="ship">Draft to Ship</li></ul>
      </div>
    </figure>`;
    const block = win.document.querySelector("figure") as unknown as HTMLElement;

    expect(block.textContent).toContain("Draft to Ship");
    expect(renderDiagramBlock(block)).toBe(true);
    expect(block.dataset.peanutDiagramRendered).toBe("true");
    expect(block.querySelectorAll(".peanut-diagram-node")).toHaveLength(2);
    expect(block.querySelector(".peanut-diagram-canvas")?.getAttribute("aria-hidden")).toBe("true");
    expect(block.querySelector("[data-peanut-diagram-source]")?.textContent).toContain("Draft to Ship");
  });
});
