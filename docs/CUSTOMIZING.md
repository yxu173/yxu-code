# Customizing yxu

Everything here is a file you can commit and share; no code changes are needed. Team files go
in the repo (`yxu.yaml`, `.yxu/…`) and personal ones in `~/.config/yxu/…`. Where both exist,
the project file wins. See the README's *Configuration* section for how the config layers
combine.

| What | Team (commit it) | Personal |
|---|---|---|
| settings, agents, hooks, ui | `yxu.yaml` | `yxu.local.yaml` (this repo), `~/.config/yxu/config.yaml` |
| workflows | `.yxu/workflows/<name>.yaml` | `~/.config/yxu/workflows/<name>.yaml` |
| slash commands | `.yxu/commands/<name>.md` | `~/.config/yxu/commands/<name>.md` |
| prompt overrides | `.yxu/prompts/<name>.md` | `~/.config/yxu/prompts/<name>.md` |
| themes | | `~/.config/yxu/themes/<name>.yaml` |
| all of the above, bundled | a pack in `.yxu/packs/<name>/` (`yxu add`) | `~/.config/yxu/packs/<name>/` (`yxu add --user`) |

To share a setup across repos or teams, put it in a pack: see [PACKS.md](PACKS.md).

yxu only keeps its runtime files out of git (`.yxu/worktrees/`, `runs/`, `sessions/`,
`history.jsonl`), so the rest of `.yxu/` can be committed.

## Workflows

A workflow is either `mode: auto` (Claude plans freely with your agents) or `mode: pipeline`,
a list of steps. Each pipeline step has an `id`, and later steps can read its result as
`{{<id>.ok}}`, `{{<id>.summary}}`, `{{<id>.output}}` and `{{<id>.exit_code}}`.

| step | what it does |
|---|---|
| `plan` | Claude splits the goal into tasks (`{{plan.tasks}}`) |
| `delegate` | an agent does one task (`prompt:`) or one per planned task (`for_each: plan`, in parallel, combined) |
| `verify` | runs a check command on the work so far; optional `fix_agent` repairs failures |
| `review` | Claude reviews the diff; `fix_agent` applies requested fixes |
| `shell` | runs a command on the work so far (in its own worktree); files it changes become part of the result. `in: repo` runs in your checkout instead |
| `gate` | stops and asks you (`y` / `n` in the interface, a prompt in the terminal, `--yes` in scripts) |
| `parallel` | runs its `steps:` at the same time and combines their changes |
| `loop` | repeats its `steps:` until `until:` is true, at most `max_rounds` times |
| `workflow` | runs another pipeline workflow here, with `inputs:` |

Every step also accepts:
- `if:` / `unless:` to run conditionally
- `continue_on_error: true` to record a failure and keep going
- `description:` shown while the step runs

**Expressions** (in `if`, `unless`, `until` and inside `{{ }}`) cover:
- paths such as `plan.tasks.length`
- strings, numbers and `true` / `false`
- comparisons: `== != > < >= <=`
- logic: `&& || !`
- `contains`, e.g. `review.summary contains "security"`

Nothing is evaluated as code. In `shell` commands, every `{{ }}` value is shell-quoted.

**Inputs and outputs:**
- `inputs:` declares values the workflow needs. A default makes an input optional.
- `outputs:` reports results at the end.
- Pass inputs with `yxu run -w <name> -i key=value`, `/run <name> key=value` in the interface, or a command.

**Environment of shell steps:** `YXU_GOAL`, `YXU_REPO`, `YXU_WORKFLOW`, and once there is work
so far, `YXU_HEAD` (task id) and `YXU_HEAD_BRANCH`.

### Example: lint → fix → test → PR

`.yxu/workflows/ship.yaml`:

