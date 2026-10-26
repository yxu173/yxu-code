# yxu

[![ci](https://github.com/yxu173/yxu-code/actions/workflows/ci.yml/badge.svg)](https://github.com/yxu173/yxu-code/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local multi-agent orchestrator for your terminal. Claude Code (Opus) plans and reviews; the
coding agents you already have installed (Command Code, OpenCode, Claude) do the work in
isolated git worktrees; nothing reaches your branch until you run `apply`.

Everything runs on your machine with your own CLIs and logins. yxu has no server, no account
and no telemetry.

## Requirements

- Linux, macOS or Windows (x64; with [Git for Windows](https://git-scm.com), whose `sh` runs shell commands)
- `git`
- [Claude Code](https://claude.com/claude-code) installed and logged in. It drives the orchestrator.
  Pipelines can use one of your agents instead (`orchestrator.provider: agent`).
- At least one coding agent CLI as a subagent: [OpenCode](https://opencode.ai) (`opencode`),
  [Command Code](https://commandcode.ai) (`cmd`), or Claude Code itself (`claude`)

## Install

```sh
# prebuilt binary (Linux/macOS, x64/arm64), checksum-verified, into ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/yxu173/yxu-code/main/install.sh | sh

# or with npm (no Bun needed; picks the right binary for your platform, Windows included)
npm install -g yxu

# Windows without npm: download yxu-windows-x64.zip from the releases page and put yxu.exe on PATH

# or Homebrew (macOS/Linux) / AUR (Arch)
brew install yxu173/tap/yxu
yay -S yxu-bin

# or from source (needs Bun ≥ 1.3)
git clone https://github.com/yxu173/yxu-code && cd yxu-code && bun install && bun link
```

`install.sh` honours `YXU_VERSION=v0.1.0` (pin a version) and `YXU_INSTALL_DIR`.
Update with `yxu update`; it replaces the binary after checking its checksum. Use
`yxu update --check` to only look, or `yxu update --version v0.1.0` to pin a team version.
npm, Homebrew and AUR installs update through their own package manager.

## Quick start

```sh
cd your-git-repo
yxu doctor         # checks Claude Code, your agent CLIs and the config
yxu init           # finds your agent CLIs, writes a team of agents by role (below) and a starter pack
yxu                # open the interface; describe a goal
yxu --demo         # a scripted tour of the interface: no agents, no git changes, no cost
```

A typical run: Opus reads the repo and plans, then delegates tasks to your agents in parallel
worktrees. It checks the results (and your `verify` command), then asks you to **apply**, **view
the diff**, decide **later** or **discard**. From scripts, use `yxu run "<goal>"`, then
`yxu show <task>` and `yxu apply <task>`.

## The team

`yxu init` (and the built-in defaults) give you a team of subagents by role. Each one is mapped
onto the agent CLIs you have: most roles on your main CLI, the expert roles on Claude when it is
installed, and a backup on a second CLI.

| agent | does | access |
|---|---|---|
| `scout` | discovery: finds the files, call sites and conventions for a question, with `file:line` | read-only |
| `coder` | small, scoped changes; the default | edits |
| `builder` | features and refactors across many files | edits |
| `tester` | tests for new behavior, edge cases and regressions | edits |
| `debugger` | reproduces a failure, finds the root cause, makes the smallest fix | edits |
| `reviewer` | reviews a change or an area: bugs, security, missing tests, by severity | read-only |
| `resolver` | resolves merge conflicts when parallel work is combined | edits |
| `docs` | README, docs and changelog, matching the code | edits |
| `expert` | escalation for the hardest problems | edits |
| `backup` | coder on a second CLI, for rate limits and outages | edits |

Each agent has a `description` (tells the orchestrator when to use it) and `instructions` (its
role prompt, put before every task it gets). The workflows use the roles:

```sh
yxu run "add rate limiting to the API"                 # Claude leads the team
yxu run -w feature "add rate limiting to the API"      # scout → plan → build in parallel → tests → verify → review
yxu run -w bugfix "login fails when the email has a +" # debugger: failing test → root cause → fix → verify → review
yxu run -w review "src/auth"                           # read-only review report
yxu run -w explore "how does a request reach the DB?"  # read-only answer from the scout
```

Change the team to fit: any agent's model or CLI, its role, or add your own. In the interface:

```
/agent scout cli opencode opencode/deepseek-v4.1-flash-free   # move an agent to another CLI (provider)
/agent builder model deepseek/deepseek-v4-pro                  # change its model
/agent new security claude sonnet                              # add an agent…
/agent security role Reviews auth and input handling for vulnerabilities
/agent security instructions Report findings with path:line and a fix. Change nothing.
/agent security permission plan                                # …read-only
/agent remove docs
/save                                                          # keep the changes (yxu.yaml; /save local: only you)
```

or in `yxu.yaml`, or with `yxu config set agents.scout.cli opencode --local`. `yxu init --template minimal`
writes one coder per CLI instead.

## From issue to pull request

With the [GitHub CLI](https://cli.github.com) (`gh auth login`):

```sh
yxu run --issue 123                  # the issue's text, comments and the files it mentions are the goal
yxu run --issue 123 "keep the API"   # …plus your own instructions
yxu pr <task>                        # push the task and open a PR (--draft, --base, --title, --dry-run)
yxu fix-ci 45                        # the PR's CI fails: the debugger fixes it on its branch, then it's pushed
```

- **`yxu pr` writes the description from what happened:** "Closes #123", what each agent did
  and which files it changed, the checks that ran (✅/❌ with the failing output), and what
  reviewers found (read-only `reviewer` tasks and pipeline reviews). It pushes the task's branch
  as `yxu/<issue>-<title>` and opens the PR into the repo's default branch.
- **`yxu fix-ci`** reads the end of each failed GitHub Actions job. It has `debugger` fix the
  cause on top of the PR's head (it's told not to skip tests or weaken checks), runs your
  `verify` command, and retries once with that output. Then it asks before pushing to the PR's
  branch (`--yes` skips the question, `--no-push` keeps it local). It never force-pushes, and it
  doesn't push to forks.
- **Other trackers:** issues `linear:ENG-12` or `jira:PROJ-7` come from plugins that add an issue
  source (docs/PLUGINS.md).
- **In the interface:** `/issue 123 [more]`, `/pr <task>`, `/fix-ci <pr>`, and **[p] pull
  request** next to apply when a result is ready.

## Configuration

Settings come from layers. A later layer wins; maps merge, lists replace, and `null` removes
an entry from a lower layer:

| layer | file | for |
|---|---|---|
| defaults | built in | starter agents and workflows, used until some file defines `agents` |
| user packs | `~/.config/yxu/packs/<name>/` | packs you installed with `yxu add --user` |
| user | `~/.config/yxu/config.yaml` | you, in every repo (your own agents, preferred models) |
| packs | `.yxu/packs/<name>/` | packs installed in the repo with `yxu add`; committed |
| project | `yxu.yaml` | the team; committed |
| local | `yxu.local.yaml` | you, in this repo; git-ignored automatically |
| env | `YXU_ORCHESTRATOR_MODEL=sonnet`, `YXU_SETTINGS_CONCURRENCY=2`, … | CI and scripts (orchestrator, settings, context, compact keys) |
| flags | `--set key=value` on `run`, `tui`, `chat`, `mcp`, `delegate` | one run |

```yaml
# yxu.local.yaml: use OpenCode for the team's "coder" agent, just for me
version: 1
agents:
  coder: { cli: opencode, model: opencode/deepseek-v4.1-flash-free }  # a new cli: the old model goes, the role stays
  docs: null                                                           # hide a team agent
settings:
  concurrency: 5
```

```sh
yxu config                          # every setting and the file it came from
yxu config explain agents.coder     # one key or section
yxu config set orchestrator.model sonnet --local    # or --project (default) / --user
yxu config unset settings.concurrency --local
yxu config migrate [--write]        # add/upgrade the version: line (shows the diff first)
yxu config schema                   # JSON Schema; files from yxu init reference it for editor completion
```

A file can start from shared bases with `extends: [./base.yaml, github:acme/presets/team.yaml]`
(remote ones are pinned in `yxu.lock`).

Every file carries `version: 1`. A file written for a newer yxu is refused with a hint to
`yxu update`, and `yxu doctor` flags files without a version. Edits from `yxu config set` and
`/save` are validated against the merged result of all layers before anything is written.
An error names the file that set the bad value.

### Any agent, safely

Besides the built-in CLIs, any **ACP** agent (`opencode acp`, Gemini CLI, Claude via
`claude-agent-acp`, …) or any **generic** CLI described in config can be an agent.
- `yxu agent test <name>` shows exactly what yxu understood from it.
- Agents edit files but must ask before anything else, unless you choose `yolo` per agent. ACP agents ask in an approval box.
- `sandbox: bwrap` confines an agent to its worktree.
- A cloned repo's own commands (hooks, steps, agent commands) run only after `yxu trust`.

See **[docs/AGENTS.md](docs/AGENTS.md)**.

### Workflows, commands, prompts, hooks, themes

Customization lives in files: `.yxu/workflows/*.yaml` and `.yxu/commands/*.md` for the team,
and the same under `~/.config/yxu/` for yourself. A workflow can lint, have an agent fix what
lint found, test, ask you at a gate, and open a PR. The interface command `/ship <title>` can
run it, all without touching yxu's code. See **[docs/CUSTOMIZING.md](docs/CUSTOMIZING.md)**
for step types, expressions, commands, prompt overrides, hooks, themes and key bindings.

### Packs

A pack shares a whole setup in one command:

```sh
yxu add python                   # starter packs: python, node, rust, go
yxu add github:acme/yxu-review   # any git repo or folder with a yxu-pack.yaml
yxu packs                        # what's installed, checked against yxu.lock
```

A pack bundles config, workflows, commands, prompt additions and themes. Its names get its own
prefix (`/python:add-tests`), and it is pinned by commit in `yxu.lock`. Before installing, it
shows everything it can run. See **[docs/PACKS.md](docs/PACKS.md)**, which also explains how
to write one.

### Plugins and other orchestrators

When files aren't enough, a TypeScript **plugin** can add:
- slash commands
- side-panel sections
- hooks
- new agent kinds
- new orchestrators

Plugins from a repo or a pack load only after you approve them, and again whenever their code
changes. Pipelines can also run **without Claude**: `orchestrator.provider: agent` lets one of
your local agents plan and review. See **[docs/PLUGINS.md](docs/PLUGINS.md)**.

See [PLAN.md](PLAN.md) for the design and history and
[docs/PUBLIC_PLAN.md](docs/PUBLIC_PLAN.md) for the customization roadmap.

## The interface

`yxu` (or `yxu tui`) opens the interactive instrument in your terminal: a conversation with the
orchestrator, compact rows for every action it takes, a context panel, and a decision boundary
whenever a result is ready to apply.

```sh
yxu tui                     # in any git repo with (or without) a yxu.yaml
yxu tui -w feature          # start in a specific workflow
yxu tui --demo              # scripted replay with fake data: no agents, no git, no cost
yxu tui --ascii             # ASCII glyphs only
yxu tui --reduced-motion    # no pulse animation (elapsed time still updates)
yxu tui --no-color          # no color (state is always also shown as words and glyphs)
```

Environment: `NO_COLOR`, `FORCE_COLOR=0..3`, `COLORTERM=truecolor`, `YXU_ASCII=1`,
`YXU_REDUCED_MOTION=1`, `YXU_NO_BG=1` (don't paint the background).

### Keys

| key | action |
|---|---|
| `enter` | send |
| `alt+enter`, `ctrl+j` (`shift+enter` in kitty-protocol terminals) | new line |
| `↑ ↓` | move in the draft; at the first/last line, input history |
| `pgup pgdn`, `shift+↑ ↓` | scroll the conversation · `end` (empty draft) follows newest |
| `ctrl+↑ ctrl+↓` | select an activity row · `ctrl+o` expand/collapse its details |
| `ctrl+p` | toggle the context panel |
| `esc`, `ctrl+c` | cancel the running operation (agents are killed; your branch is untouched) |
| `ctrl+c ctrl+c`, `ctrl+d` | exit (pending results are listed on exit) |
| `?` | help: keys, commands, and the meaning of every sign |
| `a v l x` | at a decision: apply · view diff · later · discard |

### Slash commands

Type `/` in the message box: a palette lists every command with its description, filtered as
you type. `↑ ↓` select, `tab` completes, `enter` completes and runs (or asks for the next
argument), `esc` closes. Arguments complete too: agent names, fields, models, workflows, task
ids, repo files, on/off. Commands also work while a run is going (changes apply to the next run).

| command | controls |
|---|---|
| `/help` `/status` `/new` `/clear` `/doctor` `/quit` | session |
| `/workflow [name]` | switch workflow (auto or pipeline) |
| `/model [opus\|sonnet\|haiku\|…]` `/effort [low…max\|default]` `/budget [usd\|off]` | the orchestrator |
| `/agents` · `/agent <name> model\|cli\|role\|instructions\|permission\|timeout\|turns <value>` · `/agent new <name> <cli> [model]` · `/agent remove <name>` | each agent |
| `/models [agent\|cli] [search]` · `/models refresh` | browse every model each CLI offers |
| `/concurrency [n]` `/resolver [agent\|off]` `/verify [command\|off]` | how agents run and are checked |
| `/context …` `/compact …` | what the orchestrator sees; conversation compaction (below) |
| `/tasks` `/diff <task>` `/apply <task>` `/discard <task>` | results |
| `/panel [on\|off]` `/motion on\|off` `/ascii on\|off` | the interface |
| `/save [project\|local\|user]` | write this session's setting changes to yxu.yaml, yxu.local.yaml or your user config (comments kept, validated first) |
| `/config [key]` | every setting and the config layer it came from |
| `/packs` | installed packs, their state against yxu.lock, and what each adds |
| `/plugins [approve\|revoke]` | plugins, what they add, and approving the ones from this repo |

**Models come from the CLIs themselves:** `cmd --list-models` (Command Code: 93 models in
sections), `opencode models --verbose` (OpenCode: every configured provider, with context size
and price), and Claude Code's aliases and ids (it has no list command). Lists load in the
background when the TUI starts and are cached for a day in `~/.cache/yxu/models.json`.
`/agent <name> model ` completes from that agent's CLI with the current model first; type to
search ids and descriptions (`kimi`, `flash`, `free`, `1000k`). A model the CLI didn't list is
still accepted (Command Code takes short names) but flagged. Outside the TUI:
`yxu models [agent|cli] [search] [--refresh] [--json]`.

Changes are for the current session until you `/save`. `/status` shows how many are unsaved.
Task ids can be the short suffix shown in the panel. The palette, `/help`, and execution all
come from one registry (`src/tui/commands.ts`).

### The repo map

Every agent shares one map of the repository, so none of them rediscovers the layout on every
task. It covers:
- files and their symbols (with line numbers), and what imports what;
- where the tests are and how they are named;
- entry points, and the test, build and lint commands with the package manager;
- conventions: modules, strictness, formatters and linters, indentation.

yxu builds it from HEAD (what task worktrees start from) and keeps it in `.yxu/repomap.json`.
It updates incrementally: only files whose content changed are read again. On this repo that's
26 ms the first time and 3 ms after.

- **Subagents:** every task gets the part relevant to it (the files and symbols it names, files
  sharing its words, their tests and imports), within `context.repo_map_chars`.
- **The orchestrator:** gets the overview, and a free, instant `find_code(query)` tool for "where
  is X" before reading files or sending a scout.
- **When it's built:** before every run, in the background when the interface starts, and after
  an apply.
- **Commands:** `yxu map [words]` and `/map [words]` show the overview, or what a task about those
  words would get. Turn it off with `context.repo_map: false`.

### Context and compaction

You control what the orchestrator sees and how its conversation is summarized, in `yxu.yaml`
or live in the TUI (live changes apply from the next message; `/context save` writes them back
to `yxu.yaml`, keeping your comments).

```yaml
context:
  memory: true                # TUI messages continue one orchestrator conversation
  project_instructions: true  # load CLAUDE.md
  include: [docs/ARCHITECTURE.md]   # files added to the orchestrator's context (repo-relative)
  include_max_chars: 20000    # per-file cap
  notes: |                    # standing instructions
    Never touch migrations/.
  max_diff_chars: 12000       # how much of each subagent diff the orchestrator reads
compact:
  auto: true                  # Claude Code auto-compaction for orchestrator conversations
  window: 200k                # or "auto" (the model's window); 100k-1m
  instructions: Keep API names and the user's decisions.
  warn_at: 0.8                # TUI warns past 80% of the window
  background: true            # TUI: compact between turns without blocking (below)
  background_at: 0.6          # …once the conversation passes 60% of the window
```

| in the TUI | effect |
|---|---|
| `/context` | report: memory, window use and biggest parts, CLAUDE.md, files, notes, compaction |
| `/context memory on\|off` | continue the conversation, or start fresh every message |
| `/context instructions on\|off` | load CLAUDE.md or not |
| `/context add <file>` · `/context drop <file>` | include a file in every run (inside the repo only) |
| `/context notes <text>` · `/context notes clear` | standing notes |
| `/context save [local\|user]` (or `/save`) | persist all of the above (default: yxu.yaml) |
| `/compact [extra instructions]` | summarize the conversation now; shows before → after tokens |
| `/compact auto on\|off` · `/compact window <200k\|auto>` | auto-compaction and its window |
| `/compact instructions <text>` · `/compact warn <80%>` | what summaries must keep; warning level |
| `/compact background on\|off\|<60%>` | background compaction, and where it starts |

**Background compaction.** Claude Code compacts on its own when the window fills, and that pauses
the orchestrator until it is done. yxu summarizes in the background instead, so it never has to:

- **During a run** (the interface and `yxu run`): while the orchestrator waits on a subagent
  (`delegate`, `delegate_parallel`, `combine`, `verify`) and the window is past `background_at`, yxu
  compacts a fork of the conversation. When the summary is ready, at the end of the next such call,
  the run hands over to it: it continues from the summary, told the call's result and anything
  else since the fork, without a pause. It only hands over when no other result is pending.
- **Between turns** (the interface): after a turn past `background_at`, a fork is summarized while
  you read and type; the panel shows `compact summarizing…`.
- **Nothing is wasted.** A summary is never thrown away because the conversation moved on: if you
  send messages before it is ready, the next message resumes the summary and is told what happened
  since (those turns, or the end of the run it was made during). Only one summary is made at a
  time, and only when the conversation itself is at least a tenth of the window (a summary can't
  shrink the system prompt and tools, so it would only repeat).
- **`yxu run -c`** (`--continue`) continues the repo's last conversation (`.yxu/conversation.json`).
  After a `-c` run past `background_at`, a detached process summarizes it, so your shell is not
  held; the next `yxu run -c` continues from the summary. (A one-off `yxu run` isn't summarized
  afterwards: that summary would usually go unused.)

Claude Code's own auto-compaction stays as the fallback. Measured with Haiku: between turns, a
31k-token conversation summarized to 839 tokens in about 8 seconds with the input free; during a
`yxu run`, a 30k → 1k hand-over while a subagent worked, after which the run (and a later
`yxu run -c`) still knew the task ids and facts from before.

The panel shows a context gauge (`▰▰▱▱▱▱▱▱ 20% 40k/200k`, amber past `warn_at`), the
compaction mode, and what was added. Automatic compactions appear in the conversation with
their token counts. Usage numbers come from Claude Code itself (`getContextUsage`), read at the
end of every reply. Whatever you configure, compaction always keeps task ids, decisions and
changed files, because yxu depends on them. Compaction runs on the orchestrator model and costs
tokens (a real `/compact` of a short Opus conversation: about $0.08).

`yxu context` prints the effective settings and checks the included files (it exits non-zero if
one is missing). `yxu run` and `yxu chat` use the same settings.

### Visual language

Restraint carries the atmosphere; every mark means something and never relies on color alone.

| sign | meaning | color |
|---|---|---|
| `⟡` | the instrument | cyan |
| `▹` | your message | cyan |
| `◈` | orchestrator response | ivory |
| `◴◷◶◵` / `◌` | activity running (slow orbit; static with reduced motion) | cyan |
| `◉` | activity complete | dim |
| `⊗` + "fault" | failure, followed by a `→` recovery step | terracotta |
| `△` + "decision required" | a result waits for you | amber |
| `⁘` | memory / context (turn dividers, panel) | violet |
| `✦ · ·` | header star map: one mark per subagent slot, lit while an agent works | cyan |
| `Ⅰ Ⅱ Ⅲ` | pipeline stages | violet |

ASCII fallbacks exist for all of them (`--ascii`).

### Architecture

Presentation is separate from execution. The TUI only consumes the orchestrator's existing
render hooks (`OrchestratorRender`: streamed text, tool calls, delegate/combine/verify events,
pipeline steps) and the git actions used by the CLI.

```
src/tui/
  theme.ts     palette by color depth (truecolor/256/16/none), glyph sets, motion setting
  text.ts      styled spans, width-aware wrap/truncate, ANSI serialization, ASCII folding
  markdown.ts  response rendering (code fences with gutter, lists, quotes, inline code)
  keys.ts      raw input → key events (modifiers, bracketed paste, kitty CSI-u)
  editor.ts    multiline editor with history
  model.ts     state store: entries, status, decision, context, tasks
  view.ts      pure render: state + size → frame rows (header, conversation, panel, input, footer)
  terminal.ts  alt screen, raw mode, resize, row-diffed drawing, guaranteed restore
  app.ts       controller: keys, commands, runs, decisions; Engine + TaskBackend seams
  recovery.ts  failure → one actionable next step
  demo.ts      DEVELOPMENT ONLY scripted engine + in-memory backend (used by --demo)
```

Agent-side changes made for the interface (all backwards compatible):
streaming text deltas (`includePartialMessages`), conversation resume across turns
(`resume`), a task session shared across turns, cancel-safe query draining, and
`applyTask`/`discardTask` moved to `src/actions.ts` so the CLI and TUI share them.

### Checks

```sh
bun test                 # 179 tests, incl. test/tui.test.ts (keys, editor, layout, frames, interaction)
bunx tsc --noEmit
bun scripts/snapshot.ts --at deciding --width 140 --height 46 [--ascii] [--html out.html]
python3 scripts/pty-drive.py 110 32 <repo> script.json -- bun src/cli.ts tui --demo
```

Frame tests assert, across sizes from 40×16 to 220×60, that every row is exactly the terminal
width, the panel collapses below 100 columns, state words appear (not color alone), `NO_COLOR`
emits no escape codes, ASCII mode emits only ASCII, and reduced motion keeps glyphs still.
`pty-drive.py` runs the real binary in a pseudo-terminal, sends keys and resizes, rebuilds the
screen, and checks that the terminal is restored on exit.

CI runs typecheck, tests, a compiled-binary build and `scripts/smoke.sh` (version, doctor,
and the interface in a real PTY) on Linux and macOS for every push and pull request.

### Releasing

1. Bump `version` in `package.json`, update `CHANGELOG.md`, commit.
2. `git tag v0.1.0 && git push origin v0.1.0`.

`.github/workflows/release.yml` then builds binaries for linux-x64/arm64 and darwin-x64/arm64
(`bun scripts/build-release.ts`), smoke-tests them on native runners, and creates the GitHub
release with `checksums.txt`, the Homebrew formula and the AUR `PKGBUILD`
(`bun scripts/packaging.ts`).

Optional repository secrets turn on publishing; without them, that step is skipped:

| secret | publishes |
|---|---|
| `NPM_TOKEN` | `yxu` plus one `yxu-<os>-<arch>` package per platform on npm |
| `HOMEBREW_TAP_TOKEN` | `Formula/yxu.rb` to `yxu173/homebrew-tap` (needs a token with push access to that repo) |
| `AUR_SSH_PRIVATE_KEY` | `yxu-bin` on the AUR (an SSH key registered with your AUR account) |

Tags with a `-`, such as `v0.1.0-rc.1`, become GitHub pre-releases and use the npm `next` tag,
and they skip Homebrew and the AUR. Pull requests that change the release scripts run the build
and smoke jobs as a dry run.

A compiled binary uses the `claude` on your PATH as the orchestrator engine; set
`YXU_CLAUDE_PATH` to use another one. Running from source uses the engine bundled with the
Agent SDK.

### Integration gaps (honest list)

- **No in-run approval prompts.** Subagents run in their configured permission mode
  (`yolo`/`accept-edits`) and the orchestrator is read-only; none of the agent CLIs expose
  permission requests through the headless interfaces yxu uses. The approval boundary is the
  apply/discard decision, which is where yxu's safety lives (work stays in worktrees).
- **Subagent output is not streamed.** Adapters parse an agent's output when it exits, so a
  running agent shows elapsed time, then its summary, files, and errors at the end. Streaming
  OpenCode/Command Code events live is a possible follow-up.
- **Pipeline workflows don't carry conversation memory**; each message starts a new pipeline,
  so `/compact` and the context gauge apply to auto mode. Included files and notes do reach
  pipeline plan/review calls.
- **Compaction instructions for *automatic* compaction are guidance in the system prompt**;
  Claude Code has no setting for auto-compaction instructions. Manual `/compact` passes them
  directly.
- **No mouse scrolling**, deliberately: capturing the mouse breaks normal text selection.
- `Ⅰ…Ⅹ` and `✦` are East-Asian "ambiguous width"; terminals configured to draw those double
  width will misalign — use `--ascii` there.
- The model's internal reasoning is never shown; only observable actions and its own replies.
