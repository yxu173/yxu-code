/**
 * Orchestrator sessions, kept per user so they can be listed and resumed from anywhere:
 * one file per session in ~/.local/share/yxu/sessions (YXU_DATA_DIR, XDG_DATA_HOME, or
 * %LOCALAPPDATA% on Windows). Each records the repository and the folder it was started in,
 * the conversation (Conversation state: Claude's session, turns, background summaries) and the
 * tasks it made, so resuming brings back the conversation and its pending results.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTaskRecord } from "./combine.ts";
import type { ConversationState } from "./conversation.ts";
import { branchFor, tryGit } from "./git.ts";
import type { Session, SessionTask } from "./ops.ts";

export interface SessionFile {
  version: 1;
  /** Same as the conversation's id. */
  id: string;
  title: string;
  /** Repository root. Claude's own sessions are kept per directory, so resuming runs there. */
  root: string;
  /** Where yxu was started (a folder inside the repo, or the root). */
  folder: string;
  branch?: string;
  workflow?: string;
  createdAt: string;
  updatedAt: string;
  costUsd: number;
  /** Tasks the session made, oldest first. */
  tasks: string[];
  conversation: ConversationState;
}

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.YXU_DATA_DIR) return join(env.YXU_DATA_DIR, "sessions");
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "yxu", "sessions");
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "yxu", "sessions");
  return join(homedir(), ".local", "share", "yxu", "sessions");
}

const fileOf = (id: string) => join(sessionsDir(), `${id}.json`);

/**
 * One spelling per directory, so sessions match wherever the path came from: symlinks resolved
 * (macOS /var → /private/var), Windows short names expanded, forward slashes, drive letter upper case.
 */
export function canonPath(p: string): string {
  let r = p;
  try {
    r = realpathSync.native(p);
  } catch {
    // gone: compare as written
  }
  r = r.replace(/\\/g, "/");
  if (/^[a-z]:\//.test(r)) r = r[0]!.toUpperCase() + r.slice(1);
  return r.length > 1 ? r.replace(/\/+$/, "") : r;
}

export const samePath = (a: string, b: string) => canonPath(a) === canonPath(b);

/** A title from the first message: one line, short. */
export function titleFrom(goal: string): string {
  const line = goal.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return line.length > 70 ? `${line.slice(0, 69)}…` : line || "(untitled)";
}

export function newSession(root: string, folder: string, conversation: ConversationState): SessionFile {
  const now = new Date().toISOString();
  return { version: 1, id: conversation.id, title: "", root: canonPath(root), folder: canonPath(folder), createdAt: now, updatedAt: now, costUsd: 0, tasks: [], conversation };
}

/** Written whole and renamed into place. Sessions where nothing happened yet aren't kept. */
export function saveSession(s: SessionFile) {
  if (!s.conversation.turn && !s.tasks.length && !s.title) return;
  mkdirSync(sessionsDir(), { recursive: true });
  s.updatedAt = new Date().toISOString();
  const tmp = `${fileOf(s.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, fileOf(s.id));
}

function read(file: string): SessionFile | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as SessionFile;
    return s.version === 1 && typeof s.id === "string" && s.conversation ? s : undefined;
  } catch {
    return undefined;
  }
}

export interface ListFilter {
  /** Only this repository's sessions. */
  root?: string;
  /** Only sessions started in this folder. */
  folder?: string;
}

/** Sessions, most recent first. */
export function listSessions(f: ListFilter = {}): SessionFile[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const root = f.root ? canonPath(f.root) : undefined;
  const folder = f.folder ? canonPath(f.folder) : undefined;
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => read(join(dir, n)))
    .filter((s): s is SessionFile => Boolean(s))
    .filter((s) => (!root || canonPath(s.root) === root) && (!folder || canonPath(s.folder) === folder))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A session by id, a unique start of one, or "last" (in `root`). */
export function findSession(ref: string, root?: string): SessionFile {
  if (ref === "last" || ref === "latest") {
    const s = listSessions({ root })[0];
    if (!s) throw new Error(root ? "no sessions in this repository yet" : "no sessions yet");
    return s;
  }
  const exact = read(fileOf(ref));
  if (exact) return exact;
  const hits = listSessions().filter((s) => s.id.startsWith(ref));
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) throw new Error(`no session "${ref}" (see \`yxu sessions --all\`)`);
  throw new Error(`"${ref}" matches ${hits.length} sessions: ${hits.slice(0, 5).map((s) => s.id).join(", ")}…`);
}

export function deleteSession(id: string) {
  rmSync(fileOf(id), { force: true });
}

export function renameSession(id: string, title: string) {
  const s = findSession(id);
  s.title = titleFrom(title);
  writeFileSync(fileOf(s.id), `${JSON.stringify(s, null, 2)}\n`);
}

/** The session's tasks, back from their records: those with a branch are still pending. */
export function restoreTasks(s: SessionFile, into: Session) {
  for (const id of s.tasks) {
    const rec = readTaskRecord(s.root, id) as (SessionTask & { parents?: string[] }) | undefined;
    if (!rec) continue;
    const alive = rec.branch && tryGit(s.root, "rev-parse", "--verify", "--quiet", branchFor(id)).ok;
    into.tasks.set(id, { ...rec, branch: alive ? rec.branch : undefined, prompt: rec.prompt ?? "", parents: rec.parents ?? [], discarded: !alive });
  }
}

/** "3m ago", "2h ago", "5d ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Home directory as ~ for display. */
export const tildePath = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/** One line per session, for lists. */
export function describe(s: SessionFile, withRepo: boolean): string {
  const pending = s.tasks.filter((id) => tryGit(s.root, "rev-parse", "--verify", "--quiet", branchFor(id)).ok).length;
  const bits = [`${s.conversation.turn} turn${s.conversation.turn === 1 ? "" : "s"}`, ago(s.updatedAt), ...(pending ? [`${pending} pending`] : []), ...(s.folder !== s.root ? [`in ${tildePath(s.folder)}`] : [])];
  return `${s.id}  ${s.title}  ·  ${bits.join(" · ")}${withRepo ? `  ·  ${tildePath(s.root)}` : ""}`;
}
