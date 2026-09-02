import { DESIGN_BLOCK_NAMES as BLOCK } from "./design.ts";

export const PLAYBOOK_IDS = [
  "plan",
  "comparison",
  "table",
  "diagram",
  "code",
  "decision",
  "report",
] as const;

export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

interface Playbook {
  description: string;
  guidance: string;
}

const DIAGRAM_DEFAULT = `Lead with a diagram when explaining how something works, how data or control moves, or the order of a plan. Use one for a flow, a step sequence, components that communicate, or a before and after. Use prose only for reasoning, trade-offs, and open questions the diagram cannot show. Skip it for a flat list of facts, a single decision, or a short note. Keep one idea and about 7 nodes at most. Split a larger diagram in two.`;

const PLAYBOOKS: Record<PlaybookId, Playbook> = {
  plan: {
    description: "Lay out ordered work, checks, and completion criteria.",
    guidance: `# Plan playbook

Use this shape to explain how work will move from the current state to a clear result.

${DIAGRAM_DEFAULT}

Length ceiling: 450 visible words. Cut background that does not change a step or dependency first.

## Blocks to use
- Lead with one focused diagram of the plan's order.
- Use a ${BLOCK.section} for the goal and scope, then a ${BLOCK.card} for each phase.
- Use a ${BLOCK.decisionRow} for choices that must be settled before work continues.
- Add a ${BLOCK.callout} for the largest risk or dependency.

## Avoid
- Do not mix goals with implementation steps.
- Do not use vague steps such as "finish the feature."
- Do not hide validation in the final paragraph.

## Small example
### Add retry limits
[Limit attempts] -> [Log final failure] -> [Run timeout tests]

Checks: the fourth attempt never starts, the log includes the request ID, and every retry test passes.`,
  },
  comparison: {
    description: "Compare options against the same useful criteria.",
    guidance: `# Comparison playbook

Use this shape when a reviewer must see meaningful differences between two or more options.

Length ceiling: 350 visible words. Cut criteria that do not affect the choice first.

## Blocks to use
- Start with a ${BLOCK.section} that names the choice and its constraints.
- Use a ${BLOCK.comparisonTable} with one criterion per row and one option per column.
- Put important context that does not fit the table in a short ${BLOCK.card}.
- End with a ${BLOCK.decisionRow} for the recommended option and its reason.

## Avoid
- Do not compare options with different criteria.
- Do not fill cells with long prose.
- Do not hide a preferred option behind neutral wording.

## Small example
| Criterion | Queue | Direct call |
| --- | --- | --- |
| Failure isolation | Strong | Weak |
| Setup cost | Medium | Low |

Decision: use a queue because failure isolation is required.`,
  },
  table: {
    description: "Present structured facts that readers need to scan.",
    guidance: `# Table playbook

Use this shape for repeated facts that share the same fields and need quick lookup.

Length ceiling: 250 visible words. Cut rows that do not support lookup or a decision first.

## Blocks to use
- Use a ${BLOCK.section} to state what the rows represent.
- Put the data in a ${BLOCK.comparisonTable} with short, specific headers.
- Add a ${BLOCK.callout} for exceptions, units, or missing values.
- Use a ${BLOCK.decisionRow} only when the table supports a choice.

## Avoid
- Do not use a table for a sequence or a long argument.
- Do not combine two facts in one cell.
- Do not leave symbols or abbreviations unexplained.

## Small example
| Endpoint | Limit | Window |
| --- | ---: | --- |
| Create room | 20 | 1 minute |
| Add note | 100 | 1 minute |

Callout: limits apply per user.`,
  },
  diagram: {
    description: "Show a flow, relationship, or boundary visually.",
    guidance: `# Diagram playbook

${DIAGRAM_DEFAULT}

Length ceiling: 180 visible words. Cut prose that repeats the diagram first.

## Blocks to use
- Lead with one diagram in a ${BLOCK.section} that names its question.
- Add a ${BLOCK.callout} for a boundary, exception, or asynchronous step.
- Follow with a ${BLOCK.decisionRow} if the diagram supports a design choice.

## Avoid
- Do not use color as the only way to convey meaning.
- Do not leave arrows or abbreviations without labels.

## Small example
\`\`\`mermaid
flowchart LR
  Request --> Validate
  Validate -->|valid| Save
  Validate -->|invalid| Error
\`\`\`

Callout: Save runs only after validation succeeds.`,
  },
  code: {
    description: "Explain a code change with only the context under review.",
    guidance: `# Code playbook

Use this shape to review an implementation detail, interface, or behavior expressed in code.

Length ceiling: 300 visible words. Cut unchanged setup and line-by-line narration first.

## Blocks to use
- Start with a ${BLOCK.section} that states the behavior and relevant constraint.
- Use ${BLOCK.annotatedCode} for the smallest complete excerpt.
- Put assumptions or safety concerns in a ${BLOCK.callout}.
- Use a ${BLOCK.decisionRow} when the reviewer must choose an API or pattern.

## Avoid
- Do not paste a full file when a short excerpt is enough.
- Do not repeat what each line already says.
- Do not omit the expected result or failure case.

## Small example
\`\`\`ts
const attempts = Math.min(requestedAttempts, 3); // Enforce the service limit.
await retry(task, attempts);
\`\`\`

Expected result: no request starts more than three attempts.`,
  },
  decision: {
    description: "Record a choice, its reasons, and its consequences.",
    guidance: `# Decision playbook

Use this shape when a choice needs review now and must remain understandable later.

Length ceiling: 300 visible words. Cut history that did not affect the choice first.

## Blocks to use
- Open with a ${BLOCK.section} that states the decision and current status.
- Use a ${BLOCK.comparisonTable} for the options and decisive criteria.
- For an open choice, use one ${BLOCK.questionBlock} with a stable, unique \`data-peanut-question\` key. Mark and preselect one suggested option, add a final "Write my own" radio option with its text field, and give the question one submit button.
- Never send on a radio change. Send only on submit. Show what is selected separately from whether an answer was sent.
- For a settled choice, keep the outcome, reason, and owner in a static ${BLOCK.decisionRow}.
- Add a ${BLOCK.callout} for consequences that are costly to reverse.

## Avoid
- Do not present a decision without alternatives.
- Do not list criteria that had no effect on the choice.
- Do not omit follow-up work.

## Small example
Decision: store sessions in temporary files.
Reason: one later CLI process must resume the same review.
Consequence: the file must stay outside the repository.
Follow-up: remove it when the review ends.`,
  },
  report: {
    description: "Summarize findings, evidence, and next actions.",
    guidance: `# Report playbook

Use this shape to explain what was examined, what was found, and what should happen next.

Length ceiling: 600 visible words. Cut low-impact findings and repeated evidence first.

## Blocks to use
- Use a ${BLOCK.section} for each of scope, findings, and next actions.
- Put each major finding in a ${BLOCK.card} with evidence and impact.
- Use a ${BLOCK.comparisonTable} for repeated measurements.
- Add a ${BLOCK.callout} for urgent risk and a ${BLOCK.decisionRow} for each requested choice.

## Avoid
- Do not mix observed facts with assumptions.
- Do not give every finding the same priority.
- Do not end without an owner or next action.

## Small example
### Finding: retry failures are silent
Evidence: 4 of 4 timeout tests produced no final error log.
Impact: operators cannot trace failed requests.
Next action: log the request ID after the last attempt. Owner: API team.`,
  },
};

export function getPlaybook(id: string): string | undefined {
  return PLAYBOOKS[id as PlaybookId]?.guidance;
}

export function formatPlaybookList(): string {
  const lines = PLAYBOOK_IDS.map((id) => `  ${id}: ${PLAYBOOKS[id].description}`);
  return ["Available playbooks:", ...lines].join("\n");
}

export function formatUnknownPlaybook(id: string): string {
  return `Unknown playbook "${id}". Valid ids: ${PLAYBOOK_IDS.join(", ")}`;
}
