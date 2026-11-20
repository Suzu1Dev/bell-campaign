export type InlineSpan =
  | { type: "text"; text: string }
  | { type: "bold"; children: InlineSpan[] }
  | { type: "italic"; children: InlineSpan[] }
  | { type: "code"; text: string }
  | { type: "link"; label: string; href: string };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; spans: InlineSpan[] }
  | { type: "hr" }
  | { type: "code"; lang: string; content: string }
  | { type: "blockquote"; lines: InlineSpan[][] }
  | { type: "table"; headers: InlineSpan[][]; alignments: Array<"left" | "center" | "right">; rows: InlineSpan[][][] }
  | { type: "list"; ordered: boolean; items: Array<{ checked: boolean | null; spans: InlineSpan[] }> }
  | { type: "paragraph"; spans: InlineSpan[] };

const SAFE_URL_RE = /^(?:https?:\/\/|\/(?![\/\\])|#)/i;

export function isSafeMarkdownUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return SAFE_URL_RE.test(trimmed);
}

export function parseInlineMarkdown(input: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // Matches `code`, **bold**, *italic*, or [label](url)
  const tokenRe = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(input)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ type: "text", text: input.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      spans.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      spans.push({ type: "bold", children: parseInlineMarkdown(token.slice(2, -2)) });
    } else if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
      spans.push({ type: "italic", children: parseInlineMarkdown(token.slice(1, -1)) });
    } else if (token.startsWith("[")) {
      const m = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(token);
      if (m && isSafeMarkdownUrl(m[2])) {
        spans.push({ type: "link", label: m[1], href: m[2].trim() });
      } else if (m) {
        spans.push({ type: "text", text: m[1] });
      } else {
        spans.push({ type: "text", text: token });
      }
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < input.length) {
    spans.push({ type: "text", text: input.slice(lastIndex) });
  }
  return spans.length > 0 ? spans : [{ type: "text", text: "" }];
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseTableSeparator(line: string): Array<"left" | "center" | "right"> | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;
  const aligns: Array<"left" | "center" | "right"> = [];
  for (const c of cells) {
    if (!/^:?-{2,}:?$/.test(c)) return null;
    if (c.startsWith(":") && c.endsWith(":")) aligns.push("center");
    else if (c.endsWith(":")) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = /^```([^\s`]*)/.exec(trimmed);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // Headings (# to ####)
    const headMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headMatch) {
      const level = headMatch[1].length as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, spans: parseInlineMarkdown(headMatch[2].trim()) });
      i += 1;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: InlineSpan[][] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(parseInlineMarkdown(lines[i].trim().replace(/^>\s?/, "")));
        i += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // GFM Table
    if (trimmed.includes("|") && i + 1 < lines.length) {
      const alignments = parseTableSeparator(lines[i + 1]);
      if (alignments) {
        const headerCells = splitTableRow(trimmed).map((c) => parseInlineMarkdown(c));
        const rows: InlineSpan[][][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim().includes("|") && !/^```/.test(lines[i].trim())) {
          const rowCells = splitTableRow(lines[i]).map((c) => parseInlineMarkdown(c));
          rows.push(rowCells);
          i += 1;
        }
        blocks.push({ type: "table", headers: headerCells, alignments, rows });
        continue;
      }
    }

    // Unordered / Task list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: Array<{ checked: boolean | null; spans: InlineSpan[] }> = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const rawItem = lines[i].trim().replace(/^[-*+]\s+/, "");
        const checkMatch = /^\[( |x|X)\]\s+(.*)$/.exec(rawItem);
        if (checkMatch) {
          items.push({
            checked: checkMatch[1].toLowerCase() === "x",
            spans: parseInlineMarkdown(checkMatch[2]),
          });
        } else {
          items.push({ checked: null, spans: parseInlineMarkdown(rawItem) });
        }
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: Array<{ checked: boolean | null; spans: InlineSpan[] }> = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const rawItem = lines[i].trim().replace(/^\d+\.\s+/, "");
        items.push({ checked: null, spans: parseInlineMarkdown(rawItem) });
        i += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // Paragraph (collect consecutive plain lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s+|```|>\s?|[-*+]\s+|\d+\.\s+|(?:---|\*\*\*|___)\s*$)/.test(lines[i].trim()) &&
      !(lines[i].trim().includes("|") && i + 1 < lines.length && parseTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", spans: parseInlineMarkdown(paraLines.join(" ")) });
    } else {
      i += 1;
    }
  }

  return blocks;
}
