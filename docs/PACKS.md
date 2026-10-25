# Packs

A pack shares a yxu setup in one command. It can bundle any of:
- config: agents, settings, hooks, ui
- workflows
- slash commands
- prompt additions
- themes

```sh
yxu add python                          # a starter pack built into yxu
yxu add github:acme/yxu-review          # a GitHub repo (gitlab:, codeberg: work too)
yxu add github:acme/presets/packs/go@v2 # a folder inside a repo, at a tag, branch or commit
yxu add https://git.example.com/x.git#main
yxu add ./my-pack                       # a local folder (handy while writing one)
yxu add python --user                   # for every repo, not just this one
```

`yxu add` shows what the pack adds and **every command it can run** before installing:
- hooks
- the verify command
- shell steps and shell slash commands
- agent commands

A pack that runs commands asks for confirmation; `--yes` skips the question (needed in scripts).
Starter packs install without asking.

## Where packs live

| scope | folder | pinned in | applies |
|---|---|---|---|
| project (default) | `.yxu/packs/<name>/` | `yxu.lock` | just below `yxu.yaml` |
| user (`--user`) | `~/.config/yxu/packs/<name>/` | `~/.config/yxu/yxu.lock` | just below `~/.config/yxu/config.yaml` |

- **The pack's files are copied into the repo.** Commit `.yxu/packs/` and `yxu.lock`, and everyone on the team gets the same pack without fetching anything. The changes also show up in code review.
- **Your own files always win.** Anything a pack sets can be overridden in `yxu.yaml`, `yxu.local.yaml` or your user config.
  - `yxu config explain` shows which pack a value came from, e.g. `settings.verify ← pack python (.yxu/packs/python)`.
  - The usual layer rules apply: maps merge, lists replace. A pack's `hooks.after_task` list therefore replaces a lower layer's list, it is not added to it.
- **Names get a prefix.** A pack's workflows and commands are prefixed with its name, `python:add-tests` and `/python:add-tests`, so two packs never clash. `--as <name>` installs a pack under another name.
- **Project packs need trust.** They belong to the repo, so their commands wait for `yxu trust` like the repo's own config. User packs are yours and always trusted.

## Keeping in step

```sh
yxu packs                   # installed packs, and whether each matches yxu.lock
yxu packs list -v           # … with what each adds and can run
yxu packs update [name...]  # fetch again (same branch/tag; starter packs from this yxu), show the changed files, re-pin
yxu packs remove <name>     # delete the folder and the lock entry
yxu packs install           # install what yxu.lock lists but the folder lacks, at the locked commit
```

`yxu.lock` records each pack's source, branch or tag, exact commit, version, and a content
hash. `yxu packs` and `yxu doctor` report a pack whose files no longer match the hash (edited by
hand), and one that is locked but missing.

Every install, update and remove first loads the whole config. If that fails, for example because
the pack names an agent you don't have, nothing is changed and the error says why.

## Starter packs

| pack | verify command | adds |
|---|---|---|
| `python` | pytest (through `uv run` or `poetry run` when the project uses them) | Python conventions for agents, `/python:add-tests <target>`, `/python:lint` (ruff, else flake8) |
| `node` | the `test` script with the package manager the lock file shows | Node/TypeScript conventions, `/node:add-tests`, `/node:lint` (lint script, else `tsc --noEmit`) |
| `rust` | `cargo test --quiet` | Rust conventions, `/rust:add-tests`, `/rust:lint` (clippy with warnings as errors, `cargo fmt --check`) |
| `go` | `go vet ./... && go test ./...` | Go conventions, `/go:add-tests`, `/go:lint` (golangci-lint, else gofmt and vet) |

`yxu init` suggests the one that fits the repo. The packs' source is in [`packs/`](../packs),
and they are also good examples for writing your own.

## `extends:` for shared config

A config file can start from shared bases. The file's own values win:

```yaml
# yxu.yaml
extends:
  - ./config/base.yaml                          # relative to this file
  - github:acme/yxu-presets/python.yaml@v1      # a file in a repo
agents:
  coder: { cli: opencode, model: opencode/deepseek-v4.1-flash-free }
```

- **Remote bases** are fetched once, cached in `~/.cache/yxu/extends`, and pinned (commit and hash) in `yxu.lock`. Later loads use the cache, so there is no network on every command.
- **Teammates** get the locked commit. When upstream changes, nothing moves until someone runs `yxu packs update --extends`.
- **Bases can extend other bases.** Loops are reported.

Use `extends:` for plain config. Use a pack when you also want workflows, commands, prompts or themes.

## Writing a pack

A pack is a folder (usually a git repo, or a folder inside one) with a `yxu-pack.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/yxu173/yxu-code/main/schema/yxu-pack.schema.json
name: review                  # lowercase words; the default namespace
version: 0.3.0
description: Strict review workflows for risky changes
yxu: ">=0.1.0"                # oldest yxu it works with (optional)
detect: [package.json]        # files that make `yxu init` suggest it (optional)
homepage: https://github.com/acme/yxu-review

config:                       # any yxu config except extends/version
  settings:
    verify: npm test
  hooks:
    before_apply: ["npm run lint"]
```

Next to it, any of:

```
workflows/<name>.yaml     → workflow <pack>:<name>   (one workflow per file, as in .yxu/workflows)
commands/<name>.md        → /<pack>:<name>           (as in .yxu/commands)
prompts/<prompt>.md       → appended to a built-in prompt (or `mode: replace`), as in .yxu/prompts
themes/<name>.yaml        → theme <name>             (as in ~/.config/yxu/themes)
README.md                 → for people; yxu ignores it
```

Inside a pack, refer to the pack's own workflows by their short names. yxu adds the prefix:
- in `type: workflow` steps
- in commands' `workflow:` field

**Don't hard-code agent names.** A pack can't know what the user's agents are called, so use
`agent: default` / `fix_agent: default`. It means the user's `settings.default_agent`, or else
their first agent:

```yaml
# workflows/strict.yaml
mode: pipeline
inputs:
  target: { description: what to review }
steps:
  - id: fix
    type: delegate
    agent: default
    prompt: "Tighten error handling in {{inputs.target}}. {{goal}}"
  - id: verify
    type: verify
    fix_agent: default
  - id: review
    type: review
    fix_agent: default
```

A pack may also define agents in `config.agents`, e.g. a pack that sets up aider. Those agents
keep their names.

**Try it locally** with `yxu add ./my-pack`, then `yxu packs update my-pack` after each
edit. Publish it by pushing the folder to a git repo. Others install it with
`yxu add github:you/repo` (or `github:you/repo/path/to/pack` for a pack in a subfolder).
