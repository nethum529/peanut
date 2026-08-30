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

function safeHref(url: string): string | null {
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

// Inline pass: code spans first so their content stays literal, then
// links, then bold and italic.
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
    const link = rest.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
    if (!link || link.index === undefined) {
      out += renderEmphasis(rest);
      break;
    }
    out += renderEmphasis(rest.slice(0, link.index));
    const href = safeHref(link[2]!);
    if (href) {
      out += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${renderEmphasis(link[1]!)}</a>`;
    } else {
      out += renderEmphasis(link[1]!);
    }
    rest = rest.slice(link.index + link[0].length);
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

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(/^\s*[-*]\s+(.*)$/);
        if (!item) break;
        items.push(`<li>${renderInline(item[1]!)}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(/^\s*\d+[.)]\s+(.*)$/);
        if (!item) break;
        items.push(`<li>${renderInline(item[1]!)}</li>`);
        index += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
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
      !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+[.)]\s|>|\|)/.test(lines[index]!) &&
      !tableStart(lines, index)
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}
