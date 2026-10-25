import { expect, test } from "bun:test";
import { condition, evaluate, render, shellQuote } from "../src/expr.ts";

const scope = {
  goal: "add a flag",
  inputs: { env: "prod", force: false, version: "1.2.0" },
  verify: { ok: false, exit_code: 1, summary: "`npm test` failed", output: "FAIL src/a.test.ts" },
  plan: { ok: true, summary: "two tasks", tasks: [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }] },
  "lint-js": { ok: true },
  task: { files: ["src/a.ts", "it's here.ts"] },
};

test("paths, literals, comparisons, logic", () => {
  expect(evaluate("verify.ok", scope)).toBe(false);
  expect(evaluate("plan.tasks.length > 3", scope)).toBe(true);
  expect(evaluate("plan.tasks.0.title", scope)).toBe("a");
  expect(evaluate("plan.tasks[1].title", scope)).toBe("b");
  expect(evaluate("lint-js.ok && !verify.ok", scope)).toBe(true);
  expect(evaluate('inputs.env == "prod" || inputs.force', scope)).toBe(true);
  expect(evaluate("verify.exit_code == 1", scope)).toBe(true);
  expect(evaluate("verify.exit_code != '1'", scope)).toBe(false);
  expect(evaluate('verify.output contains "FAIL"', scope)).toBe(true);
  expect(evaluate("(verify.ok || plan.ok) && 2.5 >= 2", scope)).toBe(true);
  expect(evaluate("nothing.here.at.all", scope)).toBeUndefined();
  expect(evaluate("goal.constructor", scope)).toBeUndefined(); // no prototype access
});

test("conditions accept {{ }} or bare expressions; empty lists are false", () => {
  expect(condition("{{ verify.ok }}", scope)).toBe(false);
  expect(condition("!verify.ok", scope)).toBe(true);
  expect(condition("missing.list", { missing: { list: [] } })).toBe(false);
  expect(condition(true, scope)).toBe(true);
  expect(() => condition("verify.ok &&", scope)).toThrow(/expected/);
  expect(() => condition("verify.ok ; rm", scope)).toThrow(/unexpected/);
});

test("templates: step results read as their summary; shell mode quotes every value", () => {
  expect(render("Goal: {{goal}} ({{ plan }}) v{{inputs.version}}", scope)).toBe("Goal: add a flag (two tasks) v1.2.0");
  expect(render("{{missing}}|", scope)).toBe("|");
  expect(render("prettier --write {{task.files}}", scope, { shell: true })).toBe(`prettier --write src/a.ts 'it'\\''s here.ts'`);
  expect(render("echo {{goal}}", { goal: "$(rm -rf /)" }, { shell: true })).toBe("echo '$(rm -rf /)'");
  expect(shellQuote("")).toBe("''");
});
