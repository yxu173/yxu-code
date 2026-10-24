import { sanitize, span, width, wrap, type Line, type Span } from "./text.ts";
import type { Glyphs, Style } from "./theme.ts";

/** Inline markup: `code`, **bold**. Everything else is literal. */
export function inline(text: string, base: Style = { fg: "ivory" }): Span[] {
  const out: Span[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(span(text.slice(last, m.index), base));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(span(tok.slice(1, -1), { ...base, fg: "cyan" }));
    else out.push(span(tok.slice(2, -2), { ...base, bold: true }));
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(span(text.slice(last), base));
  return out.length ? out : [span("", base)];
}

/**
 * Render markdown-ish assistant text into rows of width `w`.
 * Supports fenced code, headings, bullet/numbered lists, block quotes, inline code and bold.
 */
export function renderMarkdown(text: string, w: number, g: Glyphs, base: Style = { fg: "ivory" }): Line[] {
  const rows: Line[] = [];
  const src = sanitize(text).split("\n");
  let inCode = false;
  let blank = 0;

  for (const raw of src) {
    const fence = /^\s*```\s*([\w+.-]*)\s*$/.exec(raw);
    if (fence) {
      if (!inCode) {
        inCode = true;
        rows.push([span(`${g.tl}${g.h} `, { fg: "faint" }), span(fence[1] || "code", { fg: "faint" })]);
      } else {
        inCode = false;
        rows.push([span(`${g.bl}${g.h}`, { fg: "faint" })]);
      }
      blank = 0;
      continue;
    }

    if (inCode) {
      const gutter: Line = [span(`${g.v} `, { fg: "faint" })];
      const code = raw.length ? raw : " ";
      // Code keeps its spacing: hard-wrap by cells instead of word-wrapping.
      const cw = Math.max(4, w - width(`${g.v} `));
      let chunk = "";
      let used = 0;
      const flush = () => {
        rows.push([...gutter, span(chunk, { fg: "dim" })]);
        chunk = "";
        used = 0;
      };
      for (const ch of code) {
        const chw = width(ch);
        if (used + chw > cw) flush();
        chunk += ch;
        used += chw;
      }
      flush();
      continue;
    }

    if (!raw.trim()) {
      // Collapse runs of blank lines to one.
      if (blank++ === 0 && rows.length) rows.push([]);
      continue;
    }
    blank = 0;

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      rows.push(...wrap(inline(heading[2]!, { ...base, bold: true }), w));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      const bar: Line = [span(`${g.v} `, { fg: "violet" })];
      rows.push(...wrap([...bar, ...inline(quote[1]!, { fg: "dim" })], w, bar));
      continue;
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      const depth = Math.min(3, Math.floor(bullet[1]!.length / 2));
      const marker = /\d/.test(bullet[2]!) ? bullet[2]! : g.dot;
      const lead = "  ".repeat(depth);
      const head: Line = [span(`${lead}${marker} `, { fg: "dim" })];
      const indent: Line = [span(" ".repeat(width(`${lead}${marker} `)))];
      rows.push(...wrap([...head, ...inline(bullet[3]!, base)], w, indent));
      continue;
    }

    rows.push(...wrap(inline(raw.trimEnd(), base), w));
  }
  if (inCode) rows.push([span(`${g.bl}${g.h}`, { fg: "faint" })]); // unterminated fence (streaming)
  while (rows.length && rows.at(-1)!.length === 0) rows.pop();
  return rows;
}
