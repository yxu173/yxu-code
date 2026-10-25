---
description: golangci-lint (or gofmt and go vet)
kind: shell
---
if command -v golangci-lint >/dev/null 2>&1; then golangci-lint run
else test -z "$(gofmt -l .)" || { gofmt -l .; echo "files above need gofmt"; exit 1; }; go vet ./...; fi
