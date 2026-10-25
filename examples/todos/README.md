# todos: an example pack with a plugin

Shows how a third-party plugin extends yxu:

- **a side-panel section**: the repo's open TODO/FIXME comments, refreshed every 30 seconds and after each task
- **`/todos:list`**: every open TODO, numbered
- **`/todos:fix [n]`**: hands TODO number *n* to the orchestrator as a goal

```sh
yxu add github:yxu173/yxu-code/examples/todos
```

The plugin is TypeScript code that runs inside yxu, so `yxu add` lists it and asks before
installing. Installing it into a repo approves it for you. Teammates who pull the repo approve it
once with `yxu plugins approve`. The code is in [plugins/todos.ts](plugins/todos.ts); the API is
described in [docs/PLUGINS.md](../../docs/PLUGINS.md).
