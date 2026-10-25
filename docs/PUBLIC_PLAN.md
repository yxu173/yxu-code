# yxu as a public tool: customization plan

Goal: any developer can install yxu, plug in the agent CLIs and models they already use, and
shape the whole workflow without forking: agents, workflows, commands, prompts, hooks, theme,
and keys. Customizations should be shareable, like dotfiles.

## 1. Principles

1. **Everything is a file.** Each customization is a YAML or Markdown file you can commit, diff,
   and share. Plugins (code) come last and are optional.
2. **Layers, not forks.** Built-in defaults → user → team/project → local overrides → flags.
   Each layer changes only what it names.
3. **Bring your own everything.** yxu never ships or proxies API keys. It drives the CLIs and
   accounts the user already has.
4. **Safe by default.** A public tool runs on strangers' machines. Defaults must not let an
   agent touch anything outside its worktree without asking.
5. **Stable contracts.** Config, workflow files, and the plugin API are versioned. Breaking
   changes come with automatic migration.

## 2. Where we are (the gaps this plan closes)

| Area | Today | Needed for public |
|---|---|---|
| Config | first file found wins (project hides global) | layered merge + `yxu.local.yaml` + env + flags |
| Agents | 3 hard-coded adapters (commandcode, opencode, claude) | generic adapter (any CLI by template) + ACP adapter + plugin adapters |
| Workflows | inline in yxu.yaml; 4 step types | separate files, shareable; shell/gate/conditional/parallel steps |
| Commands | fixed registry in code | user-defined slash commands from files |
| Prompts | orchestrator/planner/reviewer prompts in code | overridable per project |
| Hooks | none | lifecycle hooks (before_run, after_task, before_apply, on_failure…) |
| Look | one theme | theme files and a keybindings file |
| Sharing | none | `yxu add <pack>` from git/URL, packs with manifests |
| Runtime | Bun only (13 Bun APIs) | single binaries for every platform; npm wrapper |
| Platforms | Linux (Unix process groups for cancel) | Linux, macOS; Windows via WSL first, native later |
| Orchestrator | Claude Code only | Claude by default; pluggable later (see §9) |
| Safety | agents run `--yolo` by default | `accept-edits` default, approvals over ACP, optional sandbox |
| Repo | no commits, no license | license, CI, releases, docs site |

## 3. Configuration layers

Files are merged in this order (later layers win; maps merge deeply, lists replace):

```
built-in defaults
~/.config/yxu/config.yaml            # personal: my agents, models, theme, keys
<repo>/yxu.yaml                      # team: committed, shared by everyone on the project
<repo>/yxu.local.yaml                # personal per-project overrides (git-ignored automatically)
YXU_* environment variables          # e.g. YXU_ORCHESTRATOR_MODEL=sonnet, for CI
command-line flags                   # e.g. --model, --workflow, --budget
TUI session changes (/save writes to the layer you choose: --user / --project / --local)
```

- Every file starts with `version: 1`. `yxu migrate` upgrades old files and shows a diff first.
- `yxu config explain [key]` shows the effective value and which layer set it, so it's always
  clear why a setting has the value it has.
- A **JSON Schema** generated from the zod schemas ships with each release
  (`# yaml-language-server: $schema=…`), so editors autocomplete and validate yxu.yaml.
- `extends:` pulls in a shared base: `extends: [github:acme/yxu-presets/python.yaml]`.

## 4. What users can customize

### 4.1 Agents (any CLI, not just the three we ship)

Three ways to add an agent, from no code to full control:

```yaml
agents:
  # (a) built-in adapter: just pick a CLI and model
  coder: { cli: opencode, model: opencode/deepseek-v4.1-flash-free }

  # (b) ACP: any agent that speaks the Agent Client Protocol (streamed events, permissions)
  gemini: { cli: acp, command: [gemini, --experimental-acp], model: gemini-3.8-flash }

  # (c) generic: any CLI described by a template + how to read its output
  aider:
    cli: generic
    command: [aider, --yes-always, --model, "{{model}}", --message, "{{task}}"]
    output: text               # text | json | ndjson
    summary: last-paragraph    # or a JSON path for json/ndjson: $.result
    success: exit-code         # or a JSON path: $.is_error == false
    models: [aider --list-models]   # optional: how to list models for the palette
```

- `yxu agent test <name>` runs a tiny canned task in a scratch repo. It shows the parsed
  events, summary, diff, and cost, so adapter authors see exactly what yxu understood.
- `yxu agent capture <name>` saves real output as a fixture for adapter tests and bug reports.
- **ACP comes first** because one adapter covers every ACP agent. It brings live tool events
  and permission requests (which feed the approval box) for free.

