# rust starter pack

Rust projects: cargo test as the verify command, Rust conventions for agents, /rust:add-tests and /rust:lint (clippy).

```sh
yxu add rust            # into this repo (.yxu/packs/rust, pinned in yxu.lock)
yxu add rust --user     # for every repo
```

| adds | what |
|---|---|
| `settings.verify` | `cargo test --quiet` |
| prompt | rust conventions appended to every subagent task |
| workflow `rust:add-tests` | write tests for a target, then verify and fix |
| `/rust:add-tests <target>` | runs that workflow |
| `/rust:lint` | cargo clippy (warnings are errors) and cargo fmt --check |

Everything can be overridden in your yxu.yaml. The workflow uses `agent: default`: set
`settings.default_agent` to choose which agent, otherwise your first agent is used.
