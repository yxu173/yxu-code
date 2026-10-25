---
mode: append
---
This is a Rust project.
- Match the existing style; the code must pass `cargo fmt` and `cargo clippy` without new warnings.
- No `unwrap()` or `expect()` in library code paths that can fail; return errors with the error types the crate already uses.
- Unit tests go in a `#[cfg(test)] mod tests` in the same file; integration tests in tests/.
- Don't add crates unless the task asks for it.