### 4.2 Workflows as files

`.yxu/workflows/<name>.yaml` (project) or `~/.config/yxu/workflows/` (personal). Each file
appears in `/workflow`.

New step types, beyond plan/delegate/verify/review:

| step | purpose |
|---|---|
| `shell` | run a command (lint, format, build, codegen); its output can feed later steps |
| `gate` | stop and ask the user (TUI decision box / CLI prompt) before continuing |
| `if` / `unless` | conditional on an earlier step (`if: "{{verify.ok}}"`, `if: "{{plan.tasks.length > 3}}"`) |
| `parallel` | run a group of steps at once (e.g. tests + docs + changelog agents) |
| `loop` | repeat a group until a condition or a round limit |
| `workflow` | call another workflow (composition) |

Workflows declare `inputs:` (asked for by the TUI or passed as flags) and `outputs:`. Any
workflow can then become a command (§4.3) or a CI job: `yxu run -w release --input version=1.2.0`.

### 4.3 Custom slash commands

`.yxu/commands/<name>.md`: a prompt template with front matter, the same idea as Claude
Code's custom commands, so it feels familiar:

```markdown
---
description: Add tests for a file and make them pass
args: [file]
workflow: feature
agents: [coder]
---
Write thorough unit tests for {{file}}. Follow the existing test style. Run {{settings.verify}}.
```

It shows up in the `/` palette with its description and argument completion (files for
`file`). Kinds: `prompt` (sends a goal), `workflow` (runs a workflow with inputs), `shell`
(runs a command and shows the output).

### 4.4 Prompts

Override any built-in prompt per project, by name: `.yxu/prompts/orchestrator.md`,
`planner.md`, `reviewer.md`, `subagent-preamble.md`, `conflict-resolver.md`. Each can be
`replace` or `append` (default: append, so upgrades still improve the base prompt).
`yxu prompts show <name>` prints the effective prompt.

### 4.5 Hooks

Shell commands at lifecycle points. They receive JSON on stdin and can block or annotate:

```yaml
hooks:
  before_run:   ["./scripts/check-clean-tree.sh"]
  after_task:   ["npx prettier --write {{task.files}}"]
  before_apply: ["npm test"]                 # non-zero exit blocks the apply, output shown
  on_failure:   ["notify-send 'yxu' '{{error}}'"]
  on_complete:  ["curl -X POST $SLACK_WEBHOOK -d @-"]
```

These are the same events the TUI already consumes (delegate/verify/combine/decision), so the
data model exists.

### 4.6 Look and keys

- **Themes:** `~/.config/yxu/themes/<name>.yaml` with palette roles (ivory, cyan, amber,
  violet, fault…) and glyph overrides. The current "ancient instrument" is the default; ship 2–3
  more (high-contrast, light, minimal). `/theme <name>` switches live.
- **Keybindings:** `~/.config/yxu/keys.yaml`, with conflict detection and `yxu keys` to list
  the effective map.
- **Layout:** panel side, panel sections and their order, palette size, footer on/off.

### 4.7 Plugins (code), phase 4

When files aren't enough: a TypeScript module with a small, versioned API.

```ts
export default definePlugin({
  name: "jira", apiVersion: 1,
  commands: [{ name: "ticket", description: "Start work from a Jira ticket", run: async (ctx, [id]) => ctx.run(await fetchTicket(id)) }],
  agents:   [{ cli: "my-agent", adapter: myAdapter }],
  hooks:    { after_task: (ctx, task) => ctx.note(`posted ${task.id} to Jira`) },
  panel:    [{ title: "jira", render: (ctx) => [...] }],
});
```

Plugins run in-process, so they are **trusted code**. Installing one shows its source and
permissions and asks for confirmation. Project plugins are never loaded until the user
approves them once (protection against hostile repos).

## 5. Sharing: packs

A **pack** is a git repo or folder with a `yxu-pack.yaml` manifest. It bundles any of: agents,
workflows, commands, prompts, hooks, themes, plugins.

```
yxu add github:acme/yxu-python      # install into the project (.yxu/packs/) or --user
yxu add ./my-pack                   # local folder
yxu packs list | update | remove
```

- Packs are pinned by commit in `yxu.lock`, so the team gets identical behavior.
- Contents are namespaced (`python:add-tests`) to avoid clashes.
- **Official starter packs:** `node`, `python`, `rust`, `go` (verify commands, conventions), and
  `review-only`, `docs`, `migration`, `bench`.
- Later: a simple index (a JSON file in a GitHub repo) for discovery. No hosted service needed.

