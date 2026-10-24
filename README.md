# yxu

[![ci](https://github.com/yxu173/yxu-code/actions/workflows/ci.yml/badge.svg)](https://github.com/yxu173/yxu-code/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local multi-agent orchestrator for your terminal. Claude Code (Opus) plans and reviews; the
coding agents you already have installed (Command Code, OpenCode, Claude) do the work in
isolated git worktrees; nothing reaches your branch until you run `apply`.

Everything runs on your machine with your own CLIs and logins. yxu has no server, no account
and no telemetry.

## Requirements

- Linux or macOS (Windows: use WSL)
- `git`
- [Claude Code](https://claude.com/claude-code) installed and logged in. It drives the orchestrator.
- At least one coding agent CLI as a subagent: [OpenCode](https://opencode.ai) (`opencode`),
  [Command Code](https://commandcode.ai) (`cmd`), or Claude Code itself (`claude`)

## Install

```sh
# prebuilt binary (Linux/macOS, x64/arm64), checksum-verified, into ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/yxu173/yxu-code/main/install.sh | sh

# or with npm (no Bun needed; picks the right binary for your platform)
npm install -g yxu

# or from source (needs Bun ≥ 1.3)
git clone https://github.com/yxu173/yxu-code && cd yxu-code && bun install && bun link
```

`install.sh` honours `YXU_VERSION=v0.1.0` (pin a version) and `YXU_INSTALL_DIR`.

## Quick start

```sh
cd your-git-repo
yxu doctor         # checks Claude Code, your agent CLIs and the config
yxu init           # writes a starter yxu.yaml (agents, workflows, verify command)
yxu                # open the interface; describe a goal
yxu --demo         # a scripted tour of the interface: no agents, no git changes, no cost
```

A typical run: Opus reads the repo and plans, then delegates tasks to your agents in parallel
worktrees. It checks the results (and your `verify` command), then asks you to **apply**, **view
the diff**, decide **later** or **discard**. From scripts, use `yxu run "<goal>"`, then
`yxu show <task>` and `yxu apply <task>`.

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
| `/agents` · `/agent <name> model\|timeout\|permission\|turns <value>` | each agent |
| `/models [agent\|cli] [search]` · `/models refresh` | browse every model each CLI offers |
| `/concurrency [n]` `/resolver [agent\|off]` `/verify [command\|off]` | how agents run and are checked |
| `/context …` `/compact …` | what the orchestrator sees; conversation compaction (below) |
| `/tasks` `/diff <task>` `/apply <task>` `/discard <task>` | results |
| `/panel [on\|off]` `/motion on\|off` `/ascii on\|off` | the interface |
| `/save` | write this session's setting changes to yxu.yaml (comments kept, validated first) |

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
```

| in the TUI | effect |
|---|---|
| `/context` | report: memory, window use and biggest parts, CLAUDE.md, files, notes, compaction |
| `/context memory on\|off` | continue the conversation, or start fresh every message |
| `/context instructions on\|off` | load CLAUDE.md or not |
| `/context add <file>` · `/context drop <file>` | include a file in every run (inside the repo only) |
| `/context notes <text>` · `/context notes clear` | standing notes |
| `/context save` (or `/save`) | persist all of the above to yxu.yaml |
| `/compact [extra instructions]` | summarize the conversation now; shows before → after tokens |
| `/compact auto on\|off` · `/compact window <200k\|auto>` | auto-compaction and its window |
| `/compact instructions <text>` · `/compact warn <80%>` | what summaries must keep; warning level |

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
bun test                 # 106 tests, incl. test/tui.test.ts (keys, editor, layout, frames, interaction)
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
release with `checksums.txt`. If the `NPM_TOKEN` repository secret is set, it also publishes
`yxu` plus one `yxu-<os>-<arch>` package per platform to npm. Tags with a `-`, such as
`v0.1.0-rc.1`, become pre-releases on the npm `next` tag.

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
