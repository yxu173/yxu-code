# Changelog

All notable changes are listed here. The project uses [semantic versioning](https://semver.org);
before 1.0, minor versions may change the config format (with migration notes here).

## Unreleased

### Added
- Release pipeline: binaries for linux-x64/arm64 and darwin-x64/arm64 with checksums, an
  `install.sh`, and npm packages (`yxu` plus per-platform binaries).
- CI on Linux and macOS: typecheck, tests, compiled build, PTY smoke test.
- `yxu --version`; `yxu --demo` and other interface flags work without `tui`.
- `yxu doctor` reports the yxu version and which Claude Code engine the orchestrator uses.
- Compiled binaries use the `claude` on PATH (or `YXU_CLAUDE_PATH`) as the orchestrator engine.

## 0.0.1

- First import: Opus orchestrator over Command Code, OpenCode and Claude subagents in git
  worktrees; pipelines, combine with conflict resolution, verify, explicit apply; the
  interactive interface with slash palette, context and compaction controls, and model catalog.
