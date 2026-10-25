import { stringWidth } from "../platform.ts";
import type { Style, Theme } from "./theme.ts";

/** A run of text with one style. Text never contains newlines or ANSI codes. */
export interface Span extends Style {
  text: string;
}

/** One terminal row, as styled spans. */
export type Line = Span[];

export const span = (text: string, style: Style = {}): Span => ({ text, ...style });

export function width(s: string): number {
  return stringWidth(s);
}

export function lineWidth(line: Line): number {
  let w = 0;
  for (const s of line) w += width(s.text);
  return w;
}

export function plain(line: Line): string {
  return line.map((s) => s.text).join("");
}

/** Replace tabs and control characters so they can't break the layout. */
export function sanitize(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // ANSI CSI sequences from tool output
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "") // OSC
    .replace(/\t/g, "  ")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Split into grapheme-ish units (code points; combining marks attach to the previous one). */
function units(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) {
    if (out.length && width(ch) === 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** Cut a line to at most `max` cells, adding an ellipsis when something was removed. */
export function truncate(line: Line, max: number, ellipsis = "…"): Line {
  if (lineWidth(line) <= max) return line;
  const ew = width(ellipsis);
  const budget = Math.max(0, max - ew);
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    let text = "";
    for (const u of units(s.text)) {
      const w = width(u);
      if (used + w > budget) break;
      text += u;
      used += w;
    }
    if (text) out.push({ ...s, text });
    if (used >= budget || text.length < s.text.length) break;
  }
  const last = out.at(-1) ?? line[0] ?? { text: "" };
  if (max >= ew) out.push({ ...last, text: ellipsis });
  return out;
}

export function truncateText(text: string, max: number, ellipsis = "…"): string {
  return plain(truncate([span(text)], max, ellipsis));
}

/** Pad a line with spaces to exactly `w` cells (truncating if longer). */
export function pad(line: Line, w: number, fill: Style = {}): Line {
  const cut = truncate(line, w);
  const missing = w - lineWidth(cut);
  return missing > 0 ? [...cut, { ...fill, text: " ".repeat(missing) }] : cut;
}

/**
 * Word-wrap styled spans to `w` cells. Breaks at spaces when possible, hard-breaks long words.
 * `indent` is prepended to continuation rows (e.g. to align under a label).
 */
export function wrap(spans: Line, w: number, indent: Line = []): Line[] {
  const iw = lineWidth(indent);
  if (w <= iw + 1) return [truncate(spans, Math.max(1, w))];

  // Tokenize into words and spaces, keeping styles.
  type Tok = { text: string; style: Style; space: boolean };
  const toks: Tok[] = [];
  for (const s of spans) {
    const { text, ...style } = s;
    for (const part of text.split(/( +)/)) {
      if (part) toks.push({ text: part, style, space: part.startsWith(" ") });
    }
  }

  const rows: Line[] = [];
  let row: Line = [];
  let used = 0;
  let limit = w;
  let rowStart = 0; // width of the row's indent (0 on the first row)
  const push = (text: string, style: Style) => {
    const prev = row.at(-1);
    if (prev && sameStyle(prev, style)) prev.text += text;
    else row.push({ ...style, text });
    used += width(text);
  };
  const newline = () => {
    rows.push(row);
    row = indent.map((s) => ({ ...s }));
    used = iw;
    rowStart = iw;
    limit = w;
  };

  for (const t of toks) {
    const tw = width(t.text);
    if (t.space) {
      if (used === rowStart) continue; // no leading spaces on a row
      if (used + tw > limit) {
        newline();
        continue;
      }
      push(t.text, t.style);
      continue;
    }
    if (used + tw <= limit) {
      push(t.text, t.style);
      continue;
    }
    // Word doesn't fit: drop trailing space, move to next row, hard-break if still too long.
    trimTrailingSpace(row);
    if (used > rowStart) newline();
    let rest = units(t.text);
    while (rest.length) {
      let chunk = "";
      let cw = 0;
      while (rest.length && cw + width(rest[0]!) <= limit - used) {
        cw += width(rest[0]!);
        chunk += rest.shift();
      }
      if (!chunk) {
        // A single unit wider than the space left (wide char at the edge).
        if (used > rowStart) {
          newline();
          continue;
        }
        chunk = rest.shift()!;
      }
      push(chunk, t.style);
      if (rest.length) newline();
    }
  }
  trimTrailingSpace(row);
  rows.push(row);
  return rows;
}

function trimTrailingSpace(row: Line) {
  const last = row.at(-1);
  if (last) {
    last.text = last.text.replace(/ +$/, "");
    if (!last.text) row.pop();
  }
}

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.inverse === !!b.inverse;
}

/** Wrap multi-line plain text in one style. */
export function wrapText(text: string, w: number, style: Style = {}, indent: Line = []): Line[] {
  const out: Line[] = [];
  for (const para of sanitize(text).split("\n")) {
    out.push(...(para ? wrap([span(para, style)], w, indent) : [[]]));
  }
  return out;
}

/** One-cell ASCII stand-ins for common one-cell punctuation, so ASCII mode never changes widths. */
const ASCII_MAP: Record<string, string> = {
  "·": ".", "•": "*", "—": "-", "–": "-", "−": "-", "…": ".", "→": ">", "←": "<", "↑": "^", "↓": "v",
  "‘": "'", "’": "'", "“": '"', "”": '"', "▍": "_", "✓": "v", "✗": "x", "×": "x",
};

export function asciiFold(text: string): string {
  // Keep wide characters (e.g. CJK) as they are: replacing them would change the layout.
  return text.replace(/[^\x00-\x7f]/g, (ch) => ASCII_MAP[ch] ?? (width(ch) === 1 ? "?" : ch));
}

/** Serialize a row to an ANSI string. Each span carries its full style, so rows are independent. */
export function toAnsi(line: Line, theme: Theme, base: Style = {}): string {
  let out = "";
  for (const s of line) {
    if (!s.text) continue;
    const style: Style = { ...base, ...stripUndefined(s) };
    out += theme.sgr(style) + (theme.ascii ? asciiFold(s.text) : s.text) + theme.reset;
  }
  return out;
}

function stripUndefined(s: Span): Style {
  const o: Style = {};
  if (s.fg !== undefined) o.fg = s.fg;
  if (s.bg !== undefined) o.bg = s.bg;
  if (s.bold) o.bold = true;
  if (s.italic) o.italic = true;
  if (s.underline) o.underline = true;
  if (s.inverse) o.inverse = true;
  return o;
}
