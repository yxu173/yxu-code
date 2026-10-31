import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readTaskRecord, taskAncestors, type TaskRecord } from "./combine.ts";
import type { Config } from "./config.ts";
import { branchFor, fileAt, git, removeWorktree, snapshot, tryGit, worktreeFor } from "./git.ts";
import { formatHookFailure, hasHooks, runHooks } from "./hooks.ts";
import type { TaskResult } from "./types.ts";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string; hint?: string };

export interface ApplyReport {
  files: string[];
  added: number;
  removed: number;
  /** Files where your edits and the task's overlapped: they now have conflict markers. */
  conflicts: string[];
  /** Binary files both sides changed: the task's version is next to yours as <file>.yxu-theirs. */
  sideBySide: string[];
}

const undoFile = (root: string) => join(root, ".yxu", "undo.json");
const isBinary = (b: Buffer | undefined) => !!b && b.subarray(0, 8000).includes(0);
const same = (a: Buffer | undefined, b: Buffer | undefined) => (a === undefined ? b === undefined : b !== undefined && a.equals(b));
const hashOf = (b: Buffer | undefined) => (b === undefined ? null : new Bun.CryptoHasher("sha256").update(b).digest("hex"));

function readFile(path: string): Buffer | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bring a task's work into your working tree as uncommitted changes, the way an agent working in
 * place would: no commit, no merge commit, no branch switch. Files you haven't touched since the
 * task started take the task's version; files you changed meanwhile are merged three ways (your
 * version, the version the task started from, the task's); overlapping edits get conflict markers
 * in that file only. What was there before is kept for `undo`.
 */
export function applyTask(root: string, id: string): ActionResult & { report?: ApplyReport } {
  const r = readTaskRecord(root, id) as (TaskRecord & { origin?: string }) | undefined;
  if (!r) return { ok: false, message: `no task ${id}` };
  if (!r.branch) return { ok: false, message: `task ${id} has nothing to apply (no changes, or it ran with --no-worktree)` };
  const branch = branchFor(id);
  if (!tryGit(root, "rev-parse", "--verify", "--quiet", branch).ok) return { ok: false, message: `task ${id} was already applied or discarded` };
  const origin = r.origin && tryGit(root, "cat-file", "-e", `${r.origin}^{commit}`).ok ? r.origin : tryGit(root, "merge-base", "HEAD", branch).out || "HEAD";
  const changed = git(root, "diff", "--no-renames", "--name-only", "-z", origin, branch).split("\0").filter(Boolean);
  if (!changed.length) return { ok: false, message: `task ${id} changes nothing compared with where it started` };

  // What is there now, for undo.
  const before = snapshot(root);
  const report: ApplyReport = { files: [], added: 0, removed: 0, conflicts: [], sideBySide: [] };
  const written: { path: string; hash: string | null }[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "yxu-apply-"));
  try {
    for (const path of changed) {
      const abs = join(root, path);
      const base = fileAt(root, origin, path);
      const theirs = fileAt(root, branch, path);
      const ours = readFile(abs);
      let out: Buffer | undefined;
      if (same(ours, theirs)) continue; // you already have it
      if (same(ours, base)) out = theirs; // you didn't touch it: take the task's
      else if (same(theirs, base)) continue; // the task didn't really change it
      else if (theirs === undefined || ours === undefined) {
        // One side deleted it, the other edited it: keep yours, and say so.
        report.conflicts.push(`${path} (${theirs === undefined ? "the task deleted it; you changed it" : "you deleted it; the task changed it"}: kept yours)`);
        continue;
      } else if (isBinary(ours) || isBinary(theirs) || isBinary(base)) {
        writeFileSync(`${abs}.yxu-theirs`, theirs);
        report.sideBySide.push(path);
        continue;
      } else {
        const fb = join(tmp, "base"), fo = join(tmp, "ours"), ft = join(tmp, "theirs");
        writeFileSync(fb, base ?? "");
        writeFileSync(fo, ours);
        writeFileSync(ft, theirs);
        const m = Bun.spawnSync(["git", "merge-file", "-p", "-L", "your working tree", "-L", "where the task started", "-L", `task ${id}`, fo, fb, ft], { stdout: "pipe", stderr: "pipe" });
        if ((m.exitCode ?? 0) < 0 || (m.exitCode ?? 0) > 127) throw new Error(`merging ${path} failed: ${m.stderr.toString()}`);
        out = Buffer.from(m.stdout);
        if (m.exitCode) report.conflicts.push(path);
      }
      if (out === undefined) rmSync(abs, { force: true });
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, out);
      }
      written.push({ path, hash: hashOf(out) });
      report.files.push(path);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!written.length && !report.sideBySide.length) {
    return { ok: false, message: `nothing to apply: your working tree already has task ${id}'s changes${report.conflicts.length ? ` (except: ${report.conflicts.join("; ")})` : ""}` };
  }
  const stat = tryGit(root, "diff", "--no-renames", "--numstat", origin, branch, "--", ...written.map((w) => w.path)).out;
  for (const line of stat.split("\n")) {
    const [a, d] = line.split("\t");
    report.added += Number(a) || 0;
    report.removed += Number(d) || 0;
  }
  mkdirSync(join(root, ".yxu"), { recursive: true });
  writeFileSync(undoFile(root), JSON.stringify({ task: id, before, files: written }, null, 2));
  // The worktree is done with; the branch stays for `yxu pr` (yxu clean prunes old ones).
  removeWorktree(root, id, false);
  for (const a of taskAncestors(root, id)) removeWorktree(root, a, false);
  const parts = [`applied ${written.length} file${written.length === 1 ? "" : "s"} to your working tree (+${report.added} −${report.removed}), uncommitted`];
  if (report.conflicts.length) parts.push(`overlapping edits in ${report.conflicts.join(", ")}: look for the <<<<<<< markers`);
  if (report.sideBySide.length) parts.push(`binary files both sides changed are next to yours as <file>.yxu-theirs: ${report.sideBySide.join(", ")}`);
  return { ok: true, message: parts.join("; "), report };
}

