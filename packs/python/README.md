# python starter pack

Python projects: pytest as the verify command, Python conventions for agents, /python:add-tests and /python:lint.

```sh
yxu add python            # into this repo (.yxu/packs/python, pinned in yxu.lock)
yxu add python --user     # for every repo
```

| adds | what |
|---|---|
| `settings.verify` | `if [ -f uv.lock ]; then uv run pytest -q; elif [ -f poetry.lock ]; then poetry run pytest -q; else python3 -m pytest -q; fi` |
| prompt | python conventions appended to every subagent task |
| workflow `python:add-tests` | write tests for a target, then verify and fix |
| `/python:add-tests <target>` | runs that workflow |
| `/python:lint` | Lint with ruff (or flake8) |

Everything can be overridden in your yxu.yaml. The workflow uses `agent: default`: set
`settings.default_agent` to choose which agent, otherwise your first agent is used.
