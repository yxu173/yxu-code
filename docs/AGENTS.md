# Agents

yxu runs coding agents you already have. Each agent works in its own git worktree, and nothing
reaches your branch until you `apply`. There are three ways to add an agent, all in config.

## 1. Built-in CLIs

```yaml
agents:
  coder: { cli: opencode, model: opencode/deepseek-v4.1-flash-free }
  cc:    { cli: commandcode, model: deepseek/deepseek-v4-flash }
  claude-coder: { cli: claude, model: sonnet }
```

### Roles

Any agent can carry a role. `description` tells the orchestrator when to use it, `instructions`
is put before every task it gets, and `permission: plan` makes it read-only (its summary is the
answer; it changes nothing). The starter team (`yxu init`, see the README) is built this way:

```yaml
agents:
  security:
    cli: claude
    model: sonnet
    permission: plan
    description: Reviews auth, input handling and secrets for vulnerabilities.
    instructions: |
      Role: security reviewer. Report each finding as severity, path:line, the risk and a fix.
      Only report problems you can point to. Change nothing.
```

In the interface: `/agent new security claude sonnet`, `/agent security role …`,
`/agent security instructions …`, `/agent security permission plan`, then `/save`.
`/agent <name> cli <cli> [model]` moves an agent to another CLI and keeps its role.

## 2. ACP agents (recommended for anything that supports it)

Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com). yxu streams
its tool calls live, chooses its model, and asks you before it runs commands.

```yaml
agents:
  oc-acp:
    cli: acp
    command: [opencode, acp]
    model: opencode/deepseek-v4.1-flash-free      # `yxu models oc-acp` lists what it offers
  gemini:
    cli: acp
    command: [gemini, --experimental-acp]
  claude-acp:
    cli: acp
    command: [npx, -y, "@agentclientprotocol/claude-agent-acp"]
    model: haiku
```

## 3. Generic CLIs

Describe how to run any CLI and how to read its output:

```yaml
agents:
  aider:
    cli: generic
    command: [aider, --yes-always, --no-auto-commits, --no-check-update, --model, "{{model}}", --message, "{{task}}"]
    model: deepseek/deepseek-chat
    env: { DEEPSEEK_API_KEY: "env:DEEPSEEK_API_KEY" }   # read from your environment, never stored
  claude-json:
    cli: generic
    command: [claude, -p, "{{task}}", --output-format, json, --model, "{{model}}", --permission-mode, acceptEdits]
    model: haiku
    output: json               # text (default) | json | ndjson
    summary: result            # last-paragraph (default) | all | an expression
    success: "!is_error"       # exit-code (default) | an expression
    usage: { input: usage.input_tokens, output: usage.output_tokens, cost: total_cost_usd }
    models: [claude, models]   # optional: a command that prints one model id per line
```

- **Placeholders:** `{{task}}`, `{{model}}` and `{{cwd}}` are filled in. A `--flag {{model}}` pair is dropped when no model is set.
- **json output:** the parsed object is the scope for `summary`, `success` and `usage`.
- **ndjson output:** the scope has `lines` (every object) and `last`.
- **Always available:** every expression can also use `exit_code`, `stdout` and `stderr`.

## Check an agent: `yxu agent test`

```sh
yxu agent test aider                 # a tiny task in a scratch repo
yxu agent test aider --task "…"      # your own task
yxu agent capture aider --out dir/   # the same, saving raw stdout/stderr/events for a bug report
```

It prints the command, live events, how yxu read the run (success, summary, files, diff,
tokens, cost) and a verdict. When something is off, it says what: for example, the file wasn't
created in the worktree, no summary was found, or the run was read as failed although it worked.

## Permissions

| `permission` | the agent may |
|---|---|
| `accept-edits` (default) | read and edit files; anything else needs a yes |
| `plan` | read only |
| `yolo` | anything, without asking (opt in per agent; `yxu doctor` warns) |

**Built-in and generic CLIs** apply this themselves:
- yxu passes the matching flag, e.g. `--permission-mode`, or `--auto` only for `yolo`.
- In accept-edits they usually refuse shell commands, because nobody can answer their prompt.

**ACP agents ask yxu.** When a tool isn't covered:
- In the interface, an approval box offers `[y]` allow once, `[a]` allow for this session, or `[n]` deny. Questions from parallel agents queue up.
- In `yxu run` you get a terminal prompt.
- With nobody to ask (CI, `yxu mcp`), the tool is refused.

Rules skip the question:

```yaml
    allow: ["execute:npm test*", "execute:python3 -m pytest*"]   # "kind" or "kind:glob"
    deny:  ["execute:git push*", "fetch"]
```

- **Kinds:** read, edit, delete, move, search, execute, think, fetch, other.
- **Globs never match across `;`, `&&`, `|`, `$( )` or redirects,** so `execute:npm test*` does not approve `npm test && curl … | sh`.

## Sandbox (Linux)

```yaml
    sandbox: bwrap
    sandbox_writable: ["~/.my-agent-state"]   # extra paths, if the agent needs them
```

With bubblewrap, the agent sees the system read-only. It can write only to:
- its worktree
- that worktree's git metadata
- a private `/tmp`
- its own state folders, which yxu knows for opencode, claude, cmd, gemini, aider, codex, goose, npx and bunx

Your checkout, other worktrees and `.git/hooks` are out of reach. The network stays open,
because agents need their model APIs. macOS support is planned; `yxu doctor` reports when bwrap
is missing.

Even without the sandbox, yxu compares your checkout before and after each task. If an agent
wrote outside its worktree, the result carries a warning that names the files.

## Trusting a repository

A repo's own config can name commands to run:
- hooks
- verify and shell steps
- ACP/generic agent commands
- shell slash commands
- `yolo` permissions

None of that runs until you trust the repo once: `yxu trust` (or `/trust`). In an untrusted repo:
- the interface lists what is waiting;
- `yolo` agents run as accept-edits;
- everything else works normally.

Your own files in `~/.config/yxu` are always trusted. `yxu init` trusts the repo it sets up, and
CI can set `YXU_TRUST=1`. `yxu trust --list` and `yxu trust --revoke` manage the list.

## Tested so far

| agent | how | status |
|---|---|---|
| OpenCode | `cli: opencode`, ACP (`opencode acp`), generic text | real tasks pass `yxu agent test` |
| Claude Code | `cli: claude`, generic JSON, ACP (`claude-agent-acp`) | real tasks pass; ACP approvals tested in the interface |
| Command Code | `cli: commandcode` | worked before; not re-run in this phase (account usage limit) |
| Gemini CLI | ACP (`--experimental-acp`) | handshake works; a full task needs a Gemini login |
| aider | generic (recipe above) | not run yet; needs a model API key |
