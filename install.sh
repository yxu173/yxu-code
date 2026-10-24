#!/bin/sh
# Install yxu from GitHub releases.
#   curl -fsSL https://raw.githubusercontent.com/yxu173/yxu-code/main/install.sh | sh
# Environment:
#   YXU_VERSION      tag to install, e.g. v0.1.0 (default: latest)
#   YXU_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#   YXU_DOWNLOAD_URL base URL holding the release assets (mirrors, testing)
set -eu

repo="yxu173/yxu-code"
dir="${YXU_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "yxu: unsupported OS $(uname -s). On Windows, run this inside WSL." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "yxu: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
# Rosetta: prefer the native arm64 build on Apple silicon.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

asset="yxu-$os-$arch.tar.gz"
if [ -n "${YXU_DOWNLOAD_URL:-}" ]; then
  base="$YXU_DOWNLOAD_URL"
elif [ -n "${YXU_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/$YXU_VERSION"
else
  base="https://github.com/$repo/releases/latest/download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "downloading $asset ${YXU_VERSION:-(latest)}"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"

expected=$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1); fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "yxu: checksum mismatch for $asset" >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/yxu" "$dir/yxu"
chmod +x "$dir/yxu"
echo "installed yxu $("$dir/yxu" --version) to $dir/yxu"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on your PATH; add it to your shell profile" ;;
esac
command -v claude >/dev/null 2>&1 || echo "note: yxu needs Claude Code (\`claude\`) installed and logged in: https://claude.com/claude-code"
echo "next: cd into a git repo and run \`yxu doctor\`, then \`yxu\`"
