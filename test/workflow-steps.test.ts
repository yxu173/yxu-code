import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import { loadLayers } from "../src/config-layers.ts";
import { branchFor, git, YXU_IDENTITY } from "../src/git.ts";
import { resolveInputs, runPipeline, type PipelineOptions } from "../src/orchestrator/pipeline.ts";
import type { OrchestratorRender } from "../src/orchestrator/run.ts";
import { fakeCli, pathWith } from "./helpers.ts";

let root: string;
let bin: string;
let scratch: string;
const origPath = process.env.PATH;

// Fake `opencode`: writes files for every "WRITE <file> <word>" in the prompt.
const FAKE_AGENT = `#!/bin/sh
for a; do last="$a"; done
printf '%s\\n' "$last" | grep -oE 'WRITE [^ ]+ [^ ]+' | while read _ f c; do printf '%s\\n' "$c" > "$f"; done
echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"done"}}'
echo '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{"input":1,"output":1},"cost":0}}'
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-wf-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  bin = mkdtempSync(join(tmpdir(), "yxu-bin-"));
  scratch = mkdtempSync(join(tmpdir(), "yxu-scratch-")).replaceAll("\\", "/"); // also inside YAML strings on Windows
  fakeCli(bin, "opencode", FAKE_AGENT);
  process.env.PATH = pathWith(bin, origPath);
});

afterEach(() => {
  process.env.PATH = origPath;
  for (const d of [root, bin, scratch]) rmSync(d, { recursive: true, force: true });
});

const AGENTS = "agents:\n  coder: { cli: opencode }\n";

function cfg(workflows: string): Config {
  return parseConfig(`${AGENTS}workflows:\n${workflows}`, "test");
}

function run(c: Config, name: string, extra: Partial<PipelineOptions> = {}) {
  const steps: string[] = [];
  const render: OrchestratorRender = {
    assistantText() {},
    toolCall() {},
    hooks: {},
    step: ({ id, note }) => steps.push(note ? `${id}(${note})` : id),
  };
  const p = runPipeline({
    goal: "the goal",
    cfg: c,
    workflow: { ...c.workflows[name]!, name },
    root,
    render,
    abort: new AbortController(),
    askImpl: (async () => {
      throw new Error("no model calls in these tests");
    }) as never,
    ...extra,
  });
  return p.then((r) => ({ ...r, steps }));
}

const fileAt = (taskId: string | undefined, file: string) => git(root, "show", `${branchFor(taskId!)}:${file}`);

describe("shell steps", () => {
  test("changes become a task in a worktree; the user's checkout is untouched; output feeds later steps", async () => {
    const c = cfg(`  fmt:
    mode: pipeline
    outputs: { said: "{{ hello.output }}", branch: "{{ check.output }}" }
    steps:
      - { id: hello, type: shell, command: "echo hi from {{inputs.who}}" }
      - { id: write, type: shell, command: "printf formatted > README && echo wrote" }
      - { id: check, type: shell, command: "test \\"$(cat README)\\" = formatted && echo $YXU_HEAD_BRANCH" }
    inputs: { who: { default: yxu } }
`);
    const r = await run(c, "fmt");
    expect(r.ok).toBe(true);
    expect(r.outputs?.said).toBe("hi from yxu");
    expect(readFileSync(join(root, "README"), "utf8")).toBe("x\n"); // never touched
    expect(fileAt(r.headTaskId, "README")).toBe("formatted");
    expect(r.session.tasks.get(r.headTaskId!)?.agent).toBe("shell");
    expect(r.outputs?.branch).toBe(`yxu/${r.headTaskId}`); // env for the step: the work so far
  });

  test("a failing command stops the workflow; continue_on_error records it and goes on", async () => {
    const c = cfg(`  w:
    mode: pipeline
    steps:
      - { id: lint, type: shell, command: "echo 2 problems; exit 3", continue_on_error: true }
      - { id: report, type: shell, command: "echo lint ok={{lint.ok}}" }
      - { id: boom, type: shell, command: "exit 1" }
      - { id: never, type: shell, command: "echo unreachable" }
`);
    const r = await run(c, "w");
    expect(r.ok).toBe(false);
    expect(r.finalText).toMatch(/✗ lint: `echo 2 problems; exit 3` failed \(exit 3\)/);
    expect(r.finalText).toContain("✓ report");
    expect(r.finalText).toContain("✗ boom");
    expect(r.finalText).not.toContain("never");
  });

  test("in: repo runs in the checkout and sees the result branch", async () => {
    const c = cfg(`  w:
    mode: pipeline
    steps:
      - { id: change, type: delegate, agent: coder, prompt: "WRITE a.txt alpha" }
      - { id: show, type: shell, in: repo, command: "git show $YXU_HEAD_BRANCH:a.txt" }
