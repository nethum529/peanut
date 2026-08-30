export interface DesignBuildingBlock {
  name: string;
  selector: string;
  purpose: string;
}

export interface DesignReference {
  css: string;
  diagram: string;
  buildingBlocks: DesignBuildingBlock[];
}

export const DESIGN_BLOCK_NAMES = {
  section: "section",
  card: "card",
  decisionRow: "decision row",
  comparisonTable: "comparison table",
  annotatedCode: "annotated code",
  callout: "callout",
} as const;

const CSS_STARTING_POINT = `:root {
  color-scheme: light;
  --page: #f7f6f2;
  --surface: #ffffff;
  --ink: #20201d;
  --muted: #6b6a63;
  --line: #deddd6;
  --accent: #6b4eff;
  --accent-soft: #eeebff;
  --good: #267a54;
  --radius: 14px;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font-size: 16px;
  line-height: 1.6;
}

.review-document {
  width: min(100% - 32px, 920px);
  margin-inline: auto;
  padding-block: 48px 80px;
}

.review-section { margin-block: 48px; }

.review-section > header {
  max-width: 680px;
  margin-block-end: 20px;
}

.review-section h2 { margin: 0 0 8px; line-height: 1.2; }
.review-section header p { margin: 0; color: var(--muted); }

.card {
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.decision-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.7fr) minmax(0, 1.8fr) auto;
  gap: 16px;
  align-items: start;
  padding-block: 16px;
  border-block-end: 1px solid var(--line);
}

.decision-row:last-child { border-block-end: 0; }
.decision-row .decision { font-weight: 700; }
.decision-row .reason { color: var(--muted); }
.decision-row .status { color: var(--good); font-weight: 700; }

.comparison-table {
  overflow-x: auto;
}

.comparison-table table {
  width: 100%;
  min-width: 36rem;
  border-collapse: collapse;
  background: var(--surface);
}

.comparison-table th,
.comparison-table td {
  padding: 12px 16px;
  border: 1px solid var(--line);
  text-align: start;
  vertical-align: top;
}

.comparison-table th { background: var(--accent-soft); }

.annotated-code {
  overflow-x: auto;
  padding: 20px;
  border-radius: var(--radius);
  background: #20201d;
  color: #f7f6f2;
  font: 0.9rem/1.65 ui-monospace, SFMono-Regular, Consolas, monospace;
}

.code-note { color: #c7bbff; font-weight: 700; }

.callout {
  padding: 16px 18px;
  border-inline-start: 4px solid var(--accent);
  background: var(--accent-soft);
}

.diagram {
  overflow-x: auto;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.diagram svg {
  display: block;
  width: 100%;
  min-width: 520px;
  height: auto;
  margin-inline: auto;
}

@media (max-width: 40rem) {
  .review-document { width: min(100% - 24px, 920px); padding-block-start: 28px; }
  .decision-row { grid-template-columns: 1fr; gap: 4px; }
  .card { padding: 18px; }
}`;

const DIAGRAM_SNIPPET = `<figure class="diagram">
  <svg viewBox="0 0 640 180" role="img" aria-labelledby="review-flow-title">
    <title id="review-flow-title">Review flow from draft to decision</title>
    <defs>
      <marker id="review-arrow" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
      </marker>
    </defs>
    <g fill="none" stroke="currentColor" stroke-width="2">
      <path d="M 180 90 H 280" marker-end="url(#review-arrow)" />
      <path d="M 400 90 H 500" marker-end="url(#review-arrow)" />
    </g>
    <g fill="var(--surface)" stroke="var(--accent)" stroke-width="2">
      <rect x="20" y="50" width="160" height="80" rx="14" />
      <rect x="280" y="50" width="120" height="80" rx="14" />
      <rect x="500" y="50" width="120" height="80" rx="14" />
    </g>
    <g fill="currentColor" text-anchor="middle" font-family="system-ui" font-size="16">
      <text x="100" y="96">Draft</text>
      <text x="340" y="96">Review</text>
      <text x="560" y="96">Decision</text>
    </g>
  </svg>
  <figcaption>Keep labels in the SVG so the diagram remains understandable offline.</figcaption>
</figure>`;

export const DESIGN_REFERENCE: DesignReference = {
  css: CSS_STARTING_POINT,
  diagram: DIAGRAM_SNIPPET,
  buildingBlocks: [
    {
      name: DESIGN_BLOCK_NAMES.section,
      selector: ".review-section",
      purpose: "Group one review topic under a clear heading and short introduction.",
    },
    {
      name: DESIGN_BLOCK_NAMES.card,
      selector: ".card",
      purpose: "Contain a focused example, summary, or related group of details.",
    },
    {
      name: DESIGN_BLOCK_NAMES.decisionRow,
      selector: ".decision-row",
      purpose: "Connect a choice with its reason and current status.",
    },
    {
      name: DESIGN_BLOCK_NAMES.comparisonTable,
      selector: ".comparison-table",
      purpose: "Wrap a table that compares options with the same criteria in each column.",
    },
    {
      name: DESIGN_BLOCK_NAMES.annotatedCode,
      selector: ".annotated-code",
      purpose: "Show only the code needed for review and mark the important lines.",
    },
    {
      name: DESIGN_BLOCK_NAMES.callout,
      selector: ".callout",
      purpose: "Highlight a constraint, risk, open question, or recommended action.",
    },
  ],
};

export function formatDesignReference(reference: DesignReference = DESIGN_REFERENCE): string {
  const buildingBlocks = reference.buildingBlocks
    .map((block) => `- ${block.name} (${block.selector}): ${block.purpose}`)
    .join("\n");

  return [
    "Peanut document design reference",
    "",
    "CSS starting point",
    "```css",
    reference.css,
    "```",
    "",
    "Diagram embed",
    "```html",
    reference.diagram,
    "```",
    "",
    "Building blocks",
    buildingBlocks,
  ].join("\n");
}
