/**
 * Visual language for the yxu instrument.
 *
 * Palette roles (never the only carrier of meaning — every state also has a glyph and a word):
 *   ivory   primary text            cyan    active signal, interaction
 *   amber   attention, decisions    violet  memory, context
 *   fault   failures                dim/faint  secondary text, structure
 */

export type ColorRole = "ivory" | "dim" | "faint" | "cyan" | "amber" | "violet" | "fault" | "bg" | "panel";
export type ColorDepth = "truecolor" | "256" | "16" | "none";

export interface Style {
  fg?: ColorRole;
  bg?: ColorRole;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export type RGB = [number, number, number];

/** A color scheme: exact colors, plus what to use on 256- and 16-color terminals. */
export interface Palette {
  name: string;
  rgb: Record<ColorRole, RGB>;
  xterm: Record<ColorRole, number>;
  ansi: Record<ColorRole, number | undefined>;
}

const TRUECOLOR: Record<ColorRole, RGB> = {
  ivory: [232, 225, 207],
  dim: [150, 145, 132],
  faint: [78, 80, 86],
  cyan: [111, 183, 183],
  amber: [209, 161, 90],
  violet: [154, 139, 196],
  fault: [201, 122, 107],
  bg: [11, 13, 17],
  panel: [15, 18, 24],
};

const XTERM256: Record<ColorRole, number> = {
  ivory: 187,
  dim: 246,
  faint: 239,
  cyan: 73,
  amber: 179,
  violet: 140,
  fault: 173,
  bg: 233,
  panel: 234,
};

/** Basic ANSI: fg codes (bg not painted at this depth). */
const ANSI16: Record<ColorRole, number | undefined> = {
  ivory: 97,
  dim: 37,
  faint: 90,
  cyan: 36,
  amber: 33,
  violet: 35,
  fault: 31,
  bg: undefined,
  panel: undefined,
};

/** Glyphs with ASCII fallbacks. Each one marks a specific kind of thing; none are decoration. */
export const UNICODE_GLYPHS = {
  mark: "⟡", // the instrument's sigil (header)
  you: "▹", // user input
  machine: "◈", // orchestrator response
  memory: "⁘", // context / session information
  attention: "△", // decision required
  fault: "⊗", // failure
  ok: "◉", // completed activity
  running: "◌", // activity in progress
  idle: "○", // inactive / skipped
  star: "✦", // a working subagent slot
  dot: "·", // an idle slot / separator
  step: ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ"], // pipeline stages
  pulse: ["◴", "◷", "◶", "◵"], // slow orbit while processing
  expand: "▸",
  collapse: "▾",
  h: "─",
  v: "│",
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  hh: "━", // heavy, for the decision boundary
  vh: "┃",
  tlh: "┏",
  trh: "┓",
  blh: "┗",
  brh: "┛",
  rtl: "╭", // rounded: the message box
  rtr: "╮",
  rbl: "╰",
  rbr: "╯",
  prompt: "›",
  image: "▣",
  ellipsis: "…",
  gaugeFull: "▰",
  gaugeEmpty: "▱",
  up: "↑",
  down: "↓",
  arrow: "→",
};

export type Glyphs = typeof UNICODE_GLYPHS;

export const ASCII_GLYPHS: Glyphs = {
  mark: "<>",
  you: ">",
  machine: "*",
  memory: ":",
  attention: "!",
  fault: "x",
  ok: "o",
  running: "~",
  idle: "-",
  star: "*",
  dot: ".",
  step: ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"],
  pulse: ["-", "\\", "|", "/"],
  expand: ">",
  collapse: "v",
  h: "-",
  v: "|",
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  hh: "=",
  vh: "|",
  tlh: "+",
  trh: "+",
  blh: "+",
  brh: "+",
  rtl: "+",
  rtr: "+",
  rbl: "+",
  rbr: "+",
  prompt: ">",
  image: "[img]",
  ellipsis: "...",
  gaugeFull: "#",
  gaugeEmpty: "-",
  up: "^",
  down: "v",
  arrow: "->",
};

/** The default "ancient instrument" palette. */
export const INSTRUMENT: Palette = { name: "instrument", rgb: TRUECOLOR, xterm: XTERM256, ansi: ANSI16 };

/** Nearest xterm-256 color for an RGB value (6×6×6 cube or the gray ramp). */
export function nearest256([r, g, b]: RGB): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const steps = [0, 95, 135, 175, 215, 255];
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const cube = 16 + 36 * cr + 6 * cg + cb;
  const cubeDist = (steps[cr]! - r) ** 2 + (steps[cg]! - g) ** 2 + (steps[cb]! - b) ** 2;
  const grayIdx = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + grayIdx * 10;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return grayDist < cubeDist ? 232 + grayIdx : cube;
}

