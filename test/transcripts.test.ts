import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recapPreamble } from "../src/conversation.ts";
import { conversationExists } from "../src/orchestrator/run.ts";
import { deleteTranscripts, FileSessionStore, hasTranscript, transcriptsDir } from "../src/transcripts.ts";

let data: string;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "yxu-tr-"));
  process.env.YXU_DATA_DIR = data;
});
afterEach(() => {
  delete process.env.YXU_DATA_DIR;
  rmSync(data, { recursive: true, force: true });
});

const key = { projectKey: "-tmp-repo", sessionId: "s-1" };

describe("yxu's copy of Claude's transcripts", () => {
  test("append keeps order and skips replayed entries; load returns them, or null if never written", async () => {
    const st = new FileSessionStore();
    expect(await st.load(key)).toBeNull();
    await st.append(key, [{ type: "user", uuid: "a" }, { type: "assistant", uuid: "b" }]);
    await st.append(key, [{ type: "assistant", uuid: "b" }, { type: "title", title: "x" }, { type: "user", uuid: "c" }]); // b replayed
    expect((await st.load(key))!.map((e) => e.uuid ?? e.type)).toEqual(["a", "b", "title", "c"]);
    // A new store (another process) still knows what was written.
    await new FileSessionStore().append(key, [{ type: "user", uuid: "a" }, { type: "user", uuid: "d" }]);
    expect((await st.load(key))!.map((e) => e.uuid ?? e.type)).toEqual(["a", "b", "title", "c", "d"]);
    expect(transcriptsDir()).toBe(join(data, "transcripts"));
    expect(readFileSync(join(data, "transcripts", "-tmp-repo", "s-1.jsonl"), "utf8").trim().split("\n")).toHaveLength(5);
  });

  test("subagent transcripts, listing, and deleting", async () => {
    const st = new FileSessionStore();
    await st.append(key, [{ type: "user", uuid: "a" }]);
    await st.append({ ...key, subpath: "subagents/agent-1" }, [{ type: "user", uuid: "x" }]);
    await st.append({ projectKey: "-tmp-repo", sessionId: "s-2" }, [{ type: "user", uuid: "y" }]);
    expect((await st.listSessions("-tmp-repo")).map((s) => s.sessionId).sort()).toEqual(["s-1", "s-2"]);
    expect(await st.listSubkeys(key)).toEqual(["subagents_agent-1"]);
    expect(hasTranscript("s-1")).toBe(true);
    expect(hasTranscript("nope")).toBe(false);
    deleteTranscripts(["s-1"]);
    expect(hasTranscript("s-1")).toBe(false);
    expect(existsSync(join(data, "transcripts", "-tmp-repo", "s-1~subagents_agent-1.jsonl"))).toBe(false);
    expect(hasTranscript("s-2")).toBe(true);
    await st.delete({ projectKey: "-tmp-repo", sessionId: "s-2" });
    expect(await st.load({ projectKey: "-tmp-repo", sessionId: "s-2" })).toBeNull();
  });

  test("a conversation exists if yxu has a copy; otherwise only if Claude Code has it", async () => {
    await new FileSessionStore().append({ projectKey: "-x", sessionId: "kept" }, [{ type: "user", uuid: "a" }]);
    expect(await conversationExists("kept", data)).toBe(true);
    expect(await conversationExists("00000000-0000-4000-8000-000000000000", data)).toBe(false);
  });

  test("without either copy, the turns yxu recorded are the recap", () => {
    expect(recapPreamble([])).toBe("");
    const r = recapPreamble([
      { turn: 1, goal: "Remember the mascot is Ziggy", finalText: "OK" },
      { turn: 2, goal: "Add a login form", finalText: "Done: task t1" },
    ]);
    expect(r).toStartWith("[yxu] This continues an earlier conversation whose full history is no longer available.");
    expect(r).toContain("The user asked: Remember the mascot is Ziggy\nYou answered: OK");
    expect(r).toContain("You answered: Done: task t1");
    expect(r.endsWith("[yxu] Now the user says:\n")).toBe(true);
  });
});
