import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextPatch, saveConfigPatch } from "../src/config-edit.ts";
import { DEFAULT_YAML, parseConfig, parseTokens } from "../src/config.ts";
import { buildContextPrompt, compactInstructions, compactSettings, formatTokens, parseTokensArg, settingSources } from "../src/context.ts";
import { drain } from "../src/orchestrator/run.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-ctx-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cfgWith = (yaml: string) => parseConfig(`agents:\n  a: { cli: opencode }\n${yaml}`, join(root, "yxu.yaml"));

describe("config: context & compact", () => {
  test("defaults", () => {
    const c = cfgWith("");
    expect(c.context).toMatchObject({ memory: true, project_instructions: true, include: [] });
    expect(c.compact).toMatchObject({ auto: true, window: "auto", warn_at: 0.8 });
  });
  test("token counts accept 200k / 1m / numbers", () => {
    expect(parseTokens("200k")).toBe(200_000);
    expect(parseTokens("1m")).toBe(1_000_000);
    expect(parseTokens(150000)).toBe(150_000);
    expect(cfgWith("compact:\n  window: 250k\n").compact.window).toBe(250_000);
    expect(parseTokensArg("auto")).toBe("auto");
    expect(parseTokensArg("1.5m")).toBe(1_500_000);
    expect(parseTokensArg("lots")).toBeUndefined();
  });
  test("window outside 100k–1m is rejected", () => {
    expect(() => cfgWith("compact:\n  window: 50k\n")).toThrow(/compact.window/);
    expect(() => cfgWith("compact:\n  window: 2m\n")).toThrow(/compact.window/);
  });
  test("context.max_diff_chars overrides settings", () => {
    expect(cfgWith("context:\n  max_diff_chars: 4000\n").settings.max_diff_chars).toBe(4000);
  });
  test("default yaml documents both sections", () => {
    const c = parseConfig(DEFAULT_YAML, "d");
    expect(c.context.memory).toBe(true);
    expect(c.compact.auto).toBe(true);
  });
});

describe("buildContextPrompt", () => {
  test("notes, included files (with truncation), missing and escaping paths", () => {
    writeFileSync(join(root, "ARCH.md"), "# Architecture\nlayers");
    writeFileSync(join(root, "big.txt"), "x".repeat(50));
    const cfg = cfgWith(
      "context:\n  notes: Never touch migrations/\n  include: [ARCH.md, big.txt, nope.md, ../etc/passwd]\n  include_max_chars: 10\ncompact:\n  instructions: Keep API names.\n",
    );
    const { text, files } = buildContextPrompt(cfg, root);
    expect(text).toContain("Never touch migrations/");
    expect(text).toContain("## Included file: ARCH.md");
    expect(text).toContain("[truncated: 40 more characters]");
    expect(text).toContain("Keep API names.");
    expect(text).toContain("task_id"); // base guidance always present
    expect(files).toEqual([
      { path: "ARCH.md", chars: 21, truncated: true },
      { path: "big.txt", chars: 50, truncated: true },
      { path: "nope.md", chars: 0, truncated: false, missing: true },
      { path: "../etc/passwd", chars: 0, truncated: false, missing: true, error: "outside the repository" },
    ]);
    expect(text).not.toContain("root:"); // nothing outside the repo was read
  });
  test("compaction settings, instructions and setting sources", () => {
    expect(compactSettings(cfgWith(""))).toEqual({ autoCompactEnabled: true });
    expect(compactSettings(cfgWith("compact:\n  auto: false\n  window: 300k\n"))).toEqual({ autoCompactEnabled: false, autoCompactWindow: 300_000 });
    expect(compactInstructions(cfgWith("compact:\n  instructions: Keep X.\n"), "and Y")).toMatch(/task_id.*Keep X\. and Y$/);
    expect(settingSources(cfgWith(""))).toEqual(["project"]);
    expect(settingSources(cfgWith("context:\n  project_instructions: false\n"))).toEqual([]);
    expect(settingSources(cfgWith("orchestrator:\n  user_settings: true\n"))).toBeUndefined();
  });
  test("formatTokens", () => {
    expect([formatTokens(950), formatTokens(41_200), formatTokens(1_000_000), formatTokens(1_500_000)]).toEqual(["950", "41k", "1m", "1.5m"]);
  });
});

