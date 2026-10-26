import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_YAML, parseConfig, type Config } from "../src/config.ts";
import { git, worktreeFor, YXU_IDENTITY } from "../src/git.ts";
import { renderTemplate, runPipeline } from "../src/orchestrator/pipeline.ts";
import type { askOrchestrator, OrchestratorRender } from "../src/orchestrator/run.ts";
import { fakeCli, pathWith } from "./helpers.ts";

let root: string;
let bin: string;
const origPath = process.env.PATH;

// Fake `opencode`: writes files for every "WRITE <file> <word>" in the prompt; fixes verify failures.
const FAKE_AGENT = `#!/bin/sh
for a; do last="$a"; done
printf '%s\\n' "$last" | grep -oE 'WRITE [^ ]+ [^ ]+' | while read _ f c; do printf '%s\\n' "$c" > "$f"; done
case "$last" in *"The check"*) echo fixed > c.txt ;; esac
echo '{"type":"text","sessionID":"ses_fake","part":{"type":"text","text":"done"}}'
echo '{"type":"step_finish","sessionID":"ses_fake","part":{"reason":"stop","tokens":{"input":1,"output":1},"cost":0}}'
`;

const silent: OrchestratorRender = { assistantText() {}, toolCall() {}, hooks: {} };

function config(yaml: string): Config {
  return parseConfig(yaml, "test");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-pipe-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  bin = mkdtempSync(join(tmpdir(), "yxu-bin-"));
  fakeCli(bin, "opencode", FAKE_AGENT);
  process.env.PATH = pathWith(bin, origPath);
});

afterEach(() => {
  process.env.PATH = origPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const PIPELINE_YAML = `
agents:
  coder:
    cli: opencode
workflows:
  feature:
    mode: pipeline
    steps:
      - { id: plan, type: plan, max_tasks: 3 }
      - { id: implement, type: delegate, agent: coder, for_each: plan }
      - { id: verify, type: verify, command: "test -f a.txt && test -f b.txt && test -f c.txt", fix_agent: coder }
      - { id: review, type: review, fix_agent: coder, max_rounds: 2 }
`;

describe("runPipeline", () => {
  test("plan → parallel implement → combine → verify+fix → review+fix", async () => {
    const cfg = config(PIPELINE_YAML);
    const calls: string[] = [];
    let reviews = 0;
    const askImpl = (async ({ system }) => {
      if (system.includes("planner")) {
        calls.push("plan");
        return {
          costUsd: 0.1,
          value: {
            summary: "two files",
            tasks: [
              { title: "A", task: "WRITE a.txt alpha" },
              { title: "B", task: "WRITE b.txt beta" },
            ],
          },
        };
      }
      calls.push("review");
      reviews++;
      return {
        costUsd: 0.05,
        value:
          reviews === 1
            ? { approved: false, summary: "missing d", fixes: [{ task: "WRITE d.txt delta" }] }
            : { approved: true, summary: "good", fixes: [] },
      };
    }) as typeof askOrchestrator;

    const out = await runPipeline({
      goal: "make files",
      cfg,
      workflow: { ...cfg.workflows.feature!, name: "feature" },
      root,
      render: silent,
      abort: new AbortController(),
      askImpl,
    });

    expect(out.finalText).toContain("completed");
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["plan", "review", "review"]);
    expect(out.costUsd).toBeCloseTo(0.2);
    const head = out.headTaskId!;
    const wt = worktreeFor(root, head);
    for (const f of ["a.txt", "b.txt", "c.txt", "d.txt"]) expect(existsSync(join(wt, f))).toBe(true);
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("alpha\n");
    // One result to apply; the user's checkout is untouched.
    expect(out.session.tips().map((t) => t.taskId)).toEqual([head]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  test("failing verify without fix agent stops the pipeline", async () => {
    const cfg = config(`
agents:
  coder: { cli: opencode }
workflows:
  w:
    mode: pipeline
    steps:
      - { id: build, type: delegate, agent: coder, prompt: "WRITE a.txt {{goal}}" }
      - { id: check, type: verify, command: "test -f missing.txt" }
      - { id: never, type: delegate, agent: coder, prompt: "WRITE z.txt z" }
`);
    const out = await runPipeline({
      goal: "hello",
      cfg,
      workflow: { ...cfg.workflows.w!, name: "w" },
      root,
      render: silent,
      abort: new AbortController(),
      askImpl: (async () => {
        throw new Error("no orchestrator calls expected");
      }) as typeof askOrchestrator,
    });
    expect(out.ok).toBe(false);
    expect(out.finalText).toContain("✓ build");
    expect(out.finalText).toContain("✗ check");
    expect(out.finalText).not.toContain("never");
    expect(readFileSync(join(worktreeFor(root, out.headTaskId!), "a.txt"), "utf8")).toBe("hello\n");
  });
});

describe("renderTemplate", () => {
  test("fills goal and step fields", () => {
    const ctx = { plan: { summary: "S", output: "O" } };
    expect(renderTemplate("{{goal}} / {{plan.summary}} / {{plan}} / {{plan.output}} / {{nope.output}}", "G", ctx)).toBe(
      "G / S / S / O / ",
    );
  });
});

describe("pipeline config validation", () => {
  const base = "agents:\n  coder: { cli: opencode }\nworkflows:\n  w:\n    mode: pipeline\n    steps:\n";
  test("default yaml has a valid feature pipeline", () => {
    expect(config(DEFAULT_YAML).workflows.feature?.steps?.map((s) => s.type)).toEqual(["delegate", "plan", "delegate", "delegate", "verify", "review"]);
  });
  test("for_each must reference an earlier plan step", () => {
    expect(() => config(`${base}      - { id: impl, type: delegate, agent: coder, for_each: plan }\n`)).toThrow(/for_each/);
  });
  test("delegate needs prompt or for_each", () => {
    expect(() => config(`${base}      - { id: impl, type: delegate, agent: coder }\n`)).toThrow(/needs a prompt/);
  });
  test("verify needs a command", () => {
    expect(() => config(`${base}      - { id: v, type: verify }\n`)).toThrow(/needs a command/);
  });
  test("unknown agent in step", () => {
    expect(() => config(`${base}      - { id: r, type: review, fix_agent: ghost }\n`)).toThrow(/unknown agent "ghost"/);
  });
  test("pipeline without steps", () => {
    expect(() => config("agents:\n  a: { cli: claude }\nworkflows:\n  w: { mode: pipeline }\n")).toThrow(/needs steps/);
  });
});
