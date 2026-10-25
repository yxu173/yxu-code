#!/usr/bin/env node
// Launcher for the npm package: runs the prebuilt yxu binary for this platform,
// installed by npm as an optional dependency (yxu-linux-x64, yxu-darwin-arm64, …).
"use strict";
const { spawnSync } = require("node:child_process");

const os = process.platform === "win32" ? "windows" : process.platform;
const pkg = `yxu-${os}-${process.arch}`;
let bin = process.env.YXU_BINARY;
if (!bin) {
  try {
    bin = require.resolve(`${pkg}/bin/${process.platform === "win32" ? "yxu.exe" : "yxu"}`);
  } catch {
    const supported = "linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64";
    console.error(
      `yxu: no prebuilt binary for ${os}-${process.arch} (package ${pkg} is missing).\n` +
        `  Supported: ${supported}.\n` +
        `  If your platform is supported, reinstall without --no-optional / --omit=optional.`,
    );
    process.exit(1);
  }
}

const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (r.error) {
  console.error(`yxu: failed to start ${bin}: ${r.error.message}`);
  process.exit(1);
}
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