describe("saveConfigPatch", () => {
  test("keeps comments and other settings; writes only valid configs", () => {
    const file = join(root, "yxu.yaml");
    writeFileSync(file, "# my config\nagents:\n  a: { cli: opencode } # the coder\ncompact:\n  auto: true # keep on\n");
    const cfg = parseConfig(readFileSync(file, "utf8"), file);
    cfg.compact.auto = false;
    cfg.compact.window = 300_000;
    cfg.context.include = ["docs/A.md"];
    cfg.context.notes = "be careful";
    saveConfigPatch(root, contextPatch(cfg));
    const out = readFileSync(file, "utf8");
    expect(out).toContain("# my config");
    expect(out).toContain("# the coder");
    const back = parseConfig(out, file);
    expect(back.compact).toMatchObject({ auto: false, window: 300_000 });
    expect(back.context).toMatchObject({ include: ["docs/A.md"], notes: "be careful" });

    const before = readFileSync(file, "utf8");
    expect(() => saveConfigPatch(root, [{ path: ["compact", "window"], value: 5 }])).toThrow(/compact.window/);
    expect(readFileSync(file, "utf8")).toBe(before); // nothing written
  });
  test("built-in defaults: creates a project yxu.yaml", () => {
    const cfg = parseConfig(DEFAULT_YAML, "(built-in defaults)");
    cfg.context.memory = false;
    const file = saveConfigPatch(root, contextPatch(cfg));
    expect(file).toBe(join(root, "yxu.yaml"));
    expect(existsSync(file)).toBe(true);
    expect(parseConfig(readFileSync(file, "utf8"), file).context.memory).toBe(false);
  });
});

describe("drain (orchestrator stream)", () => {
  async function* stream(msgs: unknown[]) {
    for (const m of msgs) yield m as never;
  }
  const result = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, result: "ok", session_id: "s1" };

  test("reports compactions and reads context usage before the stream ends", async () => {
    const seen: unknown[] = [];
    const q = Object.assign(
      stream([
        { type: "system", subtype: "compact_boundary", session_id: "s1", compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 22_000 } },
        result,
      ]),
      {
        getContextUsage: async () => ({
          totalTokens: 41_000,
          maxTokens: 200_000,
          rawMaxTokens: 1_000_000,
          percentage: 20.5,
          isAutoCompactEnabled: true,
          autoCompactThreshold: 167_000,
          categories: [
            { name: "Messages", tokens: 30_000, kind: "used" },
            { name: "Free space", tokens: 150_000, kind: "free" },
          ],
        }),
      },
    );
    const r = await drain(q, { assistantText() {}, toolCall() {}, compacted: (i) => seen.push(i) });
    expect(seen).toEqual([{ trigger: "auto", preTokens: 180_000, postTokens: 22_000 }]);
    expect(r.compactions).toHaveLength(1);
    expect(r.context).toEqual({ tokens: 41_000, max: 200_000, percentage: 20.5, autoCompact: true, threshold: 167_000, categories: [{ name: "Messages", tokens: 30_000, kind: "used" }] });
    expect(r.sessionId).toBe("s1");
  });

  test("usage is optional: a failing or missing getContextUsage doesn't break the run", async () => {
    expect((await drain(stream([result]))).context).toBeUndefined();
    const q = Object.assign(stream([result]), { getContextUsage: async () => { throw new Error("unsupported"); } });
    const r = await drain(q);
    expect(r.ok).toBe(true);
    expect(r.context).toBeUndefined();
  });
});
