---
mode: append
---
This is a Go project.
- Code must be gofmt-formatted and pass `go vet`.
- Handle every error; wrap with fmt.Errorf("...: %w", err) when adding context. No panics in library code.
- Tests are table-driven, in <name>_test.go next to the code, using the standard testing package unless the project already uses another.
- Don't add modules unless the task asks for it.
