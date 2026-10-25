import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, installKind, platformAsset, update, type UpdateDeps } from "../src/update.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("versions compare numerically, pre-releases before releases", () => {
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
});

test("install kind and release asset", () => {
  expect(installKind("/x/node_modules/yxu-linux-x64/bin/yxu", true)).toBe("npm");
  expect(installKind("/home/u/.local/bin/yxu", true)).toBe("binary");
  expect(installKind("/usr/bin/bun", false)).toBe("source");
  expect(platformAsset("darwin", "arm64")).toBe("yxu-darwin-arm64.tar.gz");
  expect(platformAsset("win32", "x64")).toBe("yxu-windows-x64.zip");
  expect(() => platformAsset("win32", "arm64")).toThrow(/windows-x64 only/);
});

/** A fake GitHub serving one release whose binary is a shell script printing "new". */
function fakeRelease(tag: string, opts: { badSum?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yxu-upd-"));
  dirs.push(dir);
  writeFileSync(join(dir, "yxu"), "#!/bin/sh\necho new\n");
  const asset = platformAsset();
  Bun.spawnSync(["tar", "-czf", join(dir, asset), "-C", dir, "yxu"]);
  const archive = readFileSync(join(dir, asset));
  const sum = opts.badSum ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex");
  const files: Record<string, string | Buffer> = { [asset]: archive, "checksums.txt": `${sum}  ${asset}\n` };
  const log: string[] = [];
  const deps: UpdateDeps = {
    log: (l) => log.push(l),
    fetch: async (url) => {
      if (url.endsWith("/releases/latest")) return Response.json({ tag_name: tag });
      const name = url.split("/").at(-1)!;
      return files[name] ? new Response(files[name]) : new Response("not found", { status: 404 });
    },
  };
  const target = join(dir, "installed-yxu");
  writeFileSync(target, "old");
  return { deps, log, target };
}

test("up to date: nothing downloaded", async () => {
  const { deps, log, target } = fakeRelease("v0.0.1");
  expect(await update({ kind: "binary", current: "0.0.1", target }, deps)).toBe(0);
  expect(log.join("\n")).toMatch(/up to date/);
  expect(readFileSync(target, "utf8")).toBe("old");
});

test("--check reports an update with exit code 10 and changes nothing", async () => {
  const { deps, log, target } = fakeRelease("v0.2.0");
  expect(await update({ kind: "binary", current: "0.1.0", target, check: true }, deps)).toBe(10);
  expect(log.join("\n")).toMatch(/0\.1\.0 → 0\.2\.0/);
  expect(readFileSync(target, "utf8")).toBe("old");
});

test("binary install is replaced after checksum verification", async () => {
  const { deps, log, target } = fakeRelease("v0.2.0");
  expect(await update({ kind: "binary", current: "0.1.0", target }, deps)).toBe(0);
  expect(readFileSync(target, "utf8")).toContain("echo new");
  expect(Bun.spawnSync([target]).stdout.toString().trim()).toBe("new");
  expect(log.at(-1)).toMatch(/updated yxu 0\.1\.0 → 0\.2\.0/);
});

test("checksum mismatch leaves the installed binary untouched", async () => {
  const { deps, target } = fakeRelease("v0.2.0", { badSum: true });
  await expect(update({ kind: "binary", current: "0.1.0", target }, deps)).rejects.toThrow(/checksum mismatch/);
  expect(readFileSync(target, "utf8")).toBe("old");
  expect(existsSync(`${target}.tmp`)).toBe(false);
});

test("npm and source installs are told how to update instead", async () => {
  const a = fakeRelease("v0.2.0");
  await update({ kind: "npm", current: "0.1.0", target: a.target }, a.deps);
  expect(a.log.at(-1)).toMatch(/npm install -g yxu@0\.2\.0/);
  const b = fakeRelease("v0.2.0");
  await update({ kind: "source", current: "0.1.0", target: b.target }, b.deps);
  expect(b.log.at(-1)).toMatch(/git pull/);
  expect(readFileSync(b.target, "utf8")).toBe("old");
});
