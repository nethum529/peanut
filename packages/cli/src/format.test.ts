import { describe, expect, test } from "bun:test";
import { formatEnded, formatRound } from "./format.ts";

describe("formatRound", () => {
  test("prints instructions with authors and anchor context", () => {
    const text = formatRound({
      status: "round",
      round: 2,
      instructions: [
        {
          words: "Cap the backoff.",
          author: { name: "Nethum" },
          anchor: { type: "range", quote: "retry forever" },
        },
        {
          words: "Split this section.",
          author: { name: "Sam" },
          anchor: { type: "stamp", selector: "p:nth-of-type(3)" },
        },
        {
          words: "Rework this block.",
          author: { name: "Sam" },
          anchor: { type: "stamp", selector: "p:nth-of-type(4)", guard: "cap the backoff" },
        },
      ],
      next_step: "Reload the page after your edit.",
    });
    expect(text).toContain("== Round 2 ==");
    expect(text).toContain('1. [Nethum] Cap the backoff.');
    expect(text).toContain('on the text: "retry forever"');
    expect(text).toContain("2. [Sam] Split this section.");
    expect(text).toContain("on the block: p:nth-of-type(3)");
    expect(text).toContain("3. [Sam] Rework this block.");
    expect(text).toContain('on the block: "cap the backoff"');
    expect(text).toContain("Next step: Reload the page after your edit.");
    expect(text).toContain('peanut reply');
  });

  test("a final round with a verdict says the review ended", () => {
    const text = formatRound({
      status: "round",
      round: 3,
      instructions: [],
      next_step: "",
      verdict: "approve",
      session_ended: true,
      ended_by: "user",
    });
    expect(text).toContain("Verdict: approve");
    expect(text).toContain("ended");
    expect(text).not.toContain("peanut reply");
  });

  test("a bare approve reads as no instructions plus the ended line", () => {
    const text = formatRound({
      status: "round",
      round: 3,
      instructions: [],
      next_step: "",
      verdict: "approve",
      session_ended: true,
      ended_by: "user",
    });
    expect(text).toContain("No new instructions.");
    expect(text).toContain("Verdict: approve");
    expect(text).toContain("The review has ended (by user).");
    expect(text).not.toContain("peanut reply");
  });

  test("a bare open round says there are no instructions", () => {
    const text = formatRound({
      status: "round",
      round: 2,
      instructions: [],
      next_step: "",
      verdict: "request_changes",
    });
    expect(text).toContain("No new instructions.");
    expect(text).toContain("Verdict: request_changes");
    expect(text).toContain('Answer with: peanut reply "<your answer>"');
    expect(text).not.toContain("Apply the instructions");
  });
});

describe("formatEnded", () => {
  test("prints the verdict and who ended", () => {
    expect(formatEnded({ status: "ended", ended_by: "user", verdict: "approve" })).toBe(
      "== Review ended ==\nVerdict: approve (by user)",
    );
    expect(formatEnded({ status: "ended", ended_by: "user" })).toContain("Verdict: end");
  });
});
