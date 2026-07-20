#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

pi_home="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
log_path="$pi_home/logs/pi-focus-tmux.log"
tmux_bin="${TMUX_BIN:-/opt/homebrew/bin/tmux}"

session="${1:-}"
window_id="${2:-}"
pane_id="${3:-}"
window_index="${4:-}"

if [[ ! -x "$tmux_bin" ]]; then
  tmux_bin="$(command -v tmux || true)"
fi

log() {
  mkdir -p "$(dirname "$log_path")" 2>/dev/null || true
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$log_path" 2>/dev/null || true
}

log "args session=${session:-<empty>} window_id=${window_id:-<empty>} pane_id=${pane_id:-<empty>} window_index=${window_index:-<empty>}"

/usr/bin/osascript -e 'tell application id "com.mitchellh.ghostty" to activate' >/dev/null 2>&1 || true

if [[ -z "$tmux_bin" || ! -x "$tmux_bin" ]]; then
  log "abort no tmux executable"
  exit 0
fi

tmux_target_exists() {
  [[ -n "${1:-}" ]] && "$tmux_bin" display-message -p -t "$1" '#{session_name}' >/dev/null 2>&1
}

if tmux_target_exists "$pane_id"; then
  pane_window="$("$tmux_bin" display-message -p -t "$pane_id" '#{session_name}:#{window_index}' 2>/dev/null || true)"
  if [[ -n "$pane_window" ]]; then
    if "$tmux_bin" switch-client -t "$pane_window" 2>/dev/null; then
      log "switch-client pane_window=$pane_window ok"
    else
      log "switch-client pane_window=$pane_window failed"
    fi
  fi
  if "$tmux_bin" select-pane -t "$pane_id" 2>/dev/null; then
    log "select-pane pane_id=$pane_id ok"
  else
    log "select-pane pane_id=$pane_id failed"
  fi
  exit 0
fi

if tmux_target_exists "$window_id"; then
  window_target="$("$tmux_bin" display-message -p -t "$window_id" '#{session_name}:#{window_index}' 2>/dev/null || true)"
  if [[ -n "$window_target" ]]; then
    if "$tmux_bin" switch-client -t "$window_target" 2>/dev/null; then
      log "switch-client window_target=$window_target ok"
    else
      log "switch-client window_target=$window_target failed"
    fi
  fi
  exit 0
fi

if [[ -n "$session" && -n "$window_index" ]] && "$tmux_bin" has-session -t "${session}:${window_index}" 2>/dev/null; then
  if "$tmux_bin" switch-client -t "${session}:${window_index}" 2>/dev/null; then
    log "switch-client session_window=${session}:${window_index} ok"
  else
    log "switch-client session_window=${session}:${window_index} failed"
  fi
  exit 0
fi

if [[ -n "$session" ]] && "$tmux_bin" has-session -t "$session" 2>/dev/null; then
  if "$tmux_bin" switch-client -t "$session" 2>/dev/null; then
    log "switch-client session=$session ok"
  else
    log "switch-client session=$session failed"
  fi
  exit 0
fi

log "no matching tmux target"
