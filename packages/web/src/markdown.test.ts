import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
import { restoreStamp, selectorFor, stampGuard } from "./anchors.ts";
import { renderMarkdown } from "./markdown.ts";
import { stampTarget } from "./overlay.ts";

const SYNTAX_TOKENS = ["keyword", "string", "number", "comment", "punctuation"] as const;

function cssVariable(rules: string, name: string): string {
  return rules.match(new RegExp(`--${name}:\\s*(#[\\da-f]+)`, "i"))?.[1] ?? "";
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

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

  test("renders child bullets at the right depth for three levels", () => {
    expect(renderMarkdown("- parent\n  - child\n    - grandchild\n- sibling")).toBe(
      "<ul><li>parent<ul><li>child<ul><li>grandchild</li></ul></li></ul></li>" +
        "<li>sibling</li></ul>",
    );
  });

  test("uses two spaces or one tab per level and rounds odd spaces down", () => {
    expect(renderMarkdown("- root\n   - odd child\n\t\t- tab grandchild")).toBe(
      "<ul><li>root<ul><li>odd child<ul><li>tab grandchild</li></ul></li></ul></li></ul>",
    );
  });

  test("keeps list type and numbering at each nested level", () => {
    expect(renderMarkdown("3. outer\n  1. first child\n  2. second child\n4. sibling")).toBe(
      '<ol start="3"><li>outer<ol><li>first child</li><li>second child</li></ol></li>' +
        "<li>sibling</li></ol>",
    );
    expect(renderMarkdown("- bullet\n  2. ordered\n    - deep bullet")).toBe(
      '<ul><li>bullet<ol start="2"><li>ordered<ul><li>deep bullet</li></ul></li></ol></li></ul>',
    );
    expect(renderMarkdown("1. ordered\n  - bullet\n    4. deep ordered")).toBe(
      '<ol><li>ordered<ul><li>bullet<ol start="4"><li>deep ordered</li></ol></li></ul></li></ol>',
    );
  });

  test("renders checked and unchecked task items as disabled checkboxes", () => {
    const html = renderMarkdown("- [ ] check **this**\n- [x] completed");
    expect(html).toBe(
      '<ul><li><label><input type="checkbox" disabled> check <strong>this</strong></label></li>' +
        '<li><label><input type="checkbox" disabled checked> completed</label></li></ul>',
    );

    const window = new Window();
    window.document.body.innerHTML = html;
    const boxes = window.document.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.hasAttribute("disabled")).toBe(true);
    expect(boxes[0]!.hasAttribute("checked")).toBe(false);
    expect(boxes[1]!.hasAttribute("disabled")).toBe(true);
    expect(boxes[1]!.hasAttribute("checked")).toBe(true);
  });

  test("renders horizontal rules before list or table detection", () => {
    expect(renderMarkdown("---\n* * *\n____")).toBe("<hr>\n<hr>\n<hr>");
    expect(renderMarkdown("| Rule |\n|---|\n| kept |")).toBe(
      "<table><thead><tr><th>Rule</th></tr></thead><tbody><tr><td>kept</td></tr></tbody></table>",
    );
  });

  test("starts a list after a paragraph without a blank line", () => {
    expect(renderMarkdown("paragraph\n- item")).toBe("<p>paragraph</p>\n<ul><li>item</li></ul>");
  });

  test("nested items, tasks, and rules produce pin targets with restorable anchors", () => {
    const window = new Window();
    const document = window.document;
    (globalThis as Record<string, unknown>).Node = window.Node;
    document.body.innerHTML = renderMarkdown("- root\n  - nested\n- [ ] task\n\n---");
    const root = document.body as unknown as HTMLElement;
    const candidates = [
      root.querySelector("ul ul li"),
      root.querySelector("label"),
      root.querySelector("hr"),
    ];

    for (const candidate of candidates) {
      expect(candidate).not.toBeNull();
      const target = stampTarget(root, candidate);
      expect(target).not.toBeNull();
      const selector = selectorFor(target!, root);
      expect(
        restoreStamp(root, { type: "stamp", selector, guard: stampGuard(target!) }),
      ).toBe(target);
    }
  });

  test("renders fenced code blocks literally", () => {
    expect(renderMarkdown("```\nconst x = 1 < 2;\n```")).toBe(
      "<pre><code>const x = 1 &lt; 2;</code></pre>",
    );
  });

  test("highlights each token type in a tagged TypeScript block", () => {
    const rendered = renderMarkdown(
      '```ts\nconst message: string = "safe" + 42; // keep literal\n```',
    );
    for (const token of SYNTAX_TOKENS) {
      expect(rendered).toContain(`class="syntax-${token}"`);
    }
  });

  test("supports the deliberately short language and alias list", () => {
    const examples = [
      ["typescript", "const value = 1", "keyword"],
      ["js", "return 'ok'", "string"],
      ["javascript", "true", "keyword"],
      ["json", '{\"ready\": true}', "string"],
      ["sh", "# note", "comment"],
      ["shell", "if ready; then", "keyword"],
      ["bash", "echo 42", "number"],
      ["html", "<main>text</main>", "keyword"],
      ["css", "color: #fff", "keyword"],
      ["py", "def run():", "keyword"],
      ["python", "return None", "keyword"],
      ["md", "# Read `this`", "string"],
      ["markdown", "<!-- note -->", "comment"],
    ] as const;

    for (const [language, source, token] of examples) {
      expect(renderMarkdown(`\`\`\`${language}\n${source}\n\`\`\``)).toContain(
        `class="syntax-${token}"`,
      );
    }
  });

  test("keeps comment markers inside strings and shell parameters", () => {
    const javascript = renderMarkdown(
      '```js\nconst url = "https://example.com"; /* "one comment" */\n```',
    );
    expect(javascript.match(/class="syntax-string"/g)).toHaveLength(1);
    expect(javascript.match(/class="syntax-comment"/g)).toHaveLength(1);

    const shell = renderMarkdown("```sh\necho $# # one comment\n```");
    expect(shell.match(/class="syntax-comment"/g)).toHaveLength(1);
  });

  test("leaves unknown and untagged code blocks unchanged", () => {
    const plain = "<pre><code>const x = &quot;&lt;x&gt;&quot;;</code></pre>";
    expect(renderMarkdown('```\nconst x = "<x>";\n```')).toBe(plain);
    expect(renderMarkdown('```rust\nconst x = "<x>";\n```')).toBe(plain);
  });

  test("keeps HTML, quotes, and angle brackets literal after highlighting", () => {
    const source = `const html = "<img src='x'>"; // <script>alert(1)</script>`;
    const rendered = renderMarkdown(`\`\`\`ts\n${source}\n\`\`\``);
    const window = new Window();
    window.document.body.innerHTML = rendered;
    const code = window.document.querySelector("code")!;

    expect(code.querySelector("img")).toBeNull();
    expect(code.querySelector("script")).toBeNull();
    expect(code.textContent).toBe(source);
  });

  test("highlights about 200 lines quickly", () => {
    const source = Array.from(
      { length: 200 },
      (_, index) => `const item${index}: string = "<value>"; // line ${index}`,
    ).join("\n");
    const started = performance.now();
    const rendered = renderMarkdown(`\`\`\`ts\n${source}\n\`\`\``);

    expect(performance.now() - started).toBeLessThan(250);
    expect(rendered.match(/class="syntax-comment"/g)).toHaveLength(200);
  });

  test("keeps a highlighted block anchorable and preserves copied text", () => {
    const source = 'const value = "copy me";';
    const window = new Window();
    window.document.body.innerHTML = renderMarkdown(`\`\`\`ts\n${source}\n\`\`\``);
    const pre = window.document.querySelector("pre")! as unknown as HTMLElement;
    const token = pre.querySelector("span")! as unknown as EventTarget;

    expect(window.document.querySelectorAll("pre")).toHaveLength(1);
    expect(stampTarget(window.document.body as unknown as HTMLElement, token)).toBe(pre);
    expect(pre.textContent).toBe(source);
  });

  test("keeps every syntax color above 4.5 to 1 contrast in both themes", async () => {
    const css = await Bun.file(new URL("../public/overlay.css", import.meta.url)).text();
    const dark = css.match(/html,\s*html\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    const light = css.match(/html\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] ?? "";

    for (const rules of [dark, light]) {
      const background = cssVariable(rules, "document-code-background");
      expect(background).not.toBe("");
      for (const token of SYNTAX_TOKENS) {
        const color = cssVariable(rules, `document-syntax-${token}`);
        expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
        expect(css).toContain(`.syntax-${token} { color: var(--document-syntax-${token}); }`);
      }
    }
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

  test("renders an image on its own line as a block", () => {
    expect(renderMarkdown("before\n![Login screen](shot.png)\nafter")).toBe(
      '<p>before</p>\n<img src="shot.png" alt="Login screen">\n<p>after</p>',
    );
  });

  test("renders images inline in paragraphs and list items", () => {
    expect(renderMarkdown("Open ![Login screen](https://example.com/shot.png) now")).toBe(
      '<p>Open <img src="https://example.com/shot.png" alt="Login screen"> now</p>',
    );
    expect(renderMarkdown("- Open ![Login screen](shot.png) now")).toBe(
      '<ul><li>Open <img src="shot.png" alt="Login screen"> now</li></ul>',
    );
  });

  test("renders unsafe image sources as plain alt text", () => {
    expect(renderMarkdown("![bad](javascript:alert(1))")).toBe("<p>bad</p>");
    expect(renderMarkdown("![also bad](data:text/html,<script>alert(1)</script>)")).toBe(
      "<p>also bad</p>",
    );
  });

  test("renders a PNG data URI image", () => {
    const source = "data:image/png;base64,iVBORw0KGgo=";
    expect(renderMarkdown(`![pixel](${source})`)).toBe(`<img src="${source}" alt="pixel">`);
  });

  test("renders an empty alt attribute for a decorative image", () => {
    expect(renderMarkdown("![](shot.png)")).toBe('<img src="shot.png" alt="">');
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
