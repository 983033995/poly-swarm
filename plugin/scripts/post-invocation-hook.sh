#!/bin/sh
set -eu

pick_node() {
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "${HOME:-}/.local/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"
  do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 22 ] 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(pick_node || true)"
if [ -n "$NODE_BIN" ] && [ -f "./dist/hook.mjs" ]; then
  exec "$NODE_BIN" "./dist/hook.mjs"
fi

printf '{}\n'
exit 0
