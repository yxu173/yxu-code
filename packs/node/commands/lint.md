---
description: Run the lint script (or tsc --noEmit)
kind: shell
---
pm=npm
if [ -f pnpm-lock.yaml ]; then pm=pnpm; elif [ -f bun.lock ] || [ -f bun.lockb ]; then pm=bun; elif [ -f yarn.lock ]; then pm=yarn; fi
if grep -q '"lint"' package.json; then $pm run lint
elif [ -f tsconfig.json ]; then npx --no-install tsc --noEmit
else echo "no lint script in package.json"; exit 1; fi