`);
    const r = await run(c, "w");
    expect(r.ok).toBe(true);
    expect(r.finalText).toContain("✓ show");
  });
});

describe("conditions", () => {
  test("if / unless with step results and inputs", async () => {
    const c = cfg(`  w:
    mode: pipeline
    inputs: { mode: { default: quick } }
    steps:
      - { id: probe, type: shell, command: "exit 1", continue_on_error: true }
      - { id: when-failed, type: shell, if: "{{ !probe.ok }}", command: "echo fixing" }
      - { id: when-ok, type: shell, if: "probe.ok", command: "echo fine" }
      - { id: slow, type: shell, unless: "inputs.mode == 'quick'", command: "echo slow" }
`);
    const r = await run(c, "w");
    expect(r.ok).toBe(true);
    expect(r.finalText).toContain("✓ when-failed");
    expect(r.finalText).toContain("○ when-ok: skipped");
    expect(r.finalText).toContain("○ slow: skipped");
    const r2 = await run(c, "w", { inputs: { mode: "full" } });
    expect(r2.finalText).toContain("✓ slow");
  });
});

describe("parallel and loop", () => {
  test("parallel branches are combined into one result", async () => {
    const c = cfg(`  w:
    mode: pipeline
    steps:
      - type: parallel
        id: both
        steps:
          - { id: a, type: delegate, agent: coder, prompt: "WRITE a.txt alpha" }
          - { id: b, type: shell, command: "echo beta > b.txt" }
      - { id: check, type: shell, command: "cat a.txt b.txt" }
`);
    const r = await run(c, "w");
    expect(r.ok).toBe(true);
    expect(fileAt(r.headTaskId, "a.txt")).toBe("alpha");
    expect(fileAt(r.headTaskId, "b.txt")).toBe("beta");
    expect(r.session.tasks.get(r.headTaskId!)?.agent).toBe("combine");
  });

  test("loop repeats until the condition holds, or fails after max_rounds", async () => {
    const counter = join(scratch, "n");
    const c = cfg(`  w:
    mode: pipeline
    steps:
      - type: loop
        id: retry
        until: "{{ attempt.ok }}"
        max_rounds: 5
        steps:
          - { id: attempt, type: shell, continue_on_error: true, command: "echo x >> ${counter}; test $(wc -l < ${counter}) -ge 3" }
  never:
    mode: pipeline
    steps:
      - { id: spin, type: loop, until: "false", max_rounds: 2, steps: [{ id: tick, type: shell, command: "true" }] }
`);
    const r = await run(c, "w");
    expect(r.ok).toBe(true);
    expect(r.finalText).toContain("✓ retry: done after 3 round(s)");
    expect(r.steps.filter((s) => s.startsWith("retry(round"))).toEqual(["retry(round 2/5)", "retry(round 3/5)"]);
    const n = await run(c, "never");
    expect(n.ok).toBe(false);
    expect(n.finalText).toContain("still not done after 2 round(s)");
  });
});

describe("gates", () => {
  const c = () =>
    cfg(`  w:
    mode: pipeline
    inputs: { version: {} }
    steps:
      - { id: ask, type: gate, message: "Release {{inputs.version}}?" }
      - { id: go, type: shell, command: "echo released" }
`);

  test("approved gates continue; declined gates stop", async () => {
    const asked: string[] = [];
    const yes = await run(c(), "w", { inputs: { version: "1.2.0" }, gate: async (m) => (asked.push(m), true) });
    expect(asked).toEqual(["Release 1.2.0?"]);
    expect(yes.finalText).toContain("✓ go");
    const no = await run(c(), "w", { inputs: { version: "1.2.0" }, gate: async () => false });
    expect(no.ok).toBe(false);
    expect(no.finalText).toContain('stopped at gate "ask"');
    expect(no.finalText).not.toContain("✓ go");
  });

  test("without anyone to ask, a gate fails with a hint", async () => {
    const r = await run(c(), "w", { inputs: { version: "1" } });
    expect(r.ok).toBe(false);
    expect(r.finalText).toMatch(/needs your approval.*--yes/);
  });
});

describe("workflow steps and inputs", () => {
  test("a workflow can call another with inputs and use its outputs", async () => {
    const c = cfg(`  bump:
    mode: pipeline
    inputs: { to: {} }
    outputs: { tag: "v{{inputs.to}}" }
    steps:
      - { id: write, type: shell, command: "echo {{inputs.to}} > VERSION" }
  release:
    mode: pipeline
    inputs: { version: { description: "x.y.z" } }
    outputs: { tag: "{{ bump.outputs.tag }}" }
    steps:
      - { id: bump, type: workflow, workflow: bump, inputs: { to: "{{inputs.version}}" } }
      - { id: after, type: shell, command: "cat VERSION" }