/** A palette from RGB colors, deriving the 256-color fallbacks. */
export function paletteFrom(name: string, rgb: Record<ColorRole, RGB>, ansi: Record<ColorRole, number | undefined> = ANSI16): Palette {
  return { name, rgb, ansi, xterm: Object.fromEntries(Object.entries(rgb).map(([k, v]) => [k, nearest256(v)])) as Record<ColorRole, number> };
}

export interface Theme {
  name: string;
  depth: ColorDepth;
  glyphs: Glyphs;
  ascii: boolean;
  reducedMotion: boolean;
  /** Paint the dark background (truecolor/256 only). */
  paintBackground: boolean;
  /** SGR sequence for a style (empty when colors are off). */
  sgr(style: Style): string;
  reset: string;
}

export interface ThemeOptions {
  /** Colors (default: the instrument palette). */
  palette?: Palette;
  /** Replace individual glyphs (Unicode mode only). */
  glyphs?: Partial<Glyphs>;
  depth?: ColorDepth;
  ascii?: boolean;
  reducedMotion?: boolean;
  paintBackground?: boolean;
}

export function detectColorDepth(env: Record<string, string | undefined> = process.env, isTTY = true): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (env.FORCE_COLOR === "0") return "none";
  if (env.FORCE_COLOR === "3") return "truecolor";
  if (env.FORCE_COLOR === "2") return "256";
  if (env.FORCE_COLOR === "1") return "16";
  if (!isTTY || env.TERM === "dumb") return "none";
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return "truecolor";
  const term = env.TERM ?? "";
  if (/-256(color)?$/.test(term) || term.includes("256")) return "256";
  if (/^(xterm|screen|tmux|rxvt|vt100|linux|ansi|cygwin)/.test(term)) return "16";
  return "16";
}

export function detectAscii(env: Record<string, string | undefined> = process.env): boolean {
  if (env.YXU_ASCII === "1") return true;
  if (env.YXU_ASCII === "0") return false;
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (env.TERM === "linux") return true; // the Linux console lacks most of these glyphs
  return loc !== "" && !/utf-?8/i.test(loc);
}

export function detectReducedMotion(env: Record<string, string | undefined> = process.env): boolean {
  return env.YXU_REDUCED_MOTION === "1" || env.REDUCE_MOTION === "1";
}

export function createTheme(opts: ThemeOptions = {}): Theme {
  const depth = opts.depth ?? detectColorDepth();
  const ascii = opts.ascii ?? detectAscii();
  const paintBackground = (opts.paintBackground ?? process.env.YXU_NO_BG !== "1") && (depth === "truecolor" || depth === "256");

  const pal = opts.palette ?? INSTRUMENT;
  const color = (role: ColorRole, layer: "fg" | "bg"): string => {
    if (depth === "truecolor") {
      const [r, g, b] = pal.rgb[role];
      return `${layer === "fg" ? 38 : 48};2;${r};${g};${b}`;
    }
    if (depth === "256") return `${layer === "fg" ? 38 : 48};5;${pal.xterm[role]}`;
    if (depth === "16" && layer === "fg") return pal.ansi[role] !== undefined ? String(pal.ansi[role]) : "";
    return "";
  };

  return {
    name: pal.name,
    depth,
    ascii,
    glyphs: ascii ? ASCII_GLYPHS : { ...UNICODE_GLYPHS, ...opts.glyphs },
    reducedMotion: opts.reducedMotion ?? detectReducedMotion(),
    paintBackground,
    reset: depth === "none" ? "" : "\x1b[0m",
    sgr(style: Style): string {
      if (depth === "none") {
        // Keep inverse even without color so selection stays visible.
        return style.inverse ? "\x1b[7m" : "";
      }
      const parts: string[] = [];
      if (style.bold) parts.push("1");
      if (style.italic) parts.push("3");
      if (style.underline) parts.push("4");
      if (style.inverse) parts.push("7");
      if (style.fg) {
        const c = color(style.fg, "fg");
        if (c) parts.push(c);
      }
      const bg = style.bg ?? (paintBackground ? "bg" : undefined);
      if (bg && paintBackground) parts.push(color(bg, "bg"));
      return parts.length ? `\x1b[${parts.join(";")}m` : "";
    },
  };
}
