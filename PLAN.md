# yxu — local multi-agent orchestrator CLI

> One brain, many hands: Claude Code (Opus) plans and reviews; cheaper local coding
> agents (Command Code, OpenCode, …) running any model (e.g. DeepSeek) do the work.

## 1. The idea

### Problem
- Opus is the best planner/reviewer but expensive to use for every file edit.
- Cheap models (DeepSeek V4 Flash, etc.) are good at well-scoped coding tasks but weak at
  breaking down large work and judging quality.
- Each coding-agent CLI (Claude Code, Command Code, OpenCode) is its own silo. You
  can't combine them.

### Solution
`yxu` is a local CLI that:
1. Starts **Claude Code as the orchestrator**, using the user's own Claude login or API key.
2. Gives the orchestrator **delegate tools** (over MCP). Each tool runs a **local agent CLI**
   (`cmd`, `opencode`, or `claude`) headless, with the model the user picks.
3. Lets the user **define workflows** in a YAML file: which agents exist, which model each
   uses, which roles they play, and which steps run in what order.

Everything runs on the user's machine with the user's existing CLIs and credentials.
yxu has no backend and stores no keys of its own.

### Example
```
$ yxu run "add OAuth login with GitHub" --workflow feature
▸ orchestrator  claude / opus     planning…        → 3 tasks
▸ coder-1       cmd / deepseek-v4-flash   [worktree t1] backend route   ✓ 2m10s  $0.01
▸ coder-2       cmd / deepseek-v4-flash   [worktree t2] UI button       ✓ 1m40s  $0.01
▸ tester        opencode / …              [worktree t3] tests           ✓ 3m02s
▸ orchestrator  reviewing diffs… requested 1 fix → coder-1 ✓
▸ merged 3 worktrees → branch yxu/oauth-github   total $0.41
```

## 2. Verified building blocks (checked on this machine, 2026-10-24)

| Agent | Installed version | Headless command | Model flag | JSON output | Auto-approve | Isolation |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.309 | `claude -p` / Agent SDK | `--model opus` | `--output-format stream-json` | permission modes | — |
| Command Code | 1.86.3 | `cmd -p "<task>"` | `-m deepseek/deepseek-v4-flash` | `--output-format json` (NDJSON + final result line) | `--yolo` / `--permission-mode accept-edits` | `-w/--worktree` |
| OpenCode | (installed) | `opencode run "<task>"` | `-m provider/model` | `--format json` (raw events) | `--auto` | `--dir <path>`; also `opencode serve` (HTTP) |

DeepSeek models available in Command Code: `deepseek/deepseek-v4-pro`, `deepseek-v4-flash`,
`deepseek-v4.1-flash`, plus `-fast` variants. In OpenCode, DeepSeek is available via
`opencode/deepseek-v4.1-flash-free`, Azure, or Bedrock. A direct `deepseek` provider is not
configured yet (`opencode auth` can add it).

Other flags yxu will rely on: `cmd --max-turns`, `--skip-onboarding`, `--no-auto-update`,
`-t/--trust`, `--no-session`. OpenCode also offers `opencode acp` (Agent Client Protocol),
which could serve as a later, more structured adapter.

## 3. Architecture

