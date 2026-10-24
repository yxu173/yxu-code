/**
 * Runtime and platform helpers. Bun-specific lookups live here so the rest of the code
 * doesn't depend on them directly (process spawning still uses Bun.spawn; see docs/PUBLIC_PLAN.md §8).
 */
import { existsSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** Absolute path of an executable on PATH, or null. */
export function which(bin: string): string | null {
  return Bun.which(bin);
}

/** Display width of a string in terminal cells. */
export function stringWidth(s: string): number {
  return Bun.stringWidth(s);
}

/** True when running as a `bun build --compile` single-file binary. */
export function isCompiled(): boolean {
  return import.meta.url.includes("$bunfs") || /[\\/]~BUN[\\/]/.test(import.meta.url);
}

/**
 * The Claude Code executable the orchestrator should drive.
 * From source, the Agent SDK finds its own bundled engine (undefined = let it decide).
 * A compiled yxu binary can't reach that engine inside its virtual filesystem, so it uses
 * $YXU_CLAUDE_PATH or the `claude` on PATH, which the user has installed and logged in anyway.
 */
export function claudeExecutable(): string | undefined {
  const override = process.env.YXU_CLAUDE_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`YXU_CLAUDE_PATH points to a missing file: ${override}`);
    return override;
  }
  if (!isCompiled()) return undefined;
  const found = which("claude");
  if (!found) throw new Error("Claude Code (`claude`) not found on PATH — install it from https://claude.com/claude-code and log in, or set YXU_CLAUDE_PATH");
  return found;
}
