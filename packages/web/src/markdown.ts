// A small markdown renderer for the plan view. Every piece of input text
// is escaped before it reaches the output, so raw HTML in a plan can
// never execute. Only http and https links become anchors.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

function safeHref(url: string, kind: "link" | "image" = "link"): string | null {
  if (/^https?:\/\//i.test(url)) return url;
  if (kind === "image" && /^data:image\/png;base64,[a-z\d+/]*={0,2}$/i.test(url)) return url;
  if (kind === "image" && !/^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  return null;
}

function renderImage(alt: string, source: string): string {
  const src = safeHref(source, "image");
  if (!src) return escapeHtml(alt);
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
}

function blockImage(line: string): RegExpMatchArray | null {
  return line.match(/^\s*!\[([^\]]*)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)\s*$/);
}

// Inline pass: code spans first so their content stays literal, then
// images and links, then bold and italic.
function renderInline(text: string): string {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const code = rest.match(/`([^`]+)`/);
    if (!code || code.index === undefined) {
      parts.push(renderSpans(rest));
      break;
    }
    parts.push(renderSpans(rest.slice(0, code.index)));
    parts.push(`<code>${escapeHtml(code[1]!)}</code>`);
    rest = rest.slice(code.index + code[0].length);
  }
  return parts.join("");
}

function renderSpans(text: string): string {
  let out = "";
  let rest = text;
  while (rest.length > 0) {
    const span = rest.match(
      /!\[([^\]]*)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)|\[([^\]]+)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)/,
    );
    if (!span || span.index === undefined) {
      out += renderEmphasis(rest);
      break;
    }
    out += renderEmphasis(rest.slice(0, span.index));
    if (span[1] !== undefined) {
      out += renderImage(span[1], span[2]!);
    } else {
      const href = safeHref(span[4]!);
      if (href) {
        out += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${renderEmphasis(span[3]!)}</a>`;
      } else {
        out += renderEmphasis(span[3]!);
      }
    }
    rest = rest.slice(span.index + span[0].length);
  }
  return out;
}

function renderEmphasis(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

type TableAlignment = "left" | "right" | "center" | null;

function tableCells(line: string): string[] | null {
  let row = line.trim();
  if (!row.includes("|")) return null;
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function tableAlignments(line: string, columns: number): TableAlignment[] | null {
  const cells = tableCells(line);
  if (!cells || cells.length !== columns) return null;

  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    alignments.push(
      cell.startsWith(":") && cell.endsWith(":")
        ? "center"
        : cell.endsWith(":")
          ? "right"
          : cell.startsWith(":")
            ? "left"
            : null,
    );
  }
  return alignments;
}

function tableStart(lines: string[], index: number): {
  header: string[];
  alignments: TableAlignment[];
} | null {
  const header = tableCells(lines[index] ?? "");
  if (!header || index + 1 >= lines.length) return null;
  const alignments = tableAlignments(lines[index + 1]!, header.length);
  return alignments ? { header, alignments } : null;
}

function tableCell(tag: "th" | "td", text: string, alignment: TableAlignment): string {
  const style = alignment ? ` style="text-align: ${alignment}"` : "";
  return `<${tag}${style}>${renderInline(text)}</${tag}>`;
}

type ListKind = "ul" | "ol";

interface ListLine {
  kind: ListKind;
  level: number;
  number: number;
  text: string;
}

function horizontalRule(line: string): boolean {
  return /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
}

function indentLevel(indent: string): number {
  let level = 0;
  let spaces = 0;
  for (const character of indent) {
    if (character === "\t") {
      level += Math.floor(spaces / 2) + 1;
      spaces = 0;
    } else {
      spaces += 1;
    }
  }
  return level + Math.floor(spaces / 2);
}

function parseListLine(line: string): ListLine | null {
  if (horizontalRule(line)) return null;
  const match = line.match(/^([ \t]*)([-*]|(\d+)[.)])\s+(.*)$/);
  if (!match) return null;
  return {
    kind: match[3] === undefined ? "ul" : "ol",
    level: indentLevel(match[1]!),
    number: match[3] === undefined ? 1 : Number(match[3]),
    text: match[4]!,
  };
}