```
┌──────────────────────────── yxu CLI (Node/TS, Bun-compiled binary) ───────────────────────────┐
│                                                                                             │
│  Config loader ── yxu.yaml (project) + ~/.config/yxu/config.yaml (global)                    │
│        │                                                                                    │
│  Orchestrator runner ── Claude Agent SDK  (model: opus, system prompt from workflow)        │
│        │  in-process MCP server "yxu"                                                       │
│        ▼                                                                                    │
│  Tools exposed to Opus:                                                                     │
│    delegate(agent, task, files?, context?)  → runs one subagent, returns result + diff      │
│    delegate_parallel([...])                 → fan-out in separate worktrees                 │
│    list_agents()  get_diff(task)  merge(task)  discard(task)  ask_user(question)            │
│        │                                                                                    │
│  Task runner ── git worktree per task · concurrency limit · timeout · retries               │
│        │                                                                                    │
│  Adapters (one per CLI, same interface):                                                    │
│    CommandCodeAdapter  → spawn `cmd -p … --output-format json -m … --yolo`                  │
│    OpenCodeAdapter     → spawn `opencode run … --format json -m … --auto --dir …`           │
│    ClaudeCodeAdapter   → Agent SDK subagent (e.g. sonnet/haiku)                             │
│    GenericAdapter      → any CLI via command template in YAML                               │
│        │                                                                                    │
│  Event bus → TUI/log renderer · run store (.yxu/runs/<id>/*.jsonl) · cost/token tracker      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key design decisions
1. **Subagents are MCP tools for Claude Code.** This is the cleanest way to make Claude Code
   the orchestrator: Opus calls `delegate` like any other tool, and yxu handles processes,
   worktrees, and parsing. It works in both modes:
   - `yxu run` drives Claude through the **Agent SDK** (headless, scriptable, streamed).
   - `yxu chat` launches the normal interactive `claude` with `--mcp-config` pointing at
     `yxu mcp`, so you keep the familiar Claude Code UI and get the delegate tools added.
2. **Adapter interface.** Every agent implements
   `run(task: TaskSpec, signal): AsyncIterable<AgentEvent>` → final `TaskResult { status,
   summary, diff, filesChanged, tokens, cost, sessionId }`. Adding a new CLI (Codex, Gemini
   CLI, Aider…) means writing one adapter, or a few lines of YAML for the generic one.
3. **Git worktree isolation per task.** Parallel subagents never edit the same checkout. The
   orchestrator reviews each diff and calls `merge` or `discard`. Merge conflicts go back to
   the orchestrator as a task.
4. **The orchestrator never sees raw logs.** Subagent output is condensed to a summary, the
   diff, and the test result. This keeps Opus's context and cost small.
5. **Bring your own auth.** yxu calls the user's installed CLIs, so it reuses
   `claude` login, `cmd status`, and `opencode auth`. `yxu doctor` checks all of them.

## 4. User customization: `yxu.yaml`

```yaml
orchestrator:
  agent: claude
  model: opus
  effort: high
  max_budget_usd: 5

agents:
  coder:
    cli: commandcode
    model: deepseek/deepseek-v4-flash
    permission: yolo            # yolo | accept-edits | plan
    max_turns: 60
    timeout: 15m
  heavy-coder:
    cli: commandcode
    model: deepseek/deepseek-v4-pro
  tester:
    cli: opencode
    model: opencode/deepseek-v4.1-flash-free
    agent: build                # opencode --agent
  reviewer:
    cli: claude
    model: sonnet
  aider:                        # generic adapter example
    cli: generic
    command: ["aider", "--yes", "--message", "{{task}}", "--model", "{{model}}"]

workflows:
  # Free mode: Opus decides who does what.
  default:
    mode: auto
    allowed_agents: [coder, heavy-coder, tester]
    instructions: |
      Break work into small independent tasks. Prefer `coder`; use `heavy-coder`
      only for tasks touching >5 files. Always run `tester` before finishing.

  # Pipeline mode: fixed steps that the user controls.
  feature:
    mode: pipeline
    steps:
      - id: plan
        agent: orchestrator
        output: tasks           # structured task list
      - id: implement
        agent: coder
        for_each: tasks
        parallel: 3
      - id: test
        agent: tester
        prompt: "Write and run tests for: {{plan.summary}}"
      - id: review
        agent: orchestrator
        loop_until: approved    # review → fix → review, max 3 rounds
        max_rounds: 3

settings:
  isolation: worktree           # worktree | none
  concurrency: 3
