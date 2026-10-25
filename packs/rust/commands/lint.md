---
description: cargo clippy (warnings are errors) and cargo fmt --check
kind: shell
---
cargo clippy --all-targets --quiet -- -D warnings && cargo fmt --check
