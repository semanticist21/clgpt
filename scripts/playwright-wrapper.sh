#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${1:?Playwright MCP package is required}"
shift
BUN_BIN="${CLGPT_BUN_BIN:-bun}"
TOKEN=""
if [ -n "${CLGPT_MCP_PREFS_PATH:-}" ] && [ -f "$CLGPT_MCP_PREFS_PATH" ]; then
  TOKEN="$("$BUN_BIN" -e 'const p=JSON.parse(await Bun.file(process.env.CLGPT_MCP_PREFS_PATH).text()); process.stdout.write(p.setup?.browserToken ?? "")')"
fi
if [ -n "$TOKEN" ]; then
  export PLAYWRIGHT_MCP_EXTENSION_TOKEN="$TOKEN"
fi
exec "$BUN_BIN" x -y "$PACKAGE" "$@"