```yaml
version: 1
mode: pipeline
description: Lint, let an agent fix what lint finds, test, then open a PR
inputs:
  title: { description: pull request title }
  base: { default: main }
outputs:
  branch: "{{ head.branch }}"
steps:
  - id: lint
    type: shell
    command: npm run lint
    continue_on_error: true            # its failure is the next step's input
  - id: fix
    type: delegate
    agent: coder
    if: "!lint.ok"
    prompt: |
      Fix every problem this linter reports, without changing behavior:
      {{ lint.output }}
  - id: test
    type: verify
    command: npm test
    fix_agent: coder
  - id: confirm
    type: gate
    message: "Open a pull request \"{{ inputs.title }}\" from {{ head.branch }}?"
  - id: pr
    type: shell
    in: repo
    command: git push -u origin "$YXU_HEAD_BRANCH" && gh pr create --head "$YXU_HEAD_BRANCH" --base {{ inputs.base }} --title {{ inputs.title }} --fill
```

`.yxu/commands/ship.md`:

```markdown
---
description: Lint, fix, test and open a PR
kind: workflow
workflow: ship
args: [title]
---
Ship: {{ title }}
```

Then `/ship Clean up lint` in the interface, or `yxu run "/ship Clean up lint"`.

## Slash commands

A Markdown file with YAML front matter. The file name is the command name.

```markdown
---
description: Add tests for a file and make them pass
args: [file]                 # completes repo files; also: agent, workflow
agents: [coder]              # optional: only these agents
workflow: feature            # optional: run the prompt with this workflow
---
Write thorough unit tests for {{file}}. Follow the existing test style. Run {{settings.verify}}.
```

- **prompt** (the default) sends the body as your message.
- **workflow** (`kind: workflow` and `workflow:`) runs a pipeline. Arguments fill inputs with the same name, or map them with `inputs: { version: "{{ v }}" }`.
- **shell** (`command:`) runs a command in the repo and shows the output.

The last argument takes the rest of the line. You can also write an argument as
`{ name: x, required: false, default: …, complete: file|agent|workflow|none }`.

Commands show up in the `/` palette and in `?` help. `/commands` (or `yxu commands`) lists them
and reloads them from disk, and reports any file with a problem.

## Prompts

These built-in prompts can be overridden:
- `orchestrator`
- `planner`
- `reviewer`
- `subagent-preamble`
- `conflict-resolver`

A file in `.yxu/prompts/<name>.md` is appended to the prompt by default. Use front matter
`mode: replace` to replace it. Overrides can use the prompt's variables, which `yxu prompts`
lists. `yxu prompts show <name>` prints the effective prompt.

```markdown
---
mode: append
---
This is a Django project. Tasks that touch models must include a migration.
```

## Hooks

```yaml
hooks:
  before_run:   ["git diff --quiet || (echo 'commit your changes first'; exit 1)"]
  after_task:   ["npx prettier --write {{task.files}}"]   # runs in the task's worktree; changes join the task
  before_apply: ["npm test"]                              # runs in the task's worktree; failing blocks apply
  on_failure:   ["notify-send yxu 'run failed'"]
  on_complete:  ["curl -s -X POST \"$SLACK_WEBHOOK\" -d @-"]   # the event JSON is on stdin
```

- **What each command gets:** the event as JSON on stdin and `YXU_EVENT` in its environment. `{{ }}` placeholders are filled from the same data, shell-quoted.
- **`before_run` and `before_apply` block:** a non-zero exit stops the run or the apply.
- **The other hooks only report:** a failure shows up as a warning.

## Look and keys

```yaml
ui:
  theme: light                 # instrument (default), high-contrast, light, mono, or your own
  panel: true                  # side panel open at start
  panel_sections: [tasks, cost, context, agents]
  footer: true                 # key hints
  keys: { panel: ctrl+b, apply: "y", newline: shift+enter }
```

- **Switching themes:** `/theme <name>` switches immediately, and `/save --user` keeps it.
- **Your own theme:** add `~/.config/yxu/themes/<name>.yaml`:

  ```yaml
  extends: light
  colors: { cyan: "#2aa198", amber: "#b58900" }   # roles: ivory dim faint cyan amber violet fault bg panel
  glyphs: { mark: "◆" }
  ```

- **Keys:**
  - `/keys` or `yxu keys` lists the bindings, and a rebound action stops answering to its old key.
  - Single-letter bindings only act on an empty message, so they never get in the way of typing.
  - Clashes are reported when the config loads.
