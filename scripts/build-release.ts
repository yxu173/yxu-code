/**
 * Build release artifacts for every supported platform:
 *   dist/release/yxu-<os>-<arch>.tar.gz   (binary named `yxu`; Windows: yxu-windows-x64.zip with yxu.exe)
 *                                          + checksums.txt
 *   dist/npm/<package>/                    npm wrapper `yxu` + one package per platform
 *
 * usage: bun scripts/build-release.ts [--version X.Y.Z] [--only linux-x64,...]
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

export const TARGETS = [
  // x64 uses Bun's baseline build so it runs on CPUs without AVX2.
  { name: "linux-x64", bun: "bun-linux-x64-baseline", os: "linux", cpu: "x64" },
  { name: "linux-arm64", bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
  { name: "darwin-x64", bun: "bun-darwin-x64-baseline", os: "darwin", cpu: "x64" },
  { name: "darwin-arm64", bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "windows-x64", bun: "bun-windows-x64-baseline", os: "win32", cpu: "x64" },
] as const;

const { values } = parseArgs({ options: { version: { type: "string" }, only: { type: "string" } } });
const version = (values.version ?? pkg.version).replace(/^v/, "");
if (version !== pkg.version) {
  console.error(`version ${version} does not match package.json (${pkg.version}); bump package.json first`);
  process.exit(1);
}
const only = values.only?.split(",");
const targets = TARGETS.filter((t) => !only || only.includes(t.name));

const out = join(ROOT, "dist");
rmSync(join(out, "release"), { recursive: true, force: true });
rmSync(join(out, "npm"), { recursive: true, force: true });
mkdirSync(join(out, "release"), { recursive: true });

function sh(argv: string[], cwd = ROOT) {
  const p = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${p.exitCode})`);
}

const sums: string[] = [];
for (const t of targets) {
  const stage = join(out, "stage", t.name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const win = t.os === "win32";
  const exe = win ? "yxu.exe" : "yxu";
  const bin = join(stage, exe);
  console.log(`· ${t.name}`);
  sh(["bun", "build", "--compile", "--minify", "--sourcemap", `--target=${t.bun}`, "src/cli.ts", "--outfile", bin]);
  copyFileSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
  copyFileSync(join(ROOT, "README.md"), join(stage, "README.md"));

  const archive = win ? `yxu-${t.name}.zip` : `yxu-${t.name}.tar.gz`;
  if (win) sh(["zip", "-q", "-j", join(out, "release", archive), bin, join(stage, "LICENSE"), join(stage, "README.md")]);
  else sh(["tar", "-czf", join(out, "release", archive), "-C", stage, "yxu", "LICENSE", "README.md"]);
  const hash = createHash("sha256").update(readFileSync(join(out, "release", archive))).digest("hex");
  sums.push(`${hash}  ${archive}`);

  // npm: one package per platform holding just the binary.
  const dir = join(out, "npm", `yxu-${t.name}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(bin, join(dir, "bin", exe));
  chmodSync(join(dir, "bin", exe), 0o755);
  copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `yxu-${t.name}`,
        version,
        description: `The yxu binary for ${t.os} ${t.cpu}. Install \`yxu\` instead.`,
        license: pkg.license,
        repository: pkg.repository,
        os: [t.os],
        cpu: [t.cpu],
        files: [`bin/${exe}`, "LICENSE"],
      },
      null,
      2,
    ) + "\n",
  );
}
writeFileSync(join(out, "release", "checksums.txt"), sums.join("\n") + "\n");

// npm: the `yxu` wrapper that picks the right platform package at run time.
const wrapper = join(out, "npm", "yxu");
mkdirSync(join(wrapper, "bin"), { recursive: true });
copyFileSync(join(ROOT, "npm", "yxu", "bin", "yxu.js"), join(wrapper, "bin", "yxu.js"));
// Types for plugin authors: `import type { Plugin } from "yxu/plugin"`.
sh(["bunx", "tsc", "src/plugin-api.ts", "--declaration", "--emitDeclarationOnly", "--allowImportingTsExtensions", "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--outDir", join(wrapper, "types")]);
for (const f of ["plugin-api.d.ts", "types.d.ts"]) {
  const file = join(wrapper, "types", f);
  writeFileSync(file, readFileSync(file, "utf8").replace(/from "\.\/(\w[\w-]*)\.ts"/g, 'from "./$1.js"'));
}
copyFileSync(join(ROOT, "LICENSE"), join(wrapper, "LICENSE"));
copyFileSync(join(ROOT, "README.md"), join(wrapper, "README.md"));
writeFileSync(
  join(wrapper, "package.json"),
  JSON.stringify(
    {
      name: "yxu",
      version,
      description: pkg.description,
      license: pkg.license,
      repository: pkg.repository,
      homepage: "https://github.com/yxu173/yxu-code#readme",
      keywords: ["claude", "claude-code", "agents", "orchestrator", "cli", "opencode", "multi-agent"],
      bin: { yxu: "bin/yxu.js" },
      exports: { "./plugin": { types: "./types/plugin-api.d.ts" }, "./package.json": "./package.json" },
      files: ["bin/yxu.js", "types", "LICENSE", "README.md"],
      engines: { node: ">=18" },
      optionalDependencies: Object.fromEntries(TARGETS.map((t) => [`yxu-${t.name}`, version])),
    },
    null,
    2,
  ) + "\n",
);
rmSync(join(out, "stage"), { recursive: true, force: true });
console.log(`\nbuilt ${targets.length} target(s) for v${version} → dist/release, dist/npm`);
