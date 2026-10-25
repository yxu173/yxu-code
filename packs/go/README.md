# go starter pack

Go projects: go vet and go test as the verify command, Go conventions for agents, /go:add-tests and /go:lint.

```sh
yxu add go            # into this repo (.yxu/packs/go, pinned in yxu.lock)
yxu add go --user     # for every repo
```

| adds | what |
|---|---|
| `settings.verify` | `go vet ./... && go test ./...` |
| prompt | go conventions appended to every subagent task |
| workflow `go:add-tests` | write tests for a target, then verify and fix |
| `/go:add-tests <target>` | runs that workflow |
| `/go:lint` | golangci-lint (or gofmt and go vet) |

Everything can be overridden in your yxu.yaml. The workflow uses `agent: default`: set
`settings.default_agent` to choose which agent, otherwise your first agent is used.
