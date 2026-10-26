/**
 * What happened to a task after it ran, for `yxu pr`: checks run on it, reviews of it, and the
 * issue it was for. Kept next to the task's record in .yxu/runs/<task>/notes.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./runner.ts";

export interface IssueRef {
  /** "github", or the plugin source that fetched it (e.g. "linear"). */
  source: string;
  /** What the user typed: 123, owner/repo#123, linear:ENG-12, a URL. */
  ref: string;
  id: string;
  title: string;
  url?: string;
  /** GitHub issues in the same repo: "Closes #123" in the PR closes them. */
  closes?: string;
}

export type TaskNote =
  | { kind: "verify"; command: string; ok: boolean; exitCode: number | null; durationMs: number; tail: string; at: string }
  | { kind: "review"; by: string; approved?: boolean; summary: string; taskId?: string; at: string }
  | { kind: "issue"; issue: IssueRef; at: string };

type NewNote = TaskNote extends infer N ? (N extends TaskNote ? Omit<N, "at"> : never) : never;

const file = (root: string, taskId: string) => join(runDir(root, taskId), "notes.json");

export function readNotes(root: string, taskId: string): TaskNote[] {
  const f = file(root, taskId);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, "utf8")) as TaskNote[];
  } catch {
    return [];
  }
}

export function addNote(root: string, taskId: string, note: NewNote) {
  const notes = readNotes(root, taskId);
  // One issue per task.
  if (note.kind === "issue" && notes.some((n) => n.kind === "issue")) return;
  notes.push({ ...note, at: new Date().toISOString() } as TaskNote);
  mkdirSync(runDir(root, taskId), { recursive: true });
  writeFileSync(file(root, taskId), JSON.stringify(notes, null, 2));
}
