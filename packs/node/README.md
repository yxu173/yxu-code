# node starter pack

Node.js and TypeScript projects: the project's test script as the verify command (npm, pnpm, yarn or bun), conventions for agents, /node:add-tests and /node:lint.

```sh
yxu add node            # into this repo (.yxu/packs/node, pinned in yxu.lock)
yxu add node --user     # for every repo
```

| adds | what |
|---|---|
| `settings.verify` | `if [ -f pnpm-lock.yaml ]; then pnpm test; elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun run test; elif [ -f yarn.lock ]; then yarn test; else npm test; fi` |
| prompt | node conventions appended to every subagent task |
| workflow `node:add-tests` | write tests for a target, then verify and fix |
| `/node:add-tests <target>` | runs that workflow |
| `/node:lint` | Run the lint script (or tsc --noEmit) |

Everything can be overridden in your yxu.yaml. The workflow uses `agent: default`: set
`settings.default_agent` to choose which agent, otherwise your first agent is used.
