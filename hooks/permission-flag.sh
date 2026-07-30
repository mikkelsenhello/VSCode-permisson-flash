#!/bin/bash
# Claude Code hook: tracks pending permission prompts as flag files so the
# "Claude Permission Flash" VS Code extension can watch for them.
#
# Wire this into every event listed in the README's settings.json snippet.
# PermissionRequest is the one that actually fires in the VS Code graphical
# panel (Notification does not, as of Claude Code 2.1.202 — confirmed via
# live testing). Both are wired in for terminal-CLI compatibility. On either
# one, this writes a flag file for the session; every other event removes
# it, since those only fire once the prompt has been resolved one way or
# another.

set -euo pipefail

FLAG_DIR="$HOME/.claude/notification-plugin/flags"
mkdir -p "$FLAG_DIR"

input="$(cat)"

event="$(jq -r '.hook_event_name // empty' <<<"$input")"
notification_type="$(jq -r '.notification_type // empty' <<<"$input")"
tool_name="$(jq -r '.tool_name // empty' <<<"$input")"
session_id="$(jq -r '.session_id // "default"' <<<"$input")"
cwd="$(jq -r '.cwd // empty' <<<"$input")"

flag_file="$FLAG_DIR/$session_id.flag"

# cwd is included so the VS Code extension can tell which open window this
# prompt belongs to (its workspace folder) vs. every other window.
if [ "$event" = "PermissionRequest" ]; then
  jq -n --arg message "Claude needs your permission to use ${tool_name:-a tool}" \
        --arg cwd "$cwd" --arg tool "$tool_name" --arg session "$session_id" \
        '{message: $message, cwd: $cwd, tool: $tool, session_id: $session}' > "$flag_file"
elif [ "$event" = "Notification" ] && [ "$notification_type" = "permission_prompt" ]; then
  message="$(jq -r '.message // "Claude needs your permission"' <<<"$input")"
  jq -n --arg message "$message" --arg cwd "$cwd" --arg session "$session_id" \
        '{message: $message, cwd: $cwd, session_id: $session}' > "$flag_file"
else
  rm -f "$flag_file"
fi
