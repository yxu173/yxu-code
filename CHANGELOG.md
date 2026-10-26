# Changelog

All notable changes are listed here. The project uses [semantic versioning](https://semver.org);
before 1.0, minor versions may change the config format (with migration notes here).

## Unreleased

### Added
- A starter team by role: `scout` (read-only discovery), `coder`, `builder`, `tester`, `debugger`,
  `reviewer` (read-only), `resolver` (merge conflicts), `docs`, `expert` and `backup`, mapped onto
  the agent CLIs you have. It is the built-in default and what `yxu init` writes
  (`--template minimal` for one coder per CLI), with `feature`, `bugfix`, `review` and `explore`
  workflows that use the roles.
- Agent `instructions:`, the agent's role prompt, put before every task it gets. Read-only agents
  (`permission: plan`) get a preamble that asks for a report instead of changes.
- `/agent new <name> <cli> [model]`, `/agent remove <name>`, and `/agent <name> cli|role|instructions …`
  in the interface: change an agent's provider, model and role, or add your own; `/save` keeps them.
- Background compaction (`compact.background`, `compact.background_at`, default on at 60%), so
  Claude Code's own auto-compaction doesn't pause the orchestrator: during a run, a fork is
  summarized while subagents work and the run hands over to it; between turns, the interface
  summarizes while you keep working. Summaries are never thrown away: turns that ran meanwhile are
  passed on with them. `/compact background on|off|<n%>`.
- `yxu run -c` (`--continue`) continues the repo's last conversation; after a run, it is summarized
  in a detached process for the next one.
- From issue to pull request: `yxu run --issue 123` (or `linear:ENG-12` from a plugin issue source)
  makes the issue the goal; `yxu pr <task>` pushes a task and opens a PR describing what each agent
  did, the checks and the review findings, closing the issue; `yxu fix-ci <pr>` has the debugger fix
  a PR's failing CI from its logs and pushes the fix after asking. Interface: `/issue`, `/pr`,
  `/fix-ci`, and [p] at a decision.
- A repo map shared by every agent (`context.repo_map`, default on): files, symbols, imports,
  tests, entry points, commands and conventions, built from HEAD and updated incrementally in
  `.yxu/repomap.json`. Each subagent task gets the part relevant to it; the orchestrator gets the
  overview and a `find_code` tool. `yxu map [words]`, `/map`. Subagents are also told to use
  paths relative to the repository.
- Watch an agent and step in: `/watch` shows a running agent's tool calls and diff live in a wider
  side panel; `/tell` sends it a correction mid-task (it resumes its own session when the CLI can,
  keeping its work); `/pause` and `/resume` (the timeout pauses too); `/takeover` stops it and
  opens its worktree in your editor, `/done` hands the result back to the orchestrator.
  Subagent output is now read as it arrives, so tool calls show live in `yxu run` too.
- The Claude subagent adapter uses `--output-format stream-json` (live tool calls) and reads the
  older single-object output as well.
- A friendly message when yxu runs outside a git repository.

### Changed
- The default agents are the starter team instead of coder / heavy-coder / oc-coder / claude-coder.
  Configs that define their own agents are unaffected.
- A layer that moves an agent to another `cli` now keeps its role (description, instructions,
  permission, timeout, turns, sandbox) and drops only the old CLI's settings (model, command, env, …).

## 0.1.0 (2026-10-25)

The first public release: everything below is customizable from files, shareable as packs, and
extensible with plugins.

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

- Packs: `yxu add <python|node|rust|go|github:owner/repo[/path][@ref]|git URL|./folder> [--user]`,
  `yxu packs list|update|remove|install`, pinned by commit and content hash in `yxu.lock`;
  namespaced workflows and commands (`/python:add-tests`); `/packs`.
- `extends:` for shared config files (remote ones cached and pinned in `yxu.lock`).
- Starter packs `python`, `node`, `rust`, `go`, built into the binary.
- `yxu init` is a wizard: detects agent CLIs, picks models, suggests a starter pack.
- `agent: default` and `settings.default_agent`, so shared workflows don't need agent names.
- Plugin API v1 (TypeScript): commands, side-panel sections, hooks, agent kinds and
  orchestrators; repo and pack plugins load only after `yxu plugins approve`, pinned to their code.
- `orchestrator.provider: claude | agent | <plugin>`: pipelines can run without Claude.
- Native Windows (x64): release zip, npm package, Windows CI.
- JSON Schema for `yxu-pack.yaml`; `examples/todos`, a pack with a plugin.

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
- Appended subagent-preamble prompts now go before `TASK:` instead of after it.

## 0.0.1

- First import: Opus orchestrator over Command Code, OpenCode and Claude subagents in git
  worktrees; pipelines, combine with conflict resolution, verify, explicit apply; the
  interactive interface with slash palette, context and compaction controls, and model catalog.
