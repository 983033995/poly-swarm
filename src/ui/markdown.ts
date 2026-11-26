/**
 * Minimal zero-dependency XSS-safe Markdown renderer for worker conversation bubbles.
 * Raw HTML is always escaped before controlled markup is emitted.
 */

export function esc(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(raw: string): string {
  const codeTokens: string[] = [];
  // Step 1: Escape raw HTML first, then extract inline code spans from the escaped string?
  // Wait: backticks are unaffected by esc(), whereas content inside `...` MUST be escaped
  // and must NOT be transformed by bold/italic/@mention/tag rules.
  // Doing esc() first handles `<`, `>`, `&`, `"`, `'`; then extracting `...` puts the
  // already-escaped code slice safely into a placeholder. Note ASCII backtick ` is preserved.
  const escaped = esc(raw);
  const withCodeHolders = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code class="inline-code">${code}</code>`);
    return `\uE000CODE${idx}\uE001`;
  });

  let formatted = withCodeHolders
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w\\*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1<em>$2</em>")
    .replace(
      /\[(review_pass|review_fail|done|blocked|update|brief|stall)\]/g,
      '<span class="md-tag md-tag-$1">[$1]</span>',
    )
    .replace(
      /(^|[^a-zA-Z0-9._-])(@[a-zA-Z0-9#_-]{2,32})/g,
      '$1<span class="md-mention">$2</span>',
    )
    .replace(
      /(^|[^a-zA-Z0-9._@&-])#(\d{1,7})\b/g,
      '$1<button type="button" class="md-seq-ref" data-action="scroll-seq" data-seq="$2">#$2</button>',
    );

  formatted = formatted.replace(/\uE000CODE(\d+)\uE001/g, (_m, idxStr: string) => {
    return codeTokens[Number(idxStr)] ?? "";
  });
  return formatted;
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function renderBlocksFromLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Check placeholder-only fenced code block line
    const fenceMatch = trimmed.match(/^\uE000FENCE(\d+)\uE001$/);
    if (fenceMatch) {
      html.push(trimmed);
      i += 1;
      continue;
    }

    // Headings: # .. ####
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      html.push(`<div class="md-h md-h-${level}">${renderInline(headingMatch[2]!)}</div>`);
      i += 1;
      continue;
    }

    // Blockquotes
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quoteLines.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      html.push(
        `<blockquote class="md-quote">${quoteLines.map((l) => renderInline(l)).join("<br />")}</blockquote>`,
      );
      continue;
    }

    // Pipe tables
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      const headers = splitTableRow(line);
      i += 2; // skip header & separator
      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i] ?? "";
        if (!rowLine.trim() || !rowLine.includes("|")) break;
        rows.push(splitTableRow(rowLine));
        i += 1;
      }
      const ths = headers.map((h) => `<th>${renderInline(h)}</th>`).join("");
      const trs = rows
        .map(
          (cells) =>
            `<tr>${headers.map((_h, colIdx) => `<td>${renderInline(cells[colIdx] ?? "")}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      html.push(
        `<ul class="md-list">${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      html.push(
        `<ol class="md-list">${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`,
      );
      continue;
    }

    // Paragraph until blank line or block boundary
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      const curTrim = cur.trim();
      if (!curTrim) break;
      if (
        /^\uE000FENCE\d+\uE001$/.test(curTrim) ||
        /^(#{1,4})\s+/.test(cur) ||
        /^>\s?/.test(cur) ||
        /^\s*[-*]\s+/.test(cur) ||
        /^\s*\d+\.\s+/.test(cur) ||
        (cur.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? ""))
      ) {
        break;
      }
      paraLines.push(cur);
      i += 1;
    }
    if (paraLines.length > 0) {
      html.push(`<p class="md-p">${paraLines.map((l) => renderInline(l)).join("<br />")}</p>`);
    }
  }

  return html.join("");
}

/**
 * Renders Markdown text to safe HTML without exposing raw HTML tags.
 */
export function renderMarkdown(source: string): string {
  const input = (source ?? "").replace(/[\uE000\uE001]/g, "");
  if (!input.trim()) return "";

  const fenceBlocks: string[] = [];
  const withFenceHolders = input.replace(
    /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const idx = fenceBlocks.length;
      const cleanCode = code.replace(/\r?\n$/, "");
      const langBar = lang ? `<div class="md-code-lang">${esc(lang)}</div>` : "";
      fenceBlocks.push(
        `<div class="md-code-block">${langBar}<pre class="md-pre"><code>${esc(cleanCode)}</code></pre></div>`,
      );
      return `\n\uE000FENCE${idx}\uE001\n`;
    },
  );

  const rendered = renderBlocksFromLines(withFenceHolders);
  return rendered.replace(/\uE000FENCE(\d+)\uE001/g, (_m, idxStr: string) => {
    return fenceBlocks[Number(idxStr)] ?? "";
  });
}
