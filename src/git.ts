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
export const RUNTIME_PATHS = [".yxu/worktrees/", ".yxu/runs/", ".yxu/sessions/", ".yxu/history.jsonl", ".yxu/repomap.json", ".yxu/images/", ".yxu/undo.json"];

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

// ── snapshots: your working tree as a commit ───────────────────────────────

const snapshots = new Map<string, { tree: string; commit: string }>();

/**
 * Your working tree as it is now, uncommitted and untracked changes included (ignored files and
 * yxu's own runtime files left out), as a commit on top of HEAD. Tasks start from it, so agents
 * see your current code. Nothing in your checkout changes: a temporary index is used. The same
 * tree gives the same commit, so tasks started together share one base.
 */
export function snapshot(root: string): string {
  const head = tryGit(root, "rev-parse", "--verify", "--quiet", "HEAD");
  excludeYxuDir(root);
  const gitDir = resolve(root, git(root, "rev-parse", "--git-dir"));
  const index = join(gitDir, `yxu-snapshot-${process.pid}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (...args: string[]) => {
    const p = runSync(["git", ...args], { cwd: root, env });
    if (p.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.trim()}`);
    return p.stdout.trim();
  };
  try {
    if (head.ok) run("read-tree", head.out);
    else run("read-tree", "--empty");
    run("add", "-A", "--", ".");
    const tree = run("write-tree");
    if (head.ok && tree === git(root, "rev-parse", `${head.out}^{tree}`)) return head.out; // nothing uncommitted
    const hit = snapshots.get(root);
    if (hit?.tree === tree) return hit.commit;
    const commit = runSync(["git", ...YXU_IDENTITY, "commit-tree", tree, ...(head.ok ? ["-p", head.out] : []), "-m", "yxu: snapshot of the working tree"], { cwd: root, env }).stdout.trim();
    snapshots.set(root, { tree, commit });
    return commit;
  } finally {
    try {
      require("node:fs").rmSync(index, { force: true });
    } catch {
      // best effort
    }
  }
}

/** A file's content at a commit, or undefined if it isn't there. */
export function fileAt(root: string, commit: string, path: string): Buffer | undefined {
  const p = Bun.spawnSync(["git", "show", `${commit}:${path}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? Buffer.from(p.stdout) : undefined;
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
