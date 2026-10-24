import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claude } from "../src/adapters/claude.ts";
import { commandcode } from "../src/adapters/commandcode.ts";
import { opencode } from "../src/adapters/opencode.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const task = { id: "t1", prompt: "do it", cwd: "/repo" };

describe("opencode", () => {
  test("parses a successful run", () => {
    const { events, result } = opencode.parse(fixture("opencode-ok.ndjson"), "", 0);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Done.");
    expect(result.sessionId).toStartWith("ses_");
    expect(result.turns).toBe(3);
    expect(result.usage.outputTokens).toBe(48 + 114 + 3);
    expect(events.filter((e) => e.kind === "tool").map((e: any) => e.name)).toEqual(["read", "edit"]);
  });

  test("empty output is a failure", () => {
    const { result } = opencode.parse("", "boom\n", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
  });

  test("builds argv", () => {
    // Safe by default: no --auto (opencode's "approve everything") unless yolo is chosen.
    expect(opencode.command(task, { cli: "opencode", model: "a/b" })).toEqual([
      "opencode", "run", "--format", "json", "--dir", "/repo", "--model", "a/b", "do it",
    ]);
    expect(opencode.command(task, { cli: "opencode", permission: "yolo" })).toContain("--auto");
    expect(opencode.command(task, { cli: "opencode", permission: "plan" })).toContain("plan");
  });
});

describe("commandcode", () => {
  test("parses a run_error (usage limit)", () => {
    const { events, result } = commandcode.parse(fixture("commandcode-error.ndjson"), "", 5);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("weekly usage limit");
    expect(events[0]).toEqual({ kind: "start", sessionId: "321f6b2f-029e-4593-9b81-1feb6d64a3ce" });
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  test("parses a success result line", () => {
    const out = [
      '{"type":"event","event":{"type":"run_start","sessionId":"s1"}}',
      '{"type":"event","event":{"type":"run_end","result":{"finalText":"ok","turnCount":2}}}',
      '{"type":"result","subtype":"success","sessionId":"s1","usage":{"inputTokens":10,"outputTokens":5},"finalText":"ok"}',
    ].join("\n");
    const { result } = commandcode.parse(out, "", 0);
    expect(result).toMatchObject({ ok: true, summary: "ok", turns: 2, sessionId: "s1" });
    expect(result.usage.inputTokens).toBe(10);
  });

  test("builds argv", () => {
    const argv = commandcode.command(task, { cli: "commandcode", model: "deepseek/deepseek-v4-flash" });
    expect(argv.slice(0, 3)).toEqual(["cmd", "-p", "do it"]);
    expect(argv).toContain("--no-auto-update");
    expect(argv.join(" ")).toContain("--permission-mode accept-edits");
    expect(commandcode.command(task, { cli: "commandcode", permission: "yolo" }).join(" ")).toContain("--permission-mode yolo");
    expect(argv.join(" ")).toContain("--model deepseek/deepseek-v4-flash");
  });
});

describe("claude", () => {
  test("parses a successful run", () => {
    const { result } = claude.parse(fixture("claude-ok.json"), "", 0);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("mul(a, b)");
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.turns).toBe(3);
    expect(result.usage.outputTokens).toBe(366);
  });

  test("garbage output is a failure", () => {
    const { result } = claude.parse("not json", "auth error", 1);
    expect(result).toMatchObject({ ok: false, error: "auth error" });
  });

  test("defaults to acceptEdits", () => {
    expect(claude.command(task, { cli: "claude" }).join(" ")).toContain("--permission-mode acceptEdits");
  });
});