function listItemContent(item: ListLine): string {
  const task = item.kind === "ul" ? item.text.match(/^\[([ xX])\]\s+(.*)$/) : null;
  if (!task) return renderInline(item.text);
  const checked = task[1]!.toLowerCase() === "x" ? " checked" : "";
  return `<label><input type="checkbox" disabled${checked}> ${renderInline(task[2]!)}</label>`;
}

function renderList(lines: string[], start: number): { html: string; next: number } | null {
  const first = parseListLine(lines[start] ?? "");
  if (!first) return null;

  const items: ListLine[] = [];
  const baseLevel = first.level;
  let next = start;
  while (next < lines.length) {
    const item = parseListLine(lines[next]!);
    if (!item) break;
    const relativeLevel = Math.max(0, item.level - baseLevel);
    const previousLevel = items.at(-1)?.level ?? 0;
    item.level = Math.min(relativeLevel, previousLevel + 1);
    items.push(item);
    next += 1;
  }

  let cursor = 0;
  const renderLevel = (level: number, kind: ListKind): string => {
    const firstItem = items[cursor]!;
    const startAttribute = kind === "ol" && firstItem.number !== 1 ? ` start="${firstItem.number}"` : "";
    let html = `<${kind}${startAttribute}>`;
    let expectedNumber = firstItem.number;

    while (cursor < items.length) {
      const item = items[cursor]!;
      if (item.level !== level || item.kind !== kind) break;
      const valueAttribute = kind === "ol" && item.number !== expectedNumber ? ` value="${item.number}"` : "";
      expectedNumber = item.number + 1;
      html += `<li${valueAttribute}>${listItemContent(item)}`;
      cursor += 1;
      while (cursor < items.length && items[cursor]!.level > level) {
        html += renderLevel(items[cursor]!.level, items[cursor]!.kind);
      }
      html += "</li>";
    }

    return `${html}</${kind}>`;
  };

  let html = "";
  while (cursor < items.length) html += renderLevel(items[cursor]!.level, items[cursor]!.kind);
  return { html, next };
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const image = blockImage(line);
    if (image) {
      const rendered = renderImage(image[1]!, image[2]!);
      out.push(rendered.startsWith("<img ") ? rendered : `<p>${rendered}</p>`);
      index += 1;
      continue;
    }

    const fence = line.match(/^```/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }

    if (horizontalRule(line)) {
      out.push("<hr>");
      index += 1;
      continue;
    }

    const list = renderList(lines, index);
    if (list) {
      out.push(list.html);
      index = list.next;
      continue;
    }

    const table = tableStart(lines, index);
    if (table) {
      const header = table.header
        .map((cell, column) => tableCell("th", cell, table.alignments[column]!))
        .join("");
      const rows: string[] = [];
      index += 2;
      while (index < lines.length) {
        const cells = tableCells(lines[index]!);
        if (!cells || lines[index]!.trim() === "") break;
        const row = table.alignments
          .map((alignment, column) => tableCell("td", cells[column] ?? "", alignment))
          .join("");
        rows.push(`<tr>${row}</tr>`);
        index += 1;
      }
      out.push(`<table><thead><tr>${header}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const next = lines[index]!.match(/^>\s?(.*)$/);
        if (!next) break;
        quoted.push(next[1]!);
        index += 1;
      }
      out.push(`<blockquote><p>${renderInline(quoted.join(" "))}</p></blockquote>`);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^(#{1,6}\s|```|>|\|)/.test(lines[index]!) &&
      !horizontalRule(lines[index]!) &&
      !parseListLine(lines[index]!) &&
      !blockImage(lines[index]!) &&
      !tableStart(lines, index)
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}
