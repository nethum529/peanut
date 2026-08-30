import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

describe("renderMarkdown", () => {
  test("renders headings at each level", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("### Deep")).toBe("<h3>Deep</h3>");
  });

  test("joins consecutive lines into one paragraph", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one two</p>\n<p>three</p>");
  });

  test("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("renders fenced code blocks literally", () => {
    expect(renderMarkdown("```\nconst x = 1 < 2;\n```")).toBe(
      "<pre><code>const x = 1 &lt; 2;</code></pre>",
    );
  });

  test("renders inline code and emphasis", () => {
    expect(renderMarkdown("use `a < b` **now** *maybe*")).toBe(
      "<p>use <code>a &lt; b</code> <strong>now</strong> <em>maybe</em></p>",
    );
  });

  test("renders http links and drops unsafe schemes", () => {
    expect(renderMarkdown("[site](https://example.com)")).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noreferrer noopener">site</a></p>',
    );
    const unsafe = renderMarkdown("[bad](javascript:alert(1))");
    expect(unsafe).not.toContain("<a");
    expect(unsafe).toContain("bad");
  });

  test("raw HTML never survives as markup", () => {
    const out = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  test("raw HTML inside headings, lists, and links is escaped", () => {
    expect(renderMarkdown("# <b>hi</b>")).toBe("<h1>&lt;b&gt;hi&lt;/b&gt;</h1>");
    expect(renderMarkdown("- <i>x</i>")).toBe("<ul><li>&lt;i&gt;x&lt;/i&gt;</li></ul>");
    expect(renderMarkdown('[<u>t</u>](https://a.com/"><script>)')).not.toContain("<script");
  });

  test("an unclosed fence consumes to the end without error", () => {
    expect(renderMarkdown("```\ncode")).toBe("<pre><code>code</code></pre>");
  });

  test("renders a plain table with inline formatting in its cells", () => {
    expect(
      renderMarkdown(
        "| Item | Value |\n|---|---|\n| **Width** | `4px` |\n| Height | 56px |",
      ),
    ).toBe(
      "<table><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody>" +
        "<tr><td><strong>Width</strong></td><td><code>4px</code></td></tr>" +
        "<tr><td>Height</td><td>56px</td></tr></tbody></table>",
    );
  });

  test("renders table column alignment", () => {
    expect(renderMarkdown("| Left | Right | Centre |\n|:---|---:|:---:|\n| a | b | c |")).toBe(
      '<table><thead><tr><th style="text-align: left">Left</th>' +
        '<th style="text-align: right">Right</th>' +
        '<th style="text-align: center">Centre</th></tr></thead><tbody>' +
        '<tr><td style="text-align: left">a</td>' +
        '<td style="text-align: right">b</td>' +
        '<td style="text-align: center">c</td></tr></tbody></table>',
    );
  });

  test("keeps a pipe line without a delimiter row as a paragraph", () => {
    expect(renderMarkdown("| not | a | table |\nplain text")).toBe(
      "<p>| not | a | table | plain text</p>",
    );
  });

  test("renders a run of quoted lines as one blockquote", () => {
    expect(renderMarkdown("> Keep **this**\n> and `that`")).toBe(
      "<blockquote><p>Keep <strong>this</strong> and <code>that</code></p></blockquote>",
    );
  });
});