```

## 5. CLI surface

```
yxu init                       # create yxu.yaml; detect installed CLIs and models
yxu doctor                     # check claude/cmd/opencode installed, logged in, models reachable
yxu agents                     # list configured agents and their models
yxu run "<goal>" [-w workflow] [--dry-run] [--budget 3]
yxu chat [-w workflow]         # interactive Claude Code with yxu delegate tools
yxu mcp                        # run yxu as a stdio MCP server (for any MCP client)
yxu delegate <agent> "<task>"  # run one subagent directly (debugging)
yxu runs | yxu show <id>       # history, per-task logs, diffs, cost
yxu apply <id> | yxu discard <id>
```

## 6. Tech stack
- **TypeScript on Node 22+ / Bun**. The Claude Agent SDK is first-class in TS, and
  `bun build --compile` produces a single binary.
- `@anthropic-ai/claude-agent-sdk` (orchestrator plus in-process MCP server),
  `@modelcontextprotocol/sdk` (stdio server for `yxu mcp`).
- `commander` or `citty` for the CLI, `ink` for the live TUI, `zod` for config validation,
  `yaml`, `execa` for spawning, `simple-git` for worktrees.
- Run store: plain JSONL files under `.yxu/runs/`. No database in v1.

## 7. Roadmap

| Phase | Scope | Done when |
|---|---|---|
| **0. Spike (1–2 days)** | Script that spawns `cmd -p --output-format json -m deepseek/...` and parses the NDJSON. Same for `opencode run --format json`. Document the event shapes. | Both adapters return `{summary, diff}` for a toy task |
| **1. MVP** | `yxu.yaml` loader, Command Code + OpenCode + Claude adapters, `delegate` MCP tool, `yxu run` with Opus via Agent SDK, sequential execution, plain log output | "Add a CLI flag to repo X" finishes end to end with DeepSeek doing the edits |
| **2. Parallel + isolation** | Worktrees, `delegate_parallel`, concurrency, `merge/discard`, timeouts, cancellation (Ctrl-C kills the process tree) | 3 parallel tasks merge cleanly |
| **3. Workflows** | Pipeline mode (`steps`, `for_each`, `loop_until`), templating, `yxu chat` | The `feature` workflow above runs |
| **4. UX + cost** | Ink TUI, per-agent token/cost tracking, budgets, `yxu runs/show`, `yxu doctor`, `yxu init` | — |
| **5. Extensibility** | Generic adapter, ACP adapter for OpenCode, shareable workflow presets | — |

## 8. Risks and mitigations
- **CLI output formats change** (both tools ship often; Command Code auto-updated from
  1.84 to 1.86 during this check). → Pin versions in `yxu doctor`, pass `--no-auto-update`,
  write tolerant parsers, and keep snapshot tests of real NDJSON.
- **Subagents running in `--yolo`** can do anything. → Use worktree isolation, never
  auto-merge (only `yxu apply` merges), add an optional command denylist, and show a clear warning in
  `yxu init`.
- **The cheap model returns bad work.** → The orchestrator reviews every diff, and a
  `loop_until: approved` review loop sends fixes back. Escalate to `heavy-coder` after
  N failures.
- **Opus context bloat.** → Send only summaries and diffs back, truncate large diffs, and
  give Opus a `get_diff` tool to pull full diffs on demand.
- **Terms of service.** Driving each vendor's CLI with the user's own account is fine for
  personal local use. Re-check each provider's terms before offering this as a hosted or
  shared service.

## 9. Status

**Phase 0 done (2026-10-24).** `yxu delegate | show | apply | discard | doctor` work with
adapters for Command Code, OpenCode, and Claude. Each task runs in a worktree, and a task with
no changes cleans itself up. Parsers are tested against real captured output in `test/fixtures/`.
- Verified end to end: OpenCode + `opencode/deepseek-v4.1-flash-free`, and Claude + `haiku`.
- Not yet verified: a *successful* Command Code run, because the account hit its weekly limit
  (resets 2026-10-26). Its tool/text event shapes still need to be captured and its parser
  finished.

**Phase 1 done (2026-10-24).**
- `yxu.yaml` loader with zod validation. Lookup order: project `yxu.yaml`, then
  `~/.config/yxu/config.yaml`, then built-in defaults.
- Commands: `yxu init`, `yxu agents`, and `yxu delegate <agent>`.
- `yxu run "<goal>"`: Opus runs through the Agent SDK with read-only tools (Read/Grep/Glob)
  plus an in-process MCP server offering `list_agents`, `delegate(agent, task, build_on?)`,
  `get_diff`, and `discard`. Delegates run one at a time.
- `build_on` chains a task onto an earlier task's branch, which is how dependent tasks and
  fix-ups work. `yxu apply <tip>` merges the whole chain and cleans up its worktrees. Nothing
  is ever applied automatically.
- Each run is recorded in `.yxu/sessions/run-*.json`.
- Verified end to end: Opus + OpenCode/DeepSeek built a CLI and 9 tests for a toy repo, caught
  committed `.pyc` files in review, and delegated a fix. Apply merged both tasks and the tests
  pass. Cost: orchestrator $1.69, subagents $0.
- Known: orchestrator cost is high for small goals. The likely cause is the large `claude_code`
  preset system prompt; try a lean custom prompt in Phase 4. Build artifacts that aren't
  gitignored get committed into task branches, so the orchestrator has to catch them.

**Phase 2 done (2026-10-24).**
- `delegate_parallel(tasks)` runs independent tasks at the same time, each in its own worktree,
  limited by `settings.concurrency` (default 3).
- `combine(task_ids, resolver?)` merges several task branches into one new task starting from
  HEAD. Conflicts are handled by a resolver agent (`settings.resolver`). If markers remain or
  the resolver fails, the merge is aborted and cleaned up. Also available as
  `yxu combine <ids…> [--resolver agent]`.
- `yxu apply` cleans up every ancestor (build_on chains and combine parents). If the task
  conflicts with your branch, it aborts the merge, lists the files, and changes nothing.
- Subagents run in their own process group. Ctrl-C or a timeout kills the agent and everything
  it spawned, and an exit handler SIGKILLs anything left over.
- Verified for real:
  - Opus ran 3 DeepSeek tasks in parallel (finished in 20s, 20s, and 35s), combined them with
    no conflicts, and discarded the parents. After apply, `make test` passed 13 tests.
    Orchestrator cost: $1.82.
  - Two DeepSeek tasks edited the same function. The resolver agent kept both intents, and
    tests pass after apply.
  - Ctrl-C left no agent processes running.
  - Applying onto a diverged branch was refused and changed nothing.
- Tests: 23 pass, including combine/conflict/resolver tests using a fake `opencode` binary.
- Known: Opus doesn't re-run tests on the combined result, which needs a verify/tester step
  (Phase 3). Orchestrator cost is still about $1.7–1.8 per run.

**Phase 3 done (2026-10-24).**
- **Pipeline workflows** (`mode: pipeline`) have four step types:
  - `plan`: Opus returns structured tasks.
  - `delegate`: one prompt template, or `for_each` a plan, running in parallel then combined.
  - `verify`: runs a command, with an optional fix loop via `fix_agent`.
  - `review`: Opus reviews the cumulative diff plus the verify output, and delegates fixes
    until approved or `max_rounds` is reached.
  - Templates support `{{goal}}` and `{{step.summary|output}}`. Config validation catches
    bad `for_each`, unknown agents, and missing commands.
- **`verify` tool** for auto mode, using `settings.verify` and `verify_timeout`. `yxu init`
  detects the test command (npm/bun/pnpm, cargo, go, pytest, make).
- **`yxu mcp`**: a stdio MCP server with all 7 tools. It can write a session snapshot.
- **`yxu chat`**: interactive `claude` with the yxu tools attached and Edit/Write disabled
  (`--allow-edits` to override). Apply hints are printed when it exits. `-p` runs it
  non-interactively.
- **Big cost fix:** orchestrator sessions and Claude subagents were loading the user's global
  plugins, hooks, and claude.ai connectors (145 tools in this environment). They are now
  isolated (`settingSources: ["project"]`, strict MCP). Opt back in with
  `orchestrator.user_settings: true` or `chat --user-settings`. Measured on the same pipeline:
  **$3.26 → $0.16**.
- Bugs found in real runs and fixed:
  - zod's draft-2020-12 `$schema` was rejected by Claude Code. Now emits draft-07.
  - zod 4 defaults skip transforms, so `verify_timeout` was 600 ms instead of 600 s.
    Regression test added.
- Verified for real: full `feature` pipeline (plan → implement → verify → review approved) for
  $0.16. `yxu chat -p` with Haiku ran delegate + verify through MCP. The MCP server was checked
  with an MCP client. Tests: 33 pass.

**TUI done (2026-10-24).** `yxu` / `yxu tui` opens an interactive terminal interface.
- Built on a custom renderer with no new dependencies: a pure `view(state, size)` function plus
  a row-diffing terminal driver. Visual direction: "ancient instrument / deep space", with ivory,
  cyan, amber, and violet on a dark ground, and meaningful glyphs with ASCII fallbacks.
- Layout: a responsive header with a subagent "star map", the conversation, a collapsible
  context panel, a multiline input, and a footer. Results get an amber decision boundary
  (apply / diff / later / discard).
- Integration: streamed text, orchestrator conversation resume, a task session shared across
  turns, cancel-safe draining, and shared `src/actions.ts`.
- Checks: 63 tests. Snapshot script plus browser proof. A real-PTY drive of `--demo` and of a
  real Opus + DeepSeek run ($0.086), including resize, cancel, and terminal restore.
- Gaps: listed in README.md (no in-run approvals, subagent output not streamed live, no
  pipeline memory, no mouse).

**Context & compaction controls (2026-10-24).**
- New `context:` and `compact:` config sections, applied to `run`, `chat`, and the TUI:
  - context: memory, CLAUDE.md on/off, included files, notes, diff budget
  - compact: auto on/off, window, instructions, warning threshold
- TUI: `/context …` and `/compact …` change these live; `/context save` writes them to yxu.yaml
  and keeps comments. Also added: a panel gauge, auto/manual compaction events, and a
  threshold warning. `yxu context` shows the effective settings.
- Verified with real Opus: an included file reached the orchestrator, the 200k window was
  honored (auto-compaction at 167k), and a real `/compact` took the conversation from
  10k to 2k tokens. 80 tests pass.

**Slash-command palette (2026-10-24).**
- Typing `/` opens a filtered palette, with argument completion for agents, fields, models,
  workflows, tasks, and repo files.
- 25 commands, all from one registry, cover every setting: orchestrator model, effort, and
  budget; per-agent model, timeout, permission, and turns; concurrency, resolver, verify,
  context, compact, the interface, and tasks.
- Session changes are tracked and written by `/save`, keeping comments and validating first.
- Tests: 92 pass. Real-PTY drive of `/`, the arrow keys, tab, and enter.

**Model catalog (2026-10-24).** Model lists come from each CLI:
- Command Code: `cmd --list-models`, 93 models.
- OpenCode: `opencode models --verbose`, 294 active models across 12 providers, with context
  size and price.
- Claude: static aliases and ids.

Lists are cached for a day, load in the background, and feed `/agent <name> model` and
`/model` completion (current model first, search by id or description), `/models`, and
`yxu models`. 103 tests pass; real-PTY drive with the real lists.

## 10. Decisions (2026-10-24)
1. Name: **yxu**.
2. MVP subagents: **Command Code, OpenCode, and Claude** (Claude adapter moves into Phase 1).
3. **No direct apply.** Subagent work stays in worktrees until the user runs `yxu apply <id>`.
   `auto_merge` is not offered in v1.
