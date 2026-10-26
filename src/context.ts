import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "./config.ts";

export interface IncludedFile {
  path: string;
  chars: number;
  truncated: boolean;
  missing?: boolean;
  error?: string;
}

/** What compaction must always keep, regardless of user instructions: yxu depends on it. */
const BASE_COMPACT_GUIDANCE =
  "Keep every task_id with its agent, status, and whether it is pending, applied, or discarded; " +
  "the user's goals and decisions; file paths that were changed; and open problems.";

/** Resolve an include path against the repo root, refusing paths that escape it. */
export function resolveInclude(root: string, p: string): string | undefined {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : abs;
}

/**
 * The extra system-prompt section yxu adds for the orchestrator: standing notes, included
 * files, and compaction guidance. Also reports what was included, for the interface.
 */
export function buildContextPrompt(cfg: Config, root: string): { text: string; files: IncludedFile[] } {
  const { context, compact } = cfg;
  const parts: string[] = [];
  const files: IncludedFile[] = [];

  if (context.notes?.trim()) parts.push(`## Standing notes from the user (yxu.yaml)\n${context.notes.trim()}`);

  for (const p of context.include) {
    const abs = resolveInclude(root, p);
    if (!abs) {
      files.push({ path: p, chars: 0, truncated: false, missing: true, error: "outside the repository" });
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      files.push({ path: p, chars: 0, truncated: false, missing: true });
      continue;
    }
    const raw = readFileSync(abs, "utf8");
    const max = context.include_max_chars;
    const truncated = raw.length > max;
    const body = truncated ? `${raw.slice(0, max)}\n… [truncated: ${raw.length - max} more characters]` : raw;
    files.push({ path: p, chars: raw.length, truncated });
    parts.push(`## Included file: ${p}\n\`\`\`\n${body}\n\`\`\``);
  }

  const guidance = [BASE_COMPACT_GUIDANCE, compact.instructions?.trim()].filter(Boolean).join(" ");
  parts.push(`## When this conversation is compacted\n${guidance}`);

  return { text: parts.join("\n\n"), files };
}

/** Instructions passed to a manual /compact. */
export function compactInstructions(cfg: Config, extra?: string): string {
  return [BASE_COMPACT_GUIDANCE, cfg.compact.instructions?.trim(), extra?.trim()].filter(Boolean).join(" ");
}

/** Claude Code settings that control compaction for orchestrator sessions. */
export function compactSettings(cfg: Config): { autoCompactEnabled: boolean; autoCompactWindow?: number } {
  const s: { autoCompactEnabled: boolean; autoCompactWindow?: number } = { autoCompactEnabled: cfg.compact.auto };
  if (cfg.compact.window !== "auto") s.autoCompactWindow = cfg.compact.window;
  return s;
}

/** Which Claude settings files the orchestrator loads. */
export function settingSources(cfg: Config): ("user" | "project" | "local")[] | undefined {
  if (cfg.orchestrator.user_settings) return undefined; // everything, like plain Claude Code
  return cfg.context.project_instructions ? ["project"] : [];
}

/** Context-window usage as reported by Claude Code. */
export interface ContextUsage {
  tokens: number;
  max: number;
  percentage: number;
  autoCompact: boolean;
  /** Token count at which auto-compaction triggers, when enabled. */
  threshold?: number;
  categories: { name: string; tokens: number; kind: string }[];
}

/**
 * Whether a background summary is worth making: the window is past compact.background_at, and
 * the conversation itself (what a summary shrinks, unlike the system prompt and tools) is at least
 * a tenth of the window. Otherwise a summary would land above the threshold again and repeat.
 */
export function worthCompacting(u: ContextUsage | undefined, k: { background_at: number }): boolean {
  if (!u || u.max <= 0 || u.percentage / 100 < k.background_at) return false;
  const messages = u.categories.find((c) => /messages/i.test(c.name));
  return !messages || messages.tokens >= 0.1 * u.max;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Parse a user-typed window like "200k", "1m", "150000", or "auto". */
export function parseTokensArg(v: string): number | "auto" | undefined {
  const t = v.trim().toLowerCase();
  if (t === "auto") return "auto";
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(t);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1));
}
