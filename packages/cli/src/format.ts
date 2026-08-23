// Round and verdict formatting for the agent transcript. The output is
// plain lines: a header, one numbered instruction per line with its
// anchor context, the next step, and how to answer.

interface WireInstruction {
  words: string;
  author: { name: string };
  anchor: { type: string; quote?: string; selector?: string };
}

export interface WireRound {
  status: "round";
  round: number;
  instructions: WireInstruction[];
  next_step: string;
  verdict?: string;
  session_ended?: boolean;
  ended_by?: string;
}

export interface WireEnded {
  status: "ended";
  ended_by: string;
  verdict?: string;
}

function anchorContext(anchor: WireInstruction["anchor"]): string {
  if (anchor.type === "range" && anchor.quote) return `on the text: "${anchor.quote}"`;
  if (anchor.type === "stamp" && anchor.selector) return `on the block: ${anchor.selector}`;
  return "";
}

export function formatRound(round: WireRound): string {
  const lines: string[] = [];
  lines.push(`== Round ${round.round} ==`);
  round.instructions.forEach((instruction, index) => {
    lines.push(`${index + 1}. [${instruction.author.name}] ${instruction.words}`);
    const context = anchorContext(instruction.anchor);
    if (context) lines.push(`   ${context}`);
  });
  if (round.next_step) lines.push(`Next step: ${round.next_step}`);
  if (round.verdict) lines.push(`Verdict: ${round.verdict}`);
  if (round.session_ended) {
    lines.push(`The review has ended (by ${round.ended_by ?? "user"}).`);
  } else {
    lines.push(`Apply the instructions, then run: peanut reply "<what you did>"`);
  }
  return lines.join("\n");
}

export function formatEnded(ended: WireEnded): string {
  const verdict = ended.verdict ?? "end";
  return `== Review ended ==\nVerdict: ${verdict} (by ${ended.ended_by})`;
}

export function isApproved(result: WireRound | WireEnded): boolean {
  return result.verdict === "approve";
}
