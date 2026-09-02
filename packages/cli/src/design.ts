export interface DesignBuildingBlock {
  name: string;
  selector: string;
  purpose: string;
}

export interface DesignReference {
  css: string;
  diagram: string;
  question: string;
  buildingBlocks: DesignBuildingBlock[];
}

export const DESIGN_BLOCK_NAMES = {
  section: "section",
  card: "card",
  decisionRow: "decision row",
  questionBlock: "question block",
  comparisonTable: "comparison table",
  annotatedCode: "annotated code",
  callout: "callout",
  diagram: "diagram",
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

html[data-theme="dark"] {
  color-scheme: dark;
  --page: #10141b;
  --surface: #171c25;
  --ink: #e6e9ef;
  --muted: #a4abba;
  --line: #2a3140;
  --accent: #a999ff;
  --accent-soft: #27243d;
  --good: #72c99d;
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

.question-block {
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.question-block fieldset { margin: 0; padding: 0; border: 0; }
.question-block legend { margin-block-end: 16px; font-size: 1.15rem; font-weight: 700; }
.question-option { display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; }
.question-option:has(input:checked) { background: var(--accent-soft); }
.question-option input { margin-block-start: 6px; accent-color: var(--accent); }
.suggested { color: var(--accent); font-size: 0.85rem; }
.own-answer { width: 100%; margin-block: 8px 16px; padding: 10px 12px; }
.question-actions { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
.question-actions button { padding: 10px 16px; border: 0; border-radius: 9px; background: var(--accent); color: #fff; font: inherit; font-weight: 700; }
.question-selection, .question-status { margin: 0; color: var(--muted); }
.question-status[data-state="sent"] { color: var(--good); font-weight: 700; }
.question-status[data-state="error"] { color: #a33b32; }

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

const DIAGRAM_SNIPPET = `<figure class="diagram" data-peanut-diagram="flow" data-direction="right">
  <figcaption>Review flow from draft to decision</figcaption>
  <div data-peanut-diagram-source>
    <p><strong>Nodes</strong></p>
    <ul>
      <li data-node="draft">Draft</li>
      <li data-node="review">Review</li>
      <li data-node="decision">Decision</li>
    </ul>
    <p><strong>Relationships</strong></p>
    <ul>
      <li data-edge data-from="draft" data-to="review" data-label="Ready">Draft to Review: Ready</li>
      <li data-edge data-from="review" data-to="decision" data-label="Approved">Review to Decision: Approved</li>
    </ul>
  </div>
</figure>`;

const QUESTION_SNIPPET = `<form class="question-block" data-peanut-question="session-storage">
  <fieldset>
    <legend>Where should review sessions be stored?</legend>
    <label class="question-option">
      <input type="radio" name="session-storage" value="Temporary files" checked />
      <span>Temporary files <strong class="suggested">Suggested</strong></span>
    </label>
    <label class="question-option">
      <input type="radio" name="session-storage" value="Memory only" />
      <span>Memory only</span>
    </label>
    <label class="question-option">
      <input type="radio" name="session-storage" value="own" data-peanut-write-own />
      <span>Write my own</span>
    </label>
    <input class="own-answer" data-peanut-own-answer aria-label="My answer" />
    <div class="question-actions">
      <p class="question-selection" data-peanut-selection-status>Selected: Temporary files</p>
      <button type="submit">Send answer</button>
    </div>
    <p class="question-status" data-peanut-answer-status data-state="idle" aria-live="polite">Not sent.</p>
  </fieldset>
</form>`;

export const DESIGN_REFERENCE: DesignReference = {
  css: CSS_STARTING_POINT,
  diagram: DIAGRAM_SNIPPET,
  question: QUESTION_SNIPPET,
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
      name: DESIGN_BLOCK_NAMES.questionBlock,
      selector: ".question-block",
      purpose: "Let a reviewer answer one open question without leaving the document.",
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
    {
      name: DESIGN_BLOCK_NAMES.diagram,
      selector: "[data-peanut-diagram]",
      purpose: "Declare one directed flow from nodes and relationships without coordinates.",
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
    "Open question block",
    "```html",
    reference.question,
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
