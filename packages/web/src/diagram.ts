const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_NODES = 10;
const NODE_GAP = 40;
const BASE_RANK_GAP = 88;
const LABEL_GAP = 10;
const NODE_LINE_HEIGHT = 19;
const EDGE_LINE_HEIGHT = 16;

export type DiagramDirection = "down" | "right";

export interface DiagramNode {
  id: string;
  label: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramDeclaration {
  direction: DiagramDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagramBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramNodeLayout extends DiagramNode, DiagramBounds {
  lines: string[];
  rank: number;
}

export interface DiagramEdgeLayout extends DiagramEdge {
  points: Array<{ x: number; y: number }>;
  labelBounds?: DiagramBounds;
  labelLines: string[];
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: DiagramNodeLayout[];
  edges: DiagramEdgeLayout[];
}

interface AxisSize {
  primary: number;
  cross: number;
}

interface MeasuredLabel extends DiagramBounds {
  lines: string[];
}

// This renderer is intentionally limited to directed layered flows.
// Sequence, state, and class diagrams are out of scope.
export function wrapDiagramText(value: string, limit: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const original of words) {
    let word = original;
    if (line && line.length + word.length + 1 > limit) {
      lines.push(line);
      line = "";
    }
    while (word.length > limit) {
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (!word) continue;
    if (!line || line.length + word.length + 1 <= limit) line = line ? `${line} ${word}` : word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function assignDiagramRanks(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): Map<string, number> | null {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id || ids.has(node.id)) return null;
    ids.add(node.id);
  }
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) return null;
    outgoing.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }

  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    visited += 1;
    for (const target of outgoing.get(id)!) {
      ranks.set(target, Math.max(ranks.get(target)!, ranks.get(id)! + 1));
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  return visited === nodes.length ? ranks : null;
}

function measureNode(node: DiagramNode, rank: number): DiagramNodeLayout {
  const lines = wrapDiagramText(node.label, 22);
  const widest = Math.max(...lines.map((line) => line.length), 1);
  return {
    ...node,
    rank,
    lines,
    x: 0,
    y: 0,
    width: Math.max(112, Math.min(212, widest * 8 + 36)),
    height: Math.max(52, lines.length * NODE_LINE_HEIGHT + 28),
  };
}

function measureLabel(label: string | undefined): MeasuredLabel | null {
  if (!label?.trim()) return null;
  const lines = wrapDiagramText(label, 28);
  const widest = Math.max(...lines.map((line) => line.length), 1);
  return {
    lines,
    x: 0,
    y: 0,
    width: Math.min(212, widest * 7 + 16),
    height: lines.length * EDGE_LINE_HEIGHT + 8,
  };
}

function axisSize(bounds: DiagramBounds, direction: DiagramDirection): AxisSize {
  return direction === "down"
    ? { primary: bounds.height, cross: bounds.width }
    : { primary: bounds.width, cross: bounds.height };
}

function boundsFromAxis(
  primary: number,
  cross: number,
  size: AxisSize,
  direction: DiagramDirection,
): DiagramBounds {
  return direction === "down"
    ? { x: cross, y: primary, width: size.cross, height: size.primary }
    : { x: primary, y: cross, width: size.primary, height: size.cross };
}

function pointFromAxis(primary: number, cross: number, direction: DiagramDirection) {
  return direction === "down" ? { x: cross, y: primary } : { x: primary, y: cross };
}

function nodeAxis(node: DiagramNodeLayout, direction: DiagramDirection) {
  return direction === "down"
    ? { start: node.y, end: node.y + node.height, center: node.x + node.width / 2 }
    : { start: node.x, end: node.x + node.width, center: node.y + node.height / 2 };
}

export function layoutDiagram(declaration: DiagramDeclaration): DiagramLayout | null {
  const { direction, edges } = declaration;
  if (!declaration.nodes.length || declaration.nodes.length > MAX_NODES) return null;
  if (direction !== "down" && direction !== "right") return null;
  if (declaration.nodes.some((node) => !node.label.trim())) return null;
  const rankMap = assignDiagramRanks(declaration.nodes, edges);
  if (!rankMap) return null;

  const nodes = declaration.nodes.map((node) => measureNode(node, rankMap.get(node.id)!));
  const rankCount = Math.max(...nodes.map((node) => node.rank)) + 1;
  const ranks = Array.from({ length: rankCount }, () => [] as DiagramNodeLayout[]);
  for (const node of nodes) ranks[node.rank]!.push(node);
  const rankSizes = ranks.map((rank): AxisSize => {
    const sizes = rank.map((node) => axisSize(node, direction));
    return {
      primary: Math.max(...sizes.map((size) => size.primary)),
      cross: sizes.reduce((sum, size) => sum + size.cross, 0) + NODE_GAP * Math.max(0, rank.length - 1),
    };
  });

  const edgeLabels = new Map(edges.map((edge) => [edge, measureLabel(edge.label)]));
  const adjacentLabels = Array.from({ length: Math.max(0, rankCount - 1) }, () => [] as DiagramEdge[]);
  const longEdges: DiagramEdge[] = [];
  for (const edge of edges) {
    const span = rankMap.get(edge.to)! - rankMap.get(edge.from)!;
    if (span === 1 && edgeLabels.get(edge)) adjacentLabels[rankMap.get(edge.from)!]!.push(edge);
    if (span > 1) longEdges.push(edge);
  }
  const bands = adjacentLabels.map((group) => {
    const labelSpace = group.reduce(
      (sum, edge) => sum + axisSize(edgeLabels.get(edge)!, direction).primary,
      0,
    );
    return Math.max(BASE_RANK_GAP, labelSpace + LABEL_GAP * (group.length + 1));
  });
  const labels = [...edgeLabels.values()].filter(Boolean) as MeasuredLabel[];
  const centralCross = Math.max(
    ...rankSizes.map((size) => size.cross),
    ...labels.map((label) => axisSize(label, direction).cross + 32),
  );
  const labelCross = Math.max(0, ...labels.map((label) => axisSize(label, direction).cross));
  const outer = Math.max(32, labelCross / 2 + 16);
  const longLaneSizes = longEdges.map((edge) =>
    Math.max(
      28,
      (edgeLabels.get(edge) ? axisSize(edgeLabels.get(edge)!, direction).cross : 0) + LABEL_GAP,
    ),
  );
  const gutterBuffer = longEdges.length ? labelCross + LABEL_GAP : 0;
  const gutterCross = gutterBuffer + longLaneSizes.reduce((sum, size) => sum + size, 0);

  const rankStarts: number[] = [];
  let primaryCursor = 32;
  for (let rank = 0; rank < rankCount; rank += 1) {
    rankStarts.push(primaryCursor);
    primaryCursor += rankSizes[rank]!.primary + (bands[rank] ?? 0);
  }
  for (let rank = 0; rank < rankCount; rank += 1) {
    let crossCursor = outer + (centralCross - rankSizes[rank]!.cross) / 2;
    for (const node of ranks[rank]!) {
      const size = axisSize(node, direction);
      Object.assign(
        node,
        boundsFromAxis(
          rankStarts[rank]! + (rankSizes[rank]!.primary - size.primary) / 2,
          crossCursor,
          size,
          direction,
        ),
      );
      crossCursor += size.cross + NODE_GAP;
    }
  }

  const adjacentLane = new Map<DiagramEdge, number>();
  for (let rank = 0; rank < adjacentLabels.length; rank += 1) {
    const group = adjacentLabels[rank]!;
    const total = group.reduce(
      (sum, edge) => sum + axisSize(edgeLabels.get(edge)!, direction).primary,
      LABEL_GAP * Math.max(0, group.length - 1),
    );
    let cursor = rankStarts[rank]! + rankSizes[rank]!.primary + (bands[rank]! - total) / 2;
    for (const edge of group) {
      const size = axisSize(edgeLabels.get(edge)!, direction);
      adjacentLane.set(edge, cursor + size.primary / 2);
      cursor += size.primary + LABEL_GAP;
    }
  }
  const longLane = new Map<DiagramEdge, number>();
  let longCursor = outer + centralCross + gutterBuffer;
  longEdges.forEach((edge, index) => {
    longLane.set(edge, longCursor + longLaneSizes[index]! / 2);
    longCursor += longLaneSizes[index]!;
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const laidEdges = edges.map((edge): DiagramEdgeLayout => {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const fromAxis = nodeAxis(from, direction);
    const toAxis = nodeAxis(to, direction);
    const fromRank = rankMap.get(edge.from)!;
    const toRank = rankMap.get(edge.to)!;
    const label = edgeLabels.get(edge);
    let points: Array<{ x: number; y: number }>;
    let labelCenter: { primary: number; cross: number } | undefined;

    if (toRank - fromRank === 1) {
      const lane = adjacentLane.get(edge) ?? (fromAxis.end + toAxis.start) / 2;
      points = [
        pointFromAxis(fromAxis.end, fromAxis.center, direction),
        pointFromAxis(lane, fromAxis.center, direction),
        pointFromAxis(lane, toAxis.center, direction),
        pointFromAxis(toAxis.start, toAxis.center, direction),
      ];
      labelCenter = label
        ? { primary: lane, cross: (fromAxis.center + toAxis.center) / 2 }
        : undefined;
    } else {
      const lane = longLane.get(edge)!;
      const exit = rankStarts[fromRank]! + rankSizes[fromRank]!.primary + 20;
      const entry = rankStarts[toRank]! - 20;
      points = [
        pointFromAxis(fromAxis.end, fromAxis.center, direction),
        pointFromAxis(exit, fromAxis.center, direction),
        pointFromAxis(exit, lane, direction),
        pointFromAxis(entry, lane, direction),
        pointFromAxis(entry, toAxis.center, direction),
        pointFromAxis(toAxis.start, toAxis.center, direction),
      ];
      labelCenter = label ? { primary: (exit + entry) / 2, cross: lane } : undefined;
    }
    const labelSize = label ? axisSize(label, direction) : null;
    const labelBounds =
      label && labelCenter && labelSize
        ? boundsFromAxis(
            labelCenter.primary - labelSize.primary / 2,
            labelCenter.cross - labelSize.cross / 2,
            labelSize,
            direction,
          )
        : undefined;
    return { ...edge, points, labelBounds, labelLines: label?.lines ?? [] };
  });

  const totalPrimary = primaryCursor + 32;
  const totalCross = outer * 2 + centralCross + gutterCross;
  return {
    width: direction === "down" ? totalCross : totalPrimary,
    height: direction === "down" ? totalPrimary : totalCross,
    nodes,
    edges: laidEdges,
  };
}

export function parseDiagramBlock(block: HTMLElement): DiagramDeclaration | null {
  if (block.dataset.peanutDiagram !== "flow") return null;
  const direction = block.dataset.direction ?? "down";
  if (direction !== "down" && direction !== "right") return null;
  const source = block.querySelector<HTMLElement>("[data-peanut-diagram-source]");
  if (!source) return null;
  const nodes = [...source.querySelectorAll<HTMLElement>("[data-node]")].map((node) => ({
    id: node.dataset.node?.trim() ?? "",
    label: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  const edges = [...source.querySelectorAll<HTMLElement>("[data-edge]")].map((edge) => ({
    from: edge.dataset.from?.trim() ?? "",
    to: edge.dataset.to?.trim() ?? "",
    ...(edge.dataset.label?.trim() ? { label: edge.dataset.label.trim() } : {}),
  }));
  return { direction, nodes, edges };
}

function svgElement<K extends keyof SVGElementTagNameMap>(document: Document, tag: K) {
  return document.createElementNS(SVG_NS, tag);
}

function setAttributes(node: Element, attributes: Record<string, string>): void {
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
}

function renderText(
  document: Document,
  parent: SVGElement,
  lines: string[],
  bounds: DiagramBounds,
  className: string,
  lineHeight: number,
): void {
  const text = svgElement(document, "text");
  text.setAttribute("class", className);
  const firstY = bounds.y + bounds.height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((words, index) => {
    const line = svgElement(document, "tspan");
    setAttributes(line, {
      x: String(bounds.x + bounds.width / 2),
      y: String(firstY + index * lineHeight),
    });
    line.textContent = words;
    text.append(line);
  });
  parent.append(text);
}

let diagramSequence = 0;

export function renderDiagramBlock(block: HTMLElement): boolean {
  block.querySelector(":scope > .peanut-diagram-canvas")?.remove();
  delete block.dataset.peanutDiagramRendered;
  delete block.dataset.peanutDiagramInvalid;
  const declaration = parseDiagramBlock(block);
  const layout = declaration ? layoutDiagram(declaration) : null;
  if (!layout) {
    block.dataset.peanutDiagramInvalid = "true";
    return false;
  }

  const document = block.ownerDocument;
  const svg = svgElement(document, "svg");
  setAttributes(svg, {
    class: "peanut-diagram-canvas",
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    "aria-hidden": "true",
    focusable: "false",
  });
  svg.style.minWidth = `${layout.width}px`;

  const markerId = `peanut-diagram-arrow-${++diagramSequence}`;
  const defs = svgElement(document, "defs");
  const marker = svgElement(document, "marker");
  setAttributes(marker, {
    id: markerId,
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "7",
    markerHeight: "7",
    orient: "auto",
  });
  const arrow = svgElement(document, "path");
  setAttributes(arrow, { class: "peanut-diagram-arrow", d: "M 0 0 L 10 5 L 0 10 z" });
  marker.append(arrow);
  defs.append(marker);
  svg.append(defs);

  const connectors = svgElement(document, "g");
  connectors.setAttribute("class", "peanut-diagram-connectors");
  for (const edge of layout.edges) {
    const [first, ...rest] = edge.points;
    const path = svgElement(document, "path");
    setAttributes(path, {
      d: `M ${first!.x} ${first!.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(" ")}`,
      "marker-end": `url(#${markerId})`,
    });
    connectors.append(path);
    if (!edge.labelBounds) continue;
    const background = svgElement(document, "rect");
    setAttributes(background, {
      class: "peanut-diagram-label-background",
      x: String(edge.labelBounds.x),
      y: String(edge.labelBounds.y),
      width: String(edge.labelBounds.width),
      height: String(edge.labelBounds.height),
      rx: "4",
    });
    connectors.append(background);
    renderText(
      document,
      connectors,
      edge.labelLines,
      edge.labelBounds,
      "peanut-diagram-edge-label",
      EDGE_LINE_HEIGHT,
    );
  }
  svg.append(connectors);

  const nodeGroup = svgElement(document, "g");
  nodeGroup.setAttribute("class", "peanut-diagram-nodes");
  for (const node of layout.nodes) {
    const box = svgElement(document, "rect");
    setAttributes(box, {
      class: "peanut-diagram-node",
      x: String(node.x),
      y: String(node.y),
      width: String(node.width),
      height: String(node.height),
      rx: "12",
    });
    nodeGroup.append(box);
    renderText(document, nodeGroup, node.lines, node, "peanut-diagram-node-label", NODE_LINE_HEIGHT);
  }
  svg.append(nodeGroup);
  block.prepend(svg);
  block.dataset.peanutDiagramRendered = "true";
  return true;
}

export function renderDiagramBlocks(document: Document): void {
  for (const block of document.querySelectorAll<HTMLElement>("[data-peanut-diagram]")) {
    try {
      renderDiagramBlock(block);
    } catch {
      block.querySelector(":scope > .peanut-diagram-canvas")?.remove();
      delete block.dataset.peanutDiagramRendered;
      block.dataset.peanutDiagramInvalid = "true";
    }
  }
}
