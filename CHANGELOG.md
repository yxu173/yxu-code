# Changelog

All notable changes are listed here. The project uses [semantic versioning](https://semver.org);
before 1.0, minor versions may change the config format (with migration notes here).

## Unreleased

### Added
- Layered configuration: built-in defaults → `~/.config/yxu/config.yaml` → `yxu.yaml` →
  `yxu.local.yaml` (git-ignored) → `YXU_*` environment → `--set key=value`. Maps merge, lists
  replace, `null` removes; changing an agent's `cli` replaces that agent.
- `yxu config` (explain, get, set, unset, paths, migrate, schema) and `/config [key]` in the
  interface; `/save [project|local|user]` warns when a higher layer still overrides a value.
- `version: 1` in config files, `yxu config migrate`, and a refusal for files from a newer yxu.
- JSON Schema for config files (`schema/yxu.schema.json`), referenced by `yxu init`.
- Errors in merged configs name the file that set the bad value.
- Workflows as files (`.yxu/workflows/`, `~/.config/yxu/workflows/`) with new step types:
  shell (isolated worktree; changes join the result), gate, parallel, loop, workflow; `if` /
  `unless` / `continue_on_error`; `inputs` / `outputs`; `yxu run -i k=v --yes`, `/run`.
- A small, safe expression language for conditions and `{{ }}` templates (shell-quoted in commands).
- Custom slash commands from Markdown files (prompt, workflow and shell kinds), in the palette
  and help; `yxu run "/name args"`, `yxu commands`, `/commands`.
- Prompt overrides (`.yxu/prompts/<name>.md`, append or replace); `yxu prompts [show]`.
- Hooks: before_run, after_task (changes join the task), before_apply (blocks), on_failure,
  on_complete; the event arrives as JSON on stdin.
- Themes (instrument, high-contrast, light, mono, and theme files), `/theme`; rebindable keys
  (`ui.keys`, `yxu keys`, `/keys`); panel sections, panel and footer options; scrollable help.

- ACP agents (`cli: acp`): live tool events, model selection, usage and cost, and approvals
  (allow once / for the session / deny) in the interface and terminal; `allow`/`deny` rules.
- Generic agents (`cli: generic`): any CLI from an argv template, with text/json/ndjson output,
  summary/success/usage expressions and a `models` command.
- `yxu agent test` and `yxu agent capture`.
- `sandbox: bwrap` (Linux) confines an agent to its worktree and its own state folders.
- Repository trust: a repo's own hooks, verify/shell steps, agent commands, shell commands and
  yolo permissions wait for `yxu trust` / `/trust` (or `YXU_TRUST=1`).
- `env:NAME` references in agent `env`, so secrets stay out of config files.
- Model lists for ACP and generic agents.
- A warning when an agent writes outside its worktree.

### Changed
- **Agents default to `accept-edits`**; `yolo` must be set per agent (`yxu doctor` warns about it).
- Agent processes get `PWD` set to their worktree (some CLIs used yxu's directory instead).
- Only yxu's runtime files under `.yxu/` are git-ignored now, so workflows and commands there
  can be committed.
- Release pipeline: binaries for linux-x64/arm64 and darwin-x64/arm64 with checksums, an
  `install.sh`, and npm packages (`yxu` plus per-platform binaries).
- CI on Linux and macOS: typecheck, tests, compiled build, PTY smoke test.
- `yxu --version`; `yxu --demo` and other interface flags work without `tui`.
- `yxu doctor` reports the yxu version and which Claude Code engine the orchestrator uses.
- Compiled binaries use the `claude` on PATH (or `YXU_CLAUDE_PATH`) as the orchestrator engine.
- `yxu update [--check] [--version vX.Y.Z]`: checksum-verified self-update for release binaries.
- Homebrew formula and AUR `yxu-bin` package, generated and published by the release workflow.
- All process spawning goes through `src/platform.ts`.

## 0.0.1

- First import: Opus orchestrator over Command Code, OpenCode and Claude subagents in git
  worktrees; pipelines, combine with conflict resolution, verify, explicit apply; the
  interactive interface with slash palette, context and compaction controls, and model catalog.
