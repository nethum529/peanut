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
      ],
      next_step: "Reload the page after your edit.",
    });
    expect(text).toContain("== Round 2 ==");
    expect(text).toContain('1. [Nethum] Cap the backoff.');
    expect(text).toContain('on the text: "retry forever"');
    expect(text).toContain("2. [Sam] Split this section.");
    expect(text).toContain("on the block: p:nth-of-type(3)");
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
});

describe("formatEnded", () => {
  test("prints the verdict and who ended", () => {
    expect(formatEnded({ status: "ended", ended_by: "user", verdict: "approve" })).toBe(
      "== Review ended ==\nVerdict: approve (by user)",
    );
    expect(formatEnded({ status: "ended", ended_by: "user" })).toContain("Verdict: end");
  });
});
