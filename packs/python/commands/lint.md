---
description: Lint with ruff (or flake8)
kind: shell
---
if command -v ruff >/dev/null 2>&1; then ruff check .
elif [ -f uv.lock ] && command -v uv >/dev/null 2>&1; then uv run ruff check .
elif command -v flake8 >/dev/null 2>&1; then flake8
else echo "no linter found: install ruff (pip install ruff)"; exit 1; fi
