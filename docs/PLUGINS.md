# Plugins

When files aren't enough, a plugin adds behavior with code. A plugin is a TypeScript (or
JavaScript) module that can add:

- **commands**: `/<plugin>:<name>`, in the interface and in `yxu run "/<plugin>:<name> …"`
- **panel sections**: lines in the interface's side panel, refreshed after tasks or on a timer
- **hooks**: functions at before_run, after_task, before_apply, on_failure, on_complete
- **agents**: a new `cli:` kind, run by yxu like a built-in adapter (worktree, timeout, cancel, sandbox)
- **orchestrators**: a new `orchestrator.provider` that answers pipeline plan and review steps

```ts
// .yxu/plugins/hello.ts
import type { Plugin } from "yxu/plugin"; // types only (npm i -D yxu); erased at runtime

export default {
  name: "hello",
  apiVersion: 1,
  commands: [{ name: "greet", usage: "[name]", run: (ctx, [who = "you"]) => ctx.note(`hello, ${who}`) }],
  panel: [{ title: "hello", render: () => [new Date().toLocaleTimeString()], refresh: 5 }],
} satisfies Plugin;
```

[examples/todos](../examples/todos) is a complete example. It is a pack whose plugin shows the
repo's TODO comments in the panel, and `/todos:fix <n>` hands one to the orchestrator.

## Where plugins live, and trust

| location | loads |
|---|---|
| `~/.config/yxu/plugins/` | always (you put it there) |
| `~/.config/yxu/packs/<pack>/plugins/` | always (you installed the pack with `--user`) |
| `.yxu/plugins/` in a repo | once you approve it |
| `.yxu/packs/<pack>/plugins/` | once you approve it |

A plugin is `<name>.ts`, `.js` or `.mjs`, or a folder with an `index.ts` / `index.js`. A plugin
folder may have its own `node_modules`.

**Plugins run inside yxu with your permissions.** They are trusted code, so a plugin that
comes with a repo never loads just because you cloned the repo:

```sh
yxu plugins                 # every plugin found, its state, and what it adds
yxu plugins approve [name]  # load this repo's plugins (read them first)
yxu plugins revoke <name>
```

- **Approval is tied to the plugin's code.** yxu stores a hash of it in `~/.config/yxu/plugins.json`. If the code changes (a `git pull`, a pack update), the plugin stops loading until you approve it again.
- **Installing a pack approves its plugins for you.** `yxu add` names them and asks before installing.
- **In CI**, `YXU_TRUST=1` approves everything.
- **In the interface**, `/plugins` lists them and `/plugins approve` loads them. yxu also says at start when plugins are waiting.

A plugin that fails to load is reported by `yxu plugins`, `yxu doctor` and the interface, and is
skipped. Everything else keeps working.

## The API (version 1)

`apiVersion: 1` is required. A plugin asking for a newer API is refused with a hint to
`yxu update`. Within version 1, everything below stays compatible.

### Context

Every function gets a `ctx`:

| | |
|---|---|
| `ctx.plugin`, `ctx.root` | the plugin's name; the repo root (for after_task hooks, the task's worktree) |
| `ctx.config` | the effective config, read-only |
| `ctx.note(markdown)` | a note in the interface (printed by `yxu run`) |
| `ctx.run(goal, { workflow?, inputs? })` | start a run as if the user typed the goal; resolves with `{ ok, result }` when it ends |
| `ctx.shell(command, { cwd?, timeoutMs? })` | run a shell command; resolves with `{ code, stdout, stderr }` |
| `ctx.data.get(key)` / `ctx.data.set(key, value)` | small storage for the plugin, in `.yxu/plugin-data/<plugin>.json` |

### Commands

```ts
commands: [{ name: "ticket", usage: "<id>", description: "Start work from a ticket", run: async (ctx, [id]) => { … } }]
```

They appear in the `/` palette as `/<plugin>:<name>`, in `yxu commands`, and in
`yxu run "/<plugin>:<name> args"`. A thrown error shows as a fault.

### Panel sections

```ts
panel: [{ title: "ci", refresh: 30, render: async (ctx) => ["main: passing", "2 PRs open"] }]
```

- **Refresh:** `render` returns plain lines. yxu calls it at start, after each agent task, and every `refresh` seconds.
- **Position:** sections go after the built-in ones. List `"<plugin>:<title>"` in `ui.panel_sections` to put them elsewhere.

### Hooks

```ts
hooks: {
  before_run: (ctx, e) => e.goal.length < 2000,        // return false (or throw) to block
  after_task: async (ctx, e) => { await ctx.shell("npm run fmt"); },  // in the task's worktree; changes join the task
  on_complete: (ctx, e) => ctx.note(`done: ${e.result}`),
}
```

- **Data:** plugin hooks get the same data as shell hooks (see CUSTOMIZING.md) and run after them.
- **Blocking:** a `before_run` or `before_apply` hook that returns `false` or throws blocks the action. Errors in the other hooks become warnings.

### Agents

```ts
agents: [{
  cli: "my-agent",
  command: (task, profile) => ["my-agent", "--model", profile.model ?? "default", "--prompt", task.prompt],
  parse: (stdout, stderr, exitCode) => ({ events: [], result: { ok: exitCode === 0, summary: stdout.trim(), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }),
}]
```

```yaml
agents:
  mine: { cli: my-agent, model: big }
```

yxu runs the command in the task's worktree and reads the result with `parse`. Timeouts,
cancel, `sandbox: bwrap` and `yxu agent test mine` all work as for the built-in CLIs. An agent
whose plugin isn't loaded makes the config invalid, with a pointer to `yxu plugins`.

### Orchestrators

```ts
orchestrators: [{
  name: "local-llm",
  ask: async ({ system, prompt, schema, signal }) => {
    const value = await callMyModel(system, prompt, schema, signal); // must match `schema` (JSON Schema)
    return { value, costUsd: 0 };
  },
}]
```

```yaml
orchestrator:
  provider: local-llm
```

`ask` answers one structured question per pipeline `plan` or `review` step. yxu validates the
answer against the schema.

## Orchestrator providers

Pipelines don't need Claude. `orchestrator.provider` decides who answers their plan and review
steps:

| provider | who | notes |
|---|---|---|
| `claude` (default) | Claude Code via the Agent SDK | the only one for **auto** workflows (a conversation with tools) |
| `agent` | one of your agents, `orchestrator.agent` | runs read-only in a worktree at the work so far, answers with a JSON block; retried once if the answer doesn't fit |
| a plugin's name | the plugin's `ask` | e.g. an OpenAI-compatible model |

```yaml
orchestrator:
  provider: agent
  agent: oc              # e.g. OpenCode with a free model: no Claude account needed
```

An auto workflow with a provider other than `claude` stops with a clear message. Use a pipeline
such as `feature` instead.