## 6. Onboarding for a new user

1. Install (any of): a one-line install script, `brew install yxu`, `yay -S yxu`, `npm i -g yxu`,
   or a GitHub release binary.
2. `yxu init` is an interactive wizard. It detects installed agent CLIs and whether they're
   logged in, lists their models (the catalog already does this), proposes agents and a verify
   command, picks a starter pack for the detected language, and writes a commented yxu.yaml.
3. `yxu doctor` checks: CLIs found and logged in, versions known-good, orchestrator reachable,
   config valid, packs present, sandbox available.
4. `yxu` opens the TUI with a first-run tour (3 short tips: `/`, the decision box, `/save`).

## 7. Safety for a public tool

- **Default permission becomes `accept-edits`**; `yolo` is opt-in per agent, with a warning.
- **Approvals over ACP:** agent permission requests appear in the amber decision box (allow once
  / always for this session / deny). Rules can be saved in config.
- **Optional sandbox** for agents: `sandbox: bwrap` (Linux) / `sandbox-exec` (macOS). It
  write-protects everything outside the worktree, with an optional network allowlist.
- **Hostile-repo protection:** a cloned repo's `yxu.yaml` hooks, plugins, and shell steps don't
  run until the user trusts that repo once (the same pattern as VS Code workspace trust).
- **No telemetry.** If added later, it is opt-in and documented field by field.
- Secrets in config are references only (`env:OPENAI_API_KEY`), never literals.

## 8. Distribution and runtime

- **Primary:** `bun build --compile` binaries for linux-x64/arm64 and darwin-x64/arm64,
  attached to GitHub releases with checksums.
- **npm package `yxu`** (name is free) with per-platform optional dependencies holding the
  binaries (the esbuild pattern), so `npx yxu` works without Bun.
- Homebrew tap and AUR package from the same release job.
- `yxu update` (self-update, with a pinned-version option for teams).
- **Windows:** WSL is supported first. Native Windows needs a replacement for Unix process
  groups (job objects / `taskkill /T`). Track it as its own milestone.
- Keep the Bun-specific calls (spawn, which, stringWidth) behind a small `platform.ts` module so
  a Node port stays possible.

## 9. Orchestrator choice (decide early)

Today the orchestrator is Claude Code through the Agent SDK. That's the product's core
strength (planning and review quality, resume, compaction, MCP tools). Options for users
without Claude:

- **A. Claude-only orchestrator** (simple, best quality; document clearly).
- **B. Pluggable orchestrator interface** (`plan`, `review`, `converse` with tools). A second
  implementation would use OpenCode's server or any OpenAI-compatible model with tool calls.
  The pipeline workflow already works with "one structured call" per step, so it is the easiest
  place to start.

Recommendation: ship **A**, but define the interface now (pipeline steps first), so **B** can
land without breaking configs.

## 10. Quality bar for public releases

- **CI:** tests + typecheck on Linux and macOS; compiled-binary smoke test (PTY drive of `--demo`).
- **Adapter contract tests:** a nightly job installs the latest commandcode/opencode/claude,
  runs `yxu agent test` in a scratch repo, and opens an issue if an output format changed. (Both
  CLIs auto-updated during development; this will happen to users too.)
- **Versioning:** semver; config `version:`; plugin `apiVersion`; a deprecation window of one
  minor release with warnings in `yxu doctor`.
- **Docs site:** getting started, configuration reference (generated from the schema), recipes,
  "write an adapter / pack / plugin" guides, troubleshooting.
- **Community files:** LICENSE (MIT or Apache-2.0), CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY.md, issue templates (bug report asks for `yxu doctor` output), CHANGELOG.

## 11. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Foundation** (≈1 week) | commit history, license, CI, `platform.ts`, release job with binaries + npm wrapper, README for strangers | a new machine installs with one command and runs `yxu --demo` |
| **1. Layers & schema** (≈1 week) | layered config + `yxu.local.yaml` + env/flags, `version:` + migrate, JSON Schema, `config explain`, `/save --user/--project/--local` | the same repo works for two developers with different personal agents |
| **2. Files for everything** (≈2 weeks) | workflows as files + new step types, custom slash commands, prompt overrides, hooks, themes, keybindings | a user builds a "lint → fix → test → PR" workflow and command without touching code |
| **3. Agents for everyone** (≈2 weeks) | ACP adapter (live events + approvals), generic adapter, `agent test`/`capture`, safe defaults, repo trust, optional sandbox | aider and gemini-cli work from config alone; no yolo by default |
| **4. Sharing** (≈1–2 weeks) | packs + `yxu add` + `yxu.lock`, 4 starter packs, `init` wizard | `yxu add github:…/yxu-python` gives a working setup in one command |
| **5. Plugins & reach** | plugin API v1 with trust prompts, pluggable orchestrator (pipeline first), native Windows | a third-party plugin adds a command + panel section |

