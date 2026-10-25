/**
 * Rebindable interface keys. `ui.keys` maps an action to a key, e.g.
 *
 *   ui:
 *     keys: { panel: ctrl+b, newline: shift+enter, apply: "y" }
 *
 * A rebound action stops answering to its old key. Key specs: optional ctrl+ / alt+ / shift+
 * modifiers and a key name (enter, escape, tab, up, down, left, right, home, end, pageup,
 * pagedown, backspace, delete) or a single character.
 */
import type { Key, KeyName } from "./tui/keys.ts";

export const KEY_ACTIONS = {
  send: { key: "enter", about: "send the message" },
  newline: { key: "alt+enter", about: "new line in the message" },
  cancel: { key: "escape", about: "cancel the running operation / close" },
  panel: { key: "ctrl+p", about: "toggle the context panel" },
  details: { key: "ctrl+o", about: "expand / collapse the selected activity" },
  select_up: { key: "ctrl+up", about: "select the previous activity" },
  select_down: { key: "ctrl+down", about: "select the next activity" },
  scroll_up: { key: "pageup", about: "scroll the conversation up" },
  scroll_down: { key: "pagedown", about: "scroll the conversation down" },
  redraw: { key: "ctrl+l", about: "redraw the screen" },
  exit: { key: "ctrl+d", about: "exit (on an empty message)" },
  help: { key: "?", about: "help (on an empty message)" },
  apply: { key: "a", about: "decision: apply the result" },
  view: { key: "v", about: "decision: view the diff" },
  later: { key: "l", about: "decision: decide later" },
  discard: { key: "x", about: "decision: discard the result" },
  approve: { key: "y", about: "gate: continue the workflow" },
  stop: { key: "n", about: "gate: stop the workflow" },
} as const;

export type KeyAction = keyof typeof KEY_ACTIONS;

const NAMES = ["enter", "escape", "tab", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "backspace", "delete"];
const ALIASES: Record<string, string> = { esc: "escape", return: "enter", pgup: "pageup", pgdn: "pagedown", del: "delete", bs: "backspace" };
/** Keys the message editor uses; binding them is allowed but worth a warning. */
const EDITOR_KEYS = ["ctrl+a", "ctrl+e", "ctrl+u", "ctrl+k", "ctrl+w", "ctrl+j", "ctrl+c", "left", "right", "up", "down", "home", "end", "backspace", "delete", "tab"];

/** Normalize "Ctrl+P" / "esc" / "ctrl+shift+Up" to a canonical spec; throws on nonsense. */
export function normalizeSpec(spec: string): string {
  const parts = spec.trim().toLowerCase().split("+");
  // "+" itself, or "ctrl++"
  if (spec.trim().endsWith("++") || spec.trim() === "+") parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  for (const m of mods) if (!["ctrl", "alt", "shift"].includes(m)) throw new Error(`unknown modifier "${m}" in "${spec}"`);
  const name = ALIASES[key] ?? key;
  if (!NAMES.includes(name) && [...name].length !== 1) throw new Error(`unknown key "${key}" in "${spec}"`);
  return [...["ctrl", "alt", "shift"].filter((m) => mods.has(m)), name].join("+");
}

/** The spec of a key event (chars are matched without shift: "?" not "shift+?"). */
export function specOf(k: Key): string | undefined {
  const name = k.name === "char" ? k.text?.toLowerCase() : k.name === "newline" ? "alt+enter" : k.name;
  if (!name || k.name === "paste") return undefined;
  if (k.name === "newline") return name;
  const mods = [k.ctrl && "ctrl", k.alt && "alt", k.shift && k.name !== "char" && "shift"].filter(Boolean);
  return [...mods, name].join("+");
}

function toKey(spec: string): Key {
  const parts = spec.split("+");
  const name = parts.pop()!;
  const mods = { ctrl: parts.includes("ctrl") || undefined, alt: parts.includes("alt") || undefined, shift: parts.includes("shift") || undefined };
  if (spec === "alt+enter") return { name: "newline" };
  if (NAMES.includes(name)) return { name: name as KeyName, ...mods };
  return { name: "char", text: name, ...mods };
}

type Moment = "always" | "decision" | "gate";
const momentOf = (a: string): Moment =>
  ["apply", "view", "later", "discard"].includes(a) ? "decision" : ["approve", "stop"].includes(a) ? "gate" : "always";

export interface Keymap {
  /** Effective spec per action. */
  bindings: Record<KeyAction, string>;
  /** Incoming spec → the default spec it should act as, for rebound actions. */
  remap: { from: string; to: string; moment: Moment }[];
  /** Default specs whose action moved elsewhere (no longer act). */
  freed: { spec: string; moment: Moment }[];
  warnings: string[];
}

/** Build the effective keymap; throws when the configuration is wrong. */
export function buildKeymap(custom: Record<string, string> = {}): Keymap {
  const bindings = Object.fromEntries(Object.entries(KEY_ACTIONS).map(([a, d]) => [a, d.key])) as Record<KeyAction, string>;
  const warnings: string[] = [];
  for (const [action, spec] of Object.entries(custom)) {
    if (!(action in KEY_ACTIONS)) throw new Error(`ui.keys: unknown action "${action}" (actions: ${Object.keys(KEY_ACTIONS).join(", ")})`);
    bindings[action as KeyAction] = normalizeSpec(spec);
  }
  // Decision and gate keys only act in their own moment, so they may reuse each other's keys.
  const seen = new Map<string, string>();
  for (const [a, spec] of Object.entries(bindings)) {
    const m = momentOf(a);
    const other = seen.get(`${m}:${spec}`) ?? (m === "always" ? [...seen].find(([k]) => k.endsWith(`:${spec}`))?.[1] : seen.get(`always:${spec}`));
    if (other) throw new Error(`ui.keys: "${spec}" is bound to both ${other} and ${a}`);
    seen.set(`${m}:${spec}`, a);
    if (a in custom && EDITOR_KEYS.includes(spec)) warnings.push(`${a} on "${spec}" replaces that key in the message editor`);
  }
  const remap: Keymap["remap"] = [];
  const freed: Keymap["freed"] = [];
  for (const [a, spec] of Object.entries(bindings)) {
    const def = KEY_ACTIONS[a as KeyAction].key;
    if (spec === def) continue;
    const moment = momentOf(a);
    remap.push({ from: spec, to: def, moment });
    if (!Object.entries(bindings).some(([b, x]) => x === def && (momentOf(b) === moment || momentOf(b) === "always"))) freed.push({ spec: def, moment });
  }
  return { bindings, remap, freed, warnings };
}

const plainChar = (spec: string) => [...spec].length === 1;

/**
 * Translate a key event through the keymap: the key to act on, or null to ignore it.
 * Single-character bindings only act on an empty message, so typing is never hijacked.
 */
export function translateKey(k: Key, km: Keymap, now: { moment: Moment; draftEmpty: boolean }): Key | null {
  const spec = specOf(k);
  if (!spec) return k;
  const applies = (m: Moment, s: string) => (m === "always" || m === now.moment) && (!plainChar(s) || now.draftEmpty);
  const hit = km.remap.find((r) => r.from === spec && applies(r.moment, r.from));
  if (hit) return toKey(hit.to);
  const freed = km.freed.find((f) => f.spec === spec && applies(f.moment, f.spec));
  if (freed) return plainChar(spec) ? { name: "paste", text: k.text ?? spec } : null; // a freed letter just types
  return k;
}
