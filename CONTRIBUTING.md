# Contributing to yxu

Thanks for helping. Bug reports, adapters for new agent CLIs, docs and fixes are all welcome.

## Setup

```sh
git clone https://github.com/yxu173/yxu-code && cd yxu-code
bun install            # Bun ≥ 1.3 (see .bun-version)
bun src/cli.ts --demo  # the interface with scripted data, no agents needed
```

## Before you open a pull request

```sh
bun run typecheck
bun test
bun run build && bun run smoke   # compiled binary + interface in a real PTY
```

CI runs the same checks on Linux and macOS.

- Keep presentation (`src/tui/`) separate from execution (`src/runner.ts`, `src/ops.ts`,
  `src/orchestrator/`). The interface must never show invented activity.
- Tests must not call real agent CLIs or the network. Use the fixtures in `test/fixtures/`
  (captured real outputs) and `test/helpers.ts`.
- When an agent CLI changes its output format, add a new fixture captured from the real CLI
  rather than editing an old one.
- Bun-specific APIs belong in `src/platform.ts`.
- Match the surrounding style: small modules, few comments, comments explain *why*.

## Reporting bugs

Use the bug report template and include the output of `yxu doctor`. For security issues, see
[SECURITY.md](SECURITY.md) instead.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
