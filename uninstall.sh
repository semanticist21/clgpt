#!/usr/bin/env bash
# clgpt uninstaller.
#   curl -fsSL https://raw.githubusercontent.com/semanticist21/clgpt/main/uninstall.sh | bash
#   ... --full   : also remove config and the OAuth credentials (~/.config/clgpt)
set -euo pipefail

CLGPT_DIR="${CLGPT_DIR:-$HOME/.local/share/clgpt}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

is_clgpt_install() {
  local dir="$1"
  [ -d "$dir/.git" ] || return 1
  grep -Eq '^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"clgpt"[[:space:]]*,?[[:space:]]*$' "$dir/package.json" || return 1
  local origin
  origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  [ "$origin" = "https://github.com/semanticist21/clgpt.git" ] ||
    [ "$origin" = "git@github.com:semanticist21/clgpt.git" ]
}

removed=0
if [ -e "$BIN_DIR/clgpt" ]; then
  [ -f "$BIN_DIR/clgpt" ] || fail "$BIN_DIR/clgpt is not a clgpt launcher file"
  grep -q 'clgpt launcher v' "$BIN_DIR/clgpt" || fail "$BIN_DIR/clgpt is not a clgpt launcher"
  rm -f "$BIN_DIR/clgpt"; log "Removed: $BIN_DIR/clgpt"; removed=1
fi
if [ -d "$CLGPT_DIR" ]; then
  is_clgpt_install "$CLGPT_DIR" \
    || fail "$CLGPT_DIR is not the canonical clgpt install - refusing to delete it"
  rm -rf "$CLGPT_DIR"; log "Removed: $CLGPT_DIR"; removed=1
fi
if [ -d "$CLGPT_DIR.previous" ]; then
  is_clgpt_install "$CLGPT_DIR.previous" \
    || fail "$CLGPT_DIR.previous is not the canonical clgpt rollback install - refusing to delete it"
  rm -rf "$CLGPT_DIR.previous"; log "Removed: $CLGPT_DIR.previous"; removed=1
fi
if [ -d "$CLGPT_DIR.update.lock" ]; then
  rmdir "$CLGPT_DIR.update.lock" \
    || fail "$CLGPT_DIR.update.lock is not empty - verify no update is running before removing it"
  log "Removed stale update lock: $CLGPT_DIR.update.lock"; removed=1
fi

if [ "${1:-}" = "--full" ]; then
  if [ -d "$HOME/.config/clgpt" ]; then
    rm -rf "$HOME/.config/clgpt"
    log "Removed: ~/.config/clgpt (including OAuth credentials)"
  fi
else
  [ -d "$HOME/.config/clgpt" ] && log "Kept config: ~/.config/clgpt (including OAuth credentials) - remove it with: $0 --full"
fi

[ "$removed" = "1" ] || [ "${1:-}" = "--full" ] || log "Nothing to remove"
log "Done"
