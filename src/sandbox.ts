/**
 * `sandbox: bwrap` (Linux): the agent sees the whole file system read-only and can write only
 * to its task worktree, that worktree's own git metadata, a private /tmp, and the agent's own
 * state directories (sessions, caches, auth tokens). It cannot touch your checkout, other
 * worktrees, .git/hooks, or the rest of your home directory. The network stays open, since
 * agents need their model APIs.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { which } from "./platform.ts";
import type { AgentKind } from "./types.ts";

/** Where known agent programs keep state they must be able to write (sessions, logs, caches). */
const STATE_DIRS: Record<string, string[]> = {
  opencode: ["~/.local/share/opencode", "~/.local/state/opencode", "~/.cache/opencode", "~/.config/opencode"],
  claude: ["~/.claude", "~/.claude.json", "~/.cache/claude"],
  cmd: ["~/.commandcode"],
  commandcode: ["~/.commandcode"],
  gemini: ["~/.gemini"],
  aider: ["~/.aider", "~/.cache/aider"],
  codex: ["~/.codex"],
  goose: ["~/.config/goose", "~/.local/share/goose", "~/.local/state/goose"],
  npx: ["~/.npm"],
  bunx: ["~/.bun/install/cache"],
};

/** State dirs for the CLI and for any known program named in its command (e.g. npx claude-agent-acp). */
function stateDirs(cli: AgentKind, argv: string[]): string[] {
  const words = new Set([cli, ...argv.flatMap((a) => a.split(/[\/@\s-]/))].map((w) => w.toLowerCase()));
  return Object.entries(STATE_DIRS).flatMap(([name, dirs]) => (words.has(name) ? dirs : []));
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p));

/** The worktree's private git dir (gitdir: … in its .git file), which git writes to. */
function worktreeGitDir(worktree: string): string | undefined {
  const dotGit = join(worktree, ".git");
  if (!existsSync(dotGit)) return undefined;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  return m ? resolve(worktree, m[1]!.trim()) : undefined;
}

export function sandboxAvailable(): string | undefined {
  if (process.platform !== "linux") return `sandbox: bwrap needs Linux (this is ${process.platform}); macOS support is planned`;
  if (!which("bwrap")) return "sandbox: bwrap needs bubblewrap installed (e.g. `pacman -S bubblewrap`, `apt install bubblewrap`)";
  return undefined;
}

/** Wrap an agent command so it runs inside bubblewrap. Throws when bwrap can't be used. */
export function sandboxed(argv: string[], o: { cli: AgentKind; worktree: string; writable?: string[] }): string[] {
  const missing = sandboxAvailable();
  if (missing) throw new Error(missing);
  // The shared git data (objects, refs) must stay readable even under the private /tmp.
  const gitDir = worktreeGitDir(o.worktree);
  const common = gitDir && existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : undefined;
  const readable = [common].filter((p): p is string => !!p && existsSync(p));
  const writable = [o.worktree, gitDir, ...stateDirs(o.cli, argv), ...(o.writable ?? [])]
    .filter((p): p is string => !!p)
    .map(expand)
    .filter((p, i, all) => existsSync(p) && all.indexOf(p) === i);
  return [
    "bwrap",
    "--die-with-parent",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    ...readable.flatMap((p) => ["--ro-bind", p, p]),
    ...writable.flatMap((p) => ["--bind", p, p]),
    "--chdir", o.worktree,
    "--",
    ...argv,
  ];
}
