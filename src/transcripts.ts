/**
 * yxu's own copy of every orchestrator conversation, so a session can be resumed even when
 * Claude Code's history (~/.claude/projects) is gone. Claude Code mirrors each transcript entry
 * here (the Agent SDK's `sessionStore`), and loads from here when resuming.
 *
 * Layout: <sessions dir>/transcripts/<project>/<session id>[.<subpath>].jsonl, one entry per line,
 * de-duplicated by `uuid` (the SDK may replay entries).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { sessionsDir } from "./sessions.ts";

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
const SUB = "~"; // separates a session id from a subagent subpath in file names

export function transcriptsDir(): string {
  return join(sessionsDir(), "..", "transcripts");
}

const fileFor = (k: SessionKey) => join(transcriptsDir(), safe(k.projectKey), `${safe(k.sessionId)}${k.subpath ? SUB + safe(k.subpath) : ""}.jsonl`);

function readEntries(file: string): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionStoreEntry);
    } catch {
      // a torn last line: skip it
    }
  }
  return out;
}

export class FileSessionStore implements SessionStore {
  /** uuids already written, per file (loaded on first use). */
  private seen = new Map<string, Set<string>>();

  private uuids(file: string): Set<string> {
    let set = this.seen.get(file);
    if (!set) {
      set = new Set(existsSync(file) ? readEntries(file).flatMap((e) => (e.uuid ? [e.uuid] : [])) : []);
      this.seen.set(file, set);
    }
    return set;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const file = fileFor(key);
    mkdirSync(join(file, ".."), { recursive: true });
    const seen = this.uuids(file);
    const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
    if (!fresh.length) return;
    for (const e of fresh) if (e.uuid) seen.add(e.uuid);
    appendFileSync(file, fresh.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const file = fileFor(key);
    return existsSync(file) ? readEntries(file) : null;
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    const dir = join(transcriptsDir(), safe(projectKey));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl") && !n.includes(SUB))
      .map((n) => ({ sessionId: n.slice(0, -6), mtime: Math.floor(statSync(join(dir, n)).mtimeMs) }));
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const dir = join(transcriptsDir(), safe(key.projectKey));
    if (!existsSync(dir)) return [];
    const prefix = `${safe(key.sessionId)}${SUB}`;
    return readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl"))
      .map((n) => n.slice(prefix.length, -6));
  }

  async delete(key: SessionKey): Promise<void> {
    rmSync(fileFor(key), { force: true });
    this.seen.delete(fileFor(key));
  }
}

/** One store per process: it remembers which entries it already wrote. */
let store: FileSessionStore | undefined;
export const transcriptStore = () => (store ??= new FileSessionStore());

/** Whether yxu has its own copy of a conversation (in any project). */
export function hasTranscript(sessionId: string): boolean {
  const dir = transcriptsDir();
  if (!existsSync(dir)) return false;
  const name = `${safe(sessionId)}.jsonl`;
  return readdirSync(dir).some((p) => existsSync(join(dir, p, name)));
}

/** Remove yxu's copies of these conversations (with their subagent transcripts). */
export function deleteTranscripts(sessionIds: string[]) {
  const dir = transcriptsDir();
  if (!existsSync(dir)) return;
  const names = new Set(sessionIds.map(safe));
  for (const p of readdirSync(dir)) {
    for (const n of readdirSync(join(dir, p))) {
      const id = n.replace(/\.jsonl$/, "").split(SUB)[0]!;
      if (names.has(id)) rmSync(join(dir, p, n), { force: true });
    }
  }
}