/**
 * Put back what the last apply changed. Files you edited after it are left as they are (and named).
 */
export function undoApply(root: string): ActionResult {
  let u: { task: string; before: string; files: { path: string; hash: string | null }[] };
  try {
    u = JSON.parse(readFileSync(undoFile(root), "utf8"));
  } catch {
    return { ok: false, message: "nothing to undo: no apply since yxu started keeping them" };
  }
  const restored: string[] = [];
  const kept: string[] = [];
  for (const f of u.files) {
    const abs = join(root, f.path);
    if (hashOf(readFile(abs)) !== f.hash) {
      kept.push(f.path);
      continue;
    }
    const was = fileAt(root, u.before, f.path);
    if (was === undefined) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, was);
    }
    restored.push(f.path);
  }
  rmSync(undoFile(root), { force: true });
  const msg = `undid task ${u.task}: restored ${restored.length} file${restored.length === 1 ? "" : "s"}`;
  return { ok: true, message: kept.length ? `${msg}; left ${kept.join(", ")} as is (you changed ${kept.length === 1 ? "it" : "them"} after the apply)` : msg };
}

/** Run the before_apply hooks in the task's worktree, then apply. A failing hook blocks the apply. */
export async function applyWithHooks(cfg: Config, root: string, id: string, signal?: AbortSignal): Promise<ActionResult> {
  if (hasHooks(cfg, "before_apply")) {
    const r = readTaskRecord(root, id);
    const wt = worktreeFor(root, id);
    if (r?.branch && existsSync(wt)) {
      const h = await runHooks(cfg, "before_apply", { task: taskData(r) }, { cwd: wt, signal });
      if (!h.ok) {
        return { ok: false, message: `${formatHookFailure("before_apply", h.failed[0]!)}\nNothing was applied.`, hint: "fix the task (or the hook), then apply again" };
      }
    }
  }
  return applyTask(root, id);
}

/** What hooks see about a task: {{task.id}}, {{task.files}}, … */
export function taskData(r: TaskRecord | TaskResult) {
  return { id: r.taskId, agent: r.agent, ok: r.ok, branch: r.branch, files: r.filesChanged, summary: r.summary, error: r.error };
}

export function discardTask(root: string, id: string): ActionResult {
  if (!readTaskRecord(root, id)) return { ok: false, message: `no task ${id}` };
  removeWorktree(root, id, true);
  return { ok: true, message: `discarded ${id}` };
}

export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

export function diffStat(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  let files = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { files, added, removed };
}

export function taskRecord(root: string, id: string): TaskRecord | undefined {
  return readTaskRecord(root, id);
}