`);
    const r = await run(c, "release", { inputs: { version: "2.0.0" } });
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ tag: "v2.0.0" });
    expect(fileAt(r.headTaskId, "VERSION")).toBe("2.0.0");
  });

  test("inputs: defaults, types, unknown and missing ones", () => {
    const wf = { mode: "pipeline" as const, name: "w", inputs: { n: { default: 3 }, flag: { default: false }, need: { description: "the thing" }, opt: { required: false } } };
    expect(resolveInputs(wf, { need: "x" })).toEqual({ n: 3, flag: false, need: "x" });
    expect(resolveInputs(wf, { need: "x", n: "7", flag: "yes" })).toMatchObject({ n: 7, flag: true });
    expect(() => resolveInputs(wf, {})).toThrow(/needs input need \(the thing\)/);
    expect(() => resolveInputs(wf, { need: "x", nope: "1" })).toThrow(/no input "nope"/);
  });
});

describe("validation", () => {
  const bad = (wf: string) => () => cfg(wf);
  test("unknown workflow, cycles, reserved ids, bad conditions, duplicate nested ids", () => {
    expect(bad("  a: { mode: pipeline, steps: [{ id: x, type: workflow, workflow: nope }] }\n")).toThrow(/unknown workflow "nope"/);
    expect(
      bad("  a: { mode: pipeline, steps: [{ id: x, type: workflow, workflow: b }] }\n  b: { mode: pipeline, steps: [{ id: y, type: workflow, workflow: a }] }\n"),
    ).toThrow(/cycle: a → b → a/);
    expect(bad("  a: { mode: pipeline, steps: [{ id: goal, type: shell, command: x }] }\n")).toThrow(/reserved/);
    expect(bad('  a: { mode: pipeline, steps: [{ id: x, type: shell, command: x, if: "a &&" }] }\n')).toThrow(/step "x" if/);
    expect(bad("  a: { mode: pipeline, steps: [{ id: x, type: parallel, steps: [{ id: x, type: shell, command: y }] }] }\n")).toThrow(/duplicate step id "x"/);
    expect(bad('  a: { mode: pipeline, steps: [{ id: x, type: shell, command: "{{ ( }}" }] }\n')).toThrow(/step "x" command/);
  });
});

describe("workflow files", () => {
  test(".yxu/workflows/<name>.yaml joins the project layer; errors name the file", () => {
    writeFileSync(join(root, "yxu.yaml"), AGENTS);
    mkdirSync(join(root, ".yxu", "workflows"), { recursive: true });
    writeFileSync(join(root, ".yxu", "workflows", "lint.yaml"), "version: 1\nmode: pipeline\ndescription: lint it\nsteps:\n  - { id: l, type: shell, command: 'true' }\n");
    const loaded = loadLayers(root);
    expect(loaded.config.workflows.lint?.description).toBe("lint it");
    expect(loaded.workflowFiles).toEqual({ lint: ".yxu/workflows/lint.yaml" });

    writeFileSync(join(root, ".yxu", "workflows", "bad.yml"), "mode: pipeline\nsteps:\n  - { id: d, type: delegate, agent: ghost, prompt: x }\n");
    expect(() => loadLayers(root)).toThrow(/\.yxu\/workflows\/bad\.yml: workflow "bad": step "d" uses unknown agent "ghost"/);
    rmSync(join(root, ".yxu", "workflows", "bad.yml"));

    writeFileSync(join(root, "yxu.yaml"), `${AGENTS}workflows:\n  lint: { mode: auto }\n`);
    expect(() => loadLayers(root)).toThrow(/defined in both yxu\.yaml and \.yxu\/workflows\/lint\.yaml/);
  });

  test("only yxu's runtime files are git-ignored, so .yxu/workflows can be committed", async () => {
    const c = cfg(`  w: { mode: pipeline, steps: [{ id: s, type: shell, command: "echo hi > f" }] }\n`);
    await run(c, "w");
    mkdirSync(join(root, ".yxu", "workflows"), { recursive: true });
    writeFileSync(join(root, ".yxu", "workflows", "x.yaml"), "mode: auto\n");
    const status = git(root, "status", "--porcelain", "--untracked-files=all");
    expect(status).toContain(".yxu/workflows/x.yaml");
    expect(status).not.toContain(".yxu/runs");
    expect(status).not.toContain(".yxu/worktrees");
    expect(existsSync(join(root, ".yxu", "runs"))).toBe(true);
  });
});
