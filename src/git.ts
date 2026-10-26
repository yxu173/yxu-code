import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runSync } from "./platform.ts";

export function git(cwd: string, ...args: string[]): string {
  const p = runSync(["git", ...args], { cwd });
  if (p.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.trim()}`);
  }
  return p.stdout.trim();
}

/** Like git() but returns failure instead of throwing (for merges that may conflict). */
export function tryGit(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const p = runSync(["git", ...args], { cwd });
    return { ok: p.code === 0, out: p.stdout.trim(), err: p.stderr.trim() };
  } catch (e) {
    // e.g. cwd vanished: report as a failure rather than throwing.
    return { ok: false, out: "", err: (e as Error).message };
  }
}

/** Identity for commits yxu makes in task worktrees. */
export const YXU_IDENTITY = ["-c", "user.name=yxu", "-c", "user.email=yxu@localhost"];

export function repoRoot(cwd: string): string {
  const r = tryGit(cwd, "rev-parse", "--show-toplevel");
  if (r.ok) return r.out;
  if (/not a git repository/i.test(r.err)) {
    throw new Error(
      `${cwd} is not inside a git repository. yxu runs each agent in its own git worktree, so it needs one:\n` +
        `  cd into a project that uses git, or start one here with:\n` +
        `  git init && git commit --allow-empty -m init`,
    );
  }
  throw new Error(`git rev-parse --show-toplevel failed: ${r.err}`);
}

export const branchFor = (taskId: string) => `yxu/${taskId}`;
export const worktreeFor = (root: string, taskId: string) => join(root, ".yxu", "worktrees", taskId);

/** yxu's runtime files. The rest of .yxu/ (workflows, commands, prompts) is meant to be committed. */
export const RUNTIME_PATHS = [".yxu/worktrees/", ".yxu/runs/", ".yxu/sessions/", ".yxu/history.jsonl", ".yxu/repomap.json", ".yxu/images/"];

/** Keep yxu's runtime files out of the user's `git status` without touching their .gitignore. */
export function excludeYxuDir(root: string) {
  const common = resolve(root, git(root, "rev-parse", "--git-common-dir"));
  const exclude = join(common, "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  // Older versions excluded all of .yxu/, which hid shared workflows and commands.
  const lines = current.split("\n").filter((l) => l !== ".yxu/");
  const missing = RUNTIME_PATHS.filter((p) => !lines.includes(p));
  if (!missing.length && lines.length === current.split("\n").length) return;
  const kept = lines.join("\n");
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, `${kept}${kept && !kept.endsWith("\n") ? "\n" : ""}${missing.map((p) => `${p}\n`).join("")}`);
}

export interface Worktree {
  path: string;
  branch: string;
  base: string;
}

/** Create a worktree on a new branch starting at `baseRef` (default: current HEAD). */
export function createWorktree(root: string, taskId: string, baseRef = "HEAD"): Worktree {
  excludeYxuDir(root);
  const path = worktreeFor(root, taskId);
  const branch = branchFor(taskId);
  const base = git(root, "rev-parse", `${baseRef}^{commit}`);
  git(root, "worktree", "add", "-q", "-b", branch, path, base);
  return { path, branch, base };
}

/** Commit whatever the agent left in the worktree and return the diff against base. */
export function collectChanges(wt: Worktree, message: string): { diff: string; files: string[] } {
  git(wt.path, "add", "-A");
  if (git(wt.path, "status", "--porcelain")) {
    git(wt.path, ...YXU_IDENTITY, "commit", "-q", "--no-verify", "-m", message);
  }
  const diff = git(wt.path, "diff", wt.base, "HEAD");
  const files = git(wt.path, "diff", "--name-only", wt.base, "HEAD").split("\n").filter(Boolean);
  return { diff, files };
}

/** Uncommitted changes in a plain directory (no-worktree mode). */
export function workingDiff(cwd: string): { diff: string; files: string[] } {
  git(cwd, "add", "-A", "-N");
  const diff = git(cwd, "diff", "HEAD");
  const files = git(cwd, "diff", "--name-only", "HEAD").split("\n").filter(Boolean);
  return { diff, files };
}

export function removeWorktree(root: string, taskId: string, deleteBranch: boolean) {
  const path = worktreeFor(root, taskId);
  if (existsSync(path)) git(root, "worktree", "remove", "--force", path);
  if (deleteBranch && git(root, "branch", "--list", branchFor(taskId))) {
    git(root, "branch", "-D", branchFor(taskId));
  }
}
