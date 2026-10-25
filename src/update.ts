/**
 * `yxu update`: replace a release binary with a newer one from GitHub releases.
 * npm and source installs are updated by their own tools; we only say how.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isCompiled, runSync, VERSION } from "./platform.ts";

export const REPO = "yxu173/yxu-code";

export type InstallKind = "binary" | "npm" | "source";

export function installKind(execPath = process.execPath, compiled = isCompiled()): InstallKind {
  if (!compiled) return "source";
  return /[\\/]node_modules[\\/]/.test(execPath) ? "npm" : "binary";
}

export function platformAsset(platform = process.platform, arch = process.arch): string {
  if (platform === "win32") {
    if (arch !== "x64") throw new Error(`no release binaries for windows-${arch} (windows-x64 only; or use WSL)`);
    return "yxu-windows-x64.zip";
  }
  if (platform !== "linux" && platform !== "darwin") throw new Error(`no release binaries for ${platform}`);
  if (arch !== "x64" && arch !== "arm64") throw new Error(`no release binaries for ${arch}`);
  return `yxu-${platform}-${arch}.tar.gz`;
}

/** Compare "1.2.3" style versions (pre-release suffixes sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2) as [string, string | undefined];
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface UpdateDeps {
  fetch: (url: string) => Promise<Response>;
  log: (line: string) => void;
}

const defaultDeps: UpdateDeps = {
  fetch: (url) => fetch(url, { headers: { "user-agent": `yxu/${VERSION}` }, redirect: "follow" }),
  log: (line) => console.log(line),
};

async function latestTag(deps: UpdateDeps): Promise<string> {
  const res = await deps.fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (res.status === 404) throw new Error(`no releases published yet at github.com/${REPO}`);
  if (!res.ok) throw new Error(`could not look up the latest release (HTTP ${res.status})`);
  const tag = ((await res.json()) as { tag_name?: string }).tag_name;
  if (!tag) throw new Error("the latest release has no tag");
  return tag;
}

async function download(deps: UpdateDeps, url: string): Promise<Buffer> {
  const res = await deps.fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export interface UpdateOptions {
  /** Only report whether an update exists. */
  check?: boolean;
  /** Install this tag (e.g. v0.2.0) instead of the latest; allows downgrades. */
  version?: string;
  /** Binary to replace (default: the running one). */
  target?: string;
  kind?: InstallKind;
  current?: string;
}

/** Returns a process exit code. */
export async function update(opts: UpdateOptions = {}, deps: UpdateDeps = defaultDeps): Promise<number> {
  const kind = opts.kind ?? installKind();
  const current = opts.current ?? VERSION;
  const tag = opts.version ? (opts.version.startsWith("v") ? opts.version : `v${opts.version}`) : await latestTag(deps);
  const wanted = tag.replace(/^v/, "");
  const newer = compareVersions(wanted, current) > 0;

  if (!opts.version && !newer) {
    deps.log(`yxu ${current} is up to date (latest release: ${tag})`);
    return 0;
  }
  if (opts.check) {
    deps.log(newer ? `update available: ${current} → ${wanted}  (run \`yxu update\`)` : `yxu ${current}; requested ${tag}`);
    return newer ? 10 : 0;
  }
  if (kind === "npm") {
    deps.log(`yxu was installed with npm; run:\n  npm install -g yxu@${wanted}`);
    return 0;
  }
  if (kind === "source") {
    deps.log(`yxu is running from source; update with:\n  git pull && bun install`);
    return 0;
  }

  const target = opts.target ?? process.execPath;
  const asset = platformAsset();
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  deps.log(`downloading ${asset} (${tag})`);
  const [archive, sums] = await Promise.all([download(deps, `${base}/${asset}`), download(deps, `${base}/checksums.txt`)]);
  const expected = sums
    .toString()
    .split("\n")
    .find((l) => l.trim().endsWith(` ${asset}`))
    ?.split(/\s+/)[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${asset}; nothing was changed`);

  const work = mkdtempSync(join(tmpdir(), "yxu-update-"));
  try {
    writeFileSync(join(work, asset), archive);
    const exe = asset.endsWith(".zip") ? "yxu.exe" : "yxu";
    // bsdtar (macOS, Windows 10+) reads zip files too.
    const tar = runSync(["tar", asset.endsWith(".zip") ? "-xf" : "-xzf", join(work, asset), "-C", work, exe]);
    if (tar.code !== 0) throw new Error(`could not unpack ${asset}: ${tar.stderr.trim()}`);
    // Stage next to the target, then rename: atomic on the same filesystem, and the running
    // process keeps its (now unlinked) old file. Windows can't replace a running .exe, but can
    // rename it out of the way; the old file is removed on the next update.
    const staged = join(dirname(target), `.yxu-update-${process.pid}`);
    try {
      writeFileSync(staged, readFileSync(join(work, exe)));
      chmodSync(staged, 0o755);
      if (process.platform === "win32") {
        const old = `${target}.old`;
        rmSync(old, { force: true });
        renameSync(target, old);
      }
      renameSync(staged, target);
    } catch (e) {
      rmSync(staged, { force: true });
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EACCES" || err.code === "EPERM") {
        throw new Error(`no permission to replace ${target}; re-run with permission or reinstall with install.sh`);
      }
      throw e;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  deps.log(`updated yxu ${current} → ${wanted} (${target})`);
  return 0;
}
