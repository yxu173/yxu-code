/**
 * Built-in themes and theme files (~/.config/yxu/themes/<name>.yaml):
 *
 *   extends: light                 # optional: start from a built-in theme
 *   colors: { cyan: "#2aa198", fault: "#dc322f" }   # any palette role, as #rrggbb
 *   ansi: { cyan: 36 }             # optional: 16-color codes (30–37, 90–97)
 *   glyphs: { mark: "◆", you: "›" }   # optional: replace glyphs (Unicode mode)
 *
 * Roles: ivory (text), dim, faint, cyan (activity), amber (attention), violet (memory),
 * fault (failures), bg (background), panel (side panel background).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { userConfigDir } from "../config-layers.ts";
import { packContentDirs } from "../packs.ts";
import { INSTRUMENT, paletteFrom, UNICODE_GLYPHS, type ColorRole, type Glyphs, type Palette, type RGB } from "./theme.ts";

const ROLES: ColorRole[] = ["ivory", "dim", "faint", "cyan", "amber", "violet", "fault", "bg", "panel"];

const ANSI_BASIC: Palette["ansi"] = { ivory: 97, dim: 37, faint: 90, cyan: 36, amber: 33, violet: 35, fault: 31, bg: undefined, panel: undefined };

export const BUILTIN_THEMES: Record<string, { about: string; palette: Palette }> = {
  instrument: { about: "dark deep-space instrument (default)", palette: INSTRUMENT },
  "high-contrast": {
    about: "maximum legibility on dark backgrounds",
    palette: paletteFrom(
      "high-contrast",
      { ivory: [255, 255, 255], dim: [205, 205, 205], faint: [150, 150, 150], cyan: [0, 230, 230], amber: [255, 200, 0], violet: [200, 160, 255], fault: [255, 90, 90], bg: [0, 0, 0], panel: [18, 18, 18] },
      { ...ANSI_BASIC, dim: 97, faint: 37, cyan: 96, amber: 93, violet: 95, fault: 91 },
    ),
  },
  light: {
    about: "dark text on a paper background",
    palette: paletteFrom(
      "light",
      { ivory: [34, 34, 38], dim: [92, 92, 100], faint: [150, 150, 158], cyan: [0, 112, 122], amber: [156, 92, 0], violet: [104, 70, 168], fault: [176, 40, 30], bg: [247, 244, 237], panel: [236, 232, 222] },
      { ivory: 30, dim: 90, faint: 37, cyan: 36, amber: 33, violet: 35, fault: 31, bg: undefined, panel: undefined },
    ),
  },
  mono: {
    about: "grays only; state is carried by glyphs and words",
    palette: paletteFrom(
      "mono",
      { ivory: [230, 230, 230], dim: [160, 160, 160], faint: [95, 95, 95], cyan: [230, 230, 230], amber: [255, 255, 255], violet: [190, 190, 190], fault: [255, 255, 255], bg: [12, 12, 12], panel: [20, 20, 20] },
      { ...ANSI_BASIC, cyan: 97, amber: 97, violet: 37, fault: 97 },
    ),
  },
};

const Hex = z.string().regex(/^#?[0-9a-f]{6}$/i, "colors are #rrggbb");
const ThemeFile = z
  .object({
    extends: z.string().optional(),
    colors: z.partialRecord(z.enum(ROLES as [ColorRole, ...ColorRole[]]), Hex).optional(),
    ansi: z.partialRecord(z.enum(ROLES as [ColorRole, ...ColorRole[]]), z.number().int().min(30).max(97)).optional(),
    glyphs: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();

const hex = (h: string): RGB => {
  const n = Number.parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const themesDir = () => join(userConfigDir(), "themes");

/** Where theme files are looked up, first wins: yours, then project packs', then user packs'. */
function themeDirs(root?: string): string[] {
  if (!root) return [themesDir()];
  return [themesDir(), ...packContentDirs(root, "themes", "project").map((d) => d.dir), ...packContentDirs(root, "themes", "user").map((d) => d.dir)];
}

/** Theme files by name (yours win over packs'). */
export function themeFileMap(root?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of themeDirs(root)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const m = /^([\w-]+)\.ya?ml$/.exec(f);
      if (m && !out.has(m[1]!)) out.set(m[1]!, join(dir, f));
    }
  }
  return out;
}

/** Names of theme files in ~/.config/yxu/themes and in packs. */
export function themeFiles(root?: string): string[] {
  return [...themeFileMap(root).keys()].sort();
}

export interface LoadedTheme {
  palette: Palette;
  glyphs?: Partial<Glyphs>;
  file?: string;
}

/** A built-in theme or a theme file. Throws with a readable message. */
export function loadTheme(name: string, root?: string, seen: string[] = []): LoadedTheme {
  const file = themeFileMap(root).get(name);
  if (!file) {
    const b = BUILTIN_THEMES[name];
    if (!b) throw new Error(`unknown theme "${name}" (built-in: ${Object.keys(BUILTIN_THEMES).join(", ")}${themeFiles(root).length ? `; yours: ${themeFiles(root).join(", ")}` : ""})`);
    return { palette: b.palette };
  }
  if (seen.includes(name)) throw new Error(`theme ${name} extends itself (${[...seen, name].join(" → ")})`);
  const parsed = ThemeFile.safeParse(parseYaml(readFileSync(file, "utf8")) ?? {});
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "theme"}: ${i.message}`).join("; ")}`);
  const t = parsed.data;
  const base = loadTheme(t.extends ?? "instrument", root, [...seen, name]);
  const rgb = { ...base.palette.rgb, ...Object.fromEntries(Object.entries(t.colors ?? {}).map(([k, v]) => [k, hex(v)])) } as Palette["rgb"];
  const palette = paletteFrom(name, rgb, { ...base.palette.ansi, ...t.ansi });
  const unknown = Object.keys(t.glyphs ?? {}).filter((g) => !(g in UNICODE_GLYPHS) || g === "step" || g === "pulse");
  if (unknown.length) throw new Error(`${file}: unknown glyph ${unknown.join(", ")}`);
  return { palette, glyphs: { ...base.glyphs, ...(t.glyphs as Partial<Glyphs>) }, file };
}
