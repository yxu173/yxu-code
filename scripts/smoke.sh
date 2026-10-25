#!/bin/sh
# Smoke-test a yxu binary: version, help, doctor, and the interface in a real PTY (--demo).
# usage: scripts/smoke.sh path/to/yxu
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "· version"; "$bin" --version
echo "· help"; "$bin" --help | head -3
# doctor exits non-zero when agent CLIs are missing (as on CI); it must still run.
echo "· doctor"; "$bin" doctor || true

echo "· interface (demo, real PTY)"
git -C "$work" init -q
cat > "$work/script.json" <<'EOF'
[{"until": "Describe a goal", "timeout": 20}, {"dump": "start"}, {"send": "/quit\r"}, {"wait": 1.5}]
EOF
out=$(python3 "$here/pty-drive.py" 100 30 "$work" "$work/script.json" -- "$bin" --demo)
echo "$out" | tail -4
echo "$out" | grep -q "until 'Describe a goal': found" || { echo "smoke: interface did not draw"; exit 1; }
echo "$out" | grep -q '"alt_off": 1' || { echo "smoke: terminal not restored"; exit 1; }
echo "$out" | grep -q 'exit_status 0' || { echo "smoke: non-zero exit"; exit 1; }
echo "smoke: ok"
