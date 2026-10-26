import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { git, YXU_IDENTITY } from "../src/git.ts";
import { Session, TaskOps } from "../src/ops.ts";
import { describe as describeReq, type Answer, type PermissionRequest } from "../src/permissions.ts";

let root: string;
let remote: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yxu-co-"));
  remote = mkdtempSync(join(tmpdir(), "yxu-co-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", ".");
  git(root, ...YXU_IDENTITY, "commit", "-qm", "init");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@t");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

const ops = (answers: Answer[], mode = "ask", asked: PermissionRequest[] = []) =>
  new TaskOps(parseConfig(`agents:\n  a: { cli: opencode }\nsettings: { checkout_commands: ${mode} }\n`, join(root, "yxu.yaml")), root, new Session(), {
    ask: async (req) => {
      asked.push(req);
      return answers.shift() ?? "deny";
    },
  });

describe("commands in the user's checkout", () => {
  test("read-only git runs without asking; the rest asks, runs once approved, and really commits and pushes", async () => {
    writeFileSync(join(root, "feature.ts"), "export const f = 1;\n");
    writeFileSync(join(root, "secret.txt"), "keep out\n");
    const asked: PermissionRequest[] = [];
    const o = ops(["once", "once", "once"], "ask", asked);
    const st = await o.checkout("git status --short");
    expect(st.result!.output).toContain("?? feature.ts");
    expect(asked).toHaveLength(0);

    expect((await o.checkout("git add -A -- . ':!secret.txt'", "stage everything except secret.txt")).result!.ok).toBe(true);
    expect(describeReq(asked[0]!)).toBe("orchestrator (in your checkout) wants to run `git add -A -- . ':!secret.txt'` — stage everything except secret.txt");
    expect((await o.checkout('git commit -qm "Add feature"')).result!.ok).toBe(true);
    expect((await o.checkout("git push -q origin main")).result!.ok).toBe(true);
    expect(asked).toHaveLength(3);
    expect(git(remote, "show", "main:feature.ts")).toBe("export const f = 1;");
    expect(() => git(remote, "show", "main:secret.txt")).toThrow();
    expect(existsSync(join(root, "secret.txt"))).toBe(true);
  });

  test("no, always, nobody to ask, off and allow; chained commands are never read-only", async () => {
    const asked: PermissionRequest[] = [];
    const o = ops(["deny", "always"], "ask", asked);
    expect(await o.checkout("git stash")).toEqual({ denied: "the user said no" });
    expect(git(root, "stash", "list")).toBe("");
    await o.checkout("git fetch -q");
    await o.checkout("git fetch -q"); // "always" this session: not asked again
    expect(asked).toHaveLength(2);
    await o.checkout("git status; touch pwned");
    expect(asked).toHaveLength(3); // looked like status, but chains: asked (and refused)
    expect(existsSync(join(root, "pwned"))).toBe(false);

    const nobody = new TaskOps(parseConfig("agents:\n  a: { cli: opencode }\n", join(root, "yxu.yaml")), root, new Session(), {});
    expect((await nobody.checkout("git commit -m x")).denied).toContain("nobody can approve");
    expect((await nobody.checkout("git log --oneline -1")).result!.ok).toBe(true);
    expect((await ops([], "off").checkout("git status")).denied).toContain("turned off");
    writeFileSync(join(root, "b.txt"), "b\n");
    expect((await ops([], "allow").checkout("git add b.txt")).result!.ok).toBe(true);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("b.txt");
  });
});
