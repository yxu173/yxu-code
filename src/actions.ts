import { readTaskRecord, taskAncestors, type TaskRecord } from "./combine.ts";
import { branchFor, git, removeWorktree, tryGit } from "./git.ts";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string; hint?: string };

/** Merge a task's branch into the user's current branch. Never leaves a half-done merge. */
export function applyTask(root: string, id: string): ActionResult {
  const r = readTaskRecord(root, id);
  if (!r) return { ok: false, message: `no task ${id}` };
  if (!r.branch) return { ok: false, message: `task ${id} has nothing to apply (no changes, or it ran with --no-worktree)` };
  if (!git(root, "branch", "--list", branchFor(id))) {
    return { ok: false, message: `task ${id} was already applied or discarded` };
  }
  if (git(root, "status", "--porcelain", "--untracked-files=no")) {
    return {
      ok: false,
      message: "your working tree has uncommitted changes",
      hint: "commit or stash them first, then apply again",
    };
  }
  const merge = tryGit(root, "merge", "--no-ff", "-m", `yxu: apply ${id} (${r.agent})`, branchFor(id));
  if (!merge.ok) {
    const conflicts = tryGit(root, "diff", "--name-only", "--diff-filter=U").out;
    tryGit(root, "merge", "--abort");
    return conflicts
      ? {
          ok: false,
          message: `task ${id} conflicts with your branch in: ${conflicts.split("\n").join(", ")}. Nothing was changed.`,
          hint: "rebase your work, or ask yxu to redo the task on top of your current HEAD",
        }
      : { ok: false, message: `merge failed: ${merge.err || merge.out}` };
  }
  removeWorktree(root, id, true);
  // Tasks this one was built from (build_on chains, combine parents) are merged too; clean them up.
  for (const a of taskAncestors(root, id)) removeWorktree(root, a, true);
  return { ok: true, message: `merged ${branchFor(id)} into ${git(root, "branch", "--show-current")}` };
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