Phases 1–3 deliver most of the value. Packs (4) only make sense once the file formats are stable.

### Status

- **Phase 0 (foundation), in review:**
  - repo at github.com/yxu173/yxu-code under the MIT license
  - CI on Linux and macOS
  - `src/platform.ts` (which, stringWidth, version, Claude engine path)
  - a release workflow with binaries, checksums, `install.sh` and npm packages
  - community files and a README for new users

  - Homebrew formula and AUR package, `yxu update`, and every Bun API behind `platform.ts`

  Remaining: the first tagged release, and the publishing secrets (npm, tap, AUR).

- **Phase 1 (layers and schema), in review:**
  - user, project, local, env and flag layers with `null` removal
  - `yxu config` explain/get/set/unset/paths/migrate/schema, plus `/config` and `/save <layer>` in the interface
  - `version: 1` and migrations
  - JSON Schema, with a test that the committed copy is up to date

  `extends:` moves to Phase 4, where it fits with packs.
- **Phase 2 (files for everything), in review:**
  - workflow files with shell, gate, parallel, loop and workflow steps, plus conditions, inputs and outputs
  - custom commands, prompt overrides, hooks, themes, keys and layout

  It met its exit criterion: a lint → fix → test → gate → PR workflow and `/ship` command, written
  only as files, ran end to end with a real DeepSeek agent. Panel side (left/right) was not done.

- **Phase 3 (agents for everyone), in review:**
  - ACP adapter with live events and approvals
  - generic adapter and `agent test` / `agent capture`
  - accept-edits by default
  - repo trust and the bwrap sandbox

  Verified with real OpenCode (built-in, ACP, generic) and Claude Code (built-in, generic,
  ACP with approvals). Gemini CLI completes the ACP handshake but needs a login; aider has not
  been run (no API key on the build machine). The macOS sandbox and a network allowlist are
  not done.

- **Phase 4 (sharing), in review:**
  - packs, with `yxu add` from starter packs, git repos, git URLs and folders
  - `yxu packs list|update|remove|install`, pinned by commit and content hash in `yxu.lock`
  - `extends:` with remote bases pinned in the lock
  - four starter packs (python, node, rust, go), embedded in the binary
  - the `yxu init` wizard
  - `agent: default` / `settings.default_agent`, so a pack's workflows don't need your agent names

  The other starter packs listed in section 5 (`review-only`, `docs`, `migration`, `bench`) and
  the discovery index are not done. `init` does not check whether an agent CLI is logged in; it
  points to `yxu agent test` instead.

- **Phase 5 (plugins & reach), in review:**
  - plugin API v1 (TypeScript): commands, panel sections, hooks, agents, orchestrators
  - plugins from a repo or project pack load only after approval, pinned to a hash of their code
  - pluggable orchestrator for pipelines: `orchestrator.provider: claude | agent | <plugin>`
  - native Windows support: process-tree kill, Git's `sh` or cmd.exe for commands, `.cmd` shims, a windows-x64 release, Windows CI

  Exit criterion met: the example `todos` pack's plugin adds `/todos:list`, `/todos:fix` and a
  panel section, verified in the compiled binary in a real terminal. A pipeline ran with OpenCode
  as planner, coder and reviewer (no Claude). Decisions taken: TypeScript-only plugins for v1
  (§12.5); Claude stays the default, and the orchestrator interface covers pipeline steps (§12.3).
  Native Windows is verified by CI only (no Windows machine):
  - the whole test suite runs on windows-latest, including agents launched through npm-style
    `.cmd` shims with multi-line prompts;
  - the release zip passes a smoke test (`init`, packs, config).

  No real agent CLI has been run on Windows.

## 12. Decisions needed from the owner

Decided: **MIT** license (1). The repo is `yxu-code`; the command and npm package stay `yxu` (2).


1. **License:** MIT (simplest, most adoption) or Apache-2.0 (patent grant)?
2. **Name:** keep `yxu` (free on npm) or rename before the first public release?
3. **Orchestrator:** Claude-only for v1 (option A) or invest in pluggable now (B)?
4. **Default safety:** accept `accept-edits` + approvals as the default (slower, safer) instead
   of today's `yolo`?
5. **Plugin language:** TypeScript only, or also any executable over JSON-RPC (more languages,
   more work)?
