#!/bin/bash
# Claude Code hook: tracks pending permission prompts, and completed tasks,
# as flag files so the "Claude Permission Flash" VS Code extension can watch
# for them.
#
# Wire this into every event listed in the README's settings.json snippet.
# PermissionRequest is the one that actually fires in the VS Code graphical
# panel (Notification does not, as of Claude Code 2.1.202 — confirmed via
# live testing). Both are wired in for terminal-CLI compatibility. On either
# one, this writes a *.flag file for the session; every other event removes
# it, since those only fire once the prompt has been resolved one way or
# another.
#
# Separately, UserPromptSubmit/Stop bracket a turn so we can tell a quick
# interactive reply from a longer task: if a turn ran at least
# DONE_THRESHOLD_SECONDS, Stop writes a one-shot *.done.flag so the
# extension can pulse a distinct "finished" color instead of the permission
# blink. Short turns don't write one — otherwise every reply would pulse.

set -euo pipefail

FLAG_DIR="$HOME/.claude/notification-plugin/flags"
STARTS_DIR="$FLAG_DIR/.starts"
mkdir -p "$FLAG_DIR" "$STARTS_DIR"

DONE_THRESHOLD_SECONDS=20

input="$(cat)"

event="$(jq -r '.hook_event_name // empty' <<<"$input")"
notification_type="$(jq -r '.notification_type // empty' <<<"$input")"
tool_name="$(jq -r '.tool_name // empty' <<<"$input")"
session_id="$(jq -r '.session_id // "default"' <<<"$input")"
cwd="$(jq -r '.cwd // empty' <<<"$input")"

flag_file="$FLAG_DIR/$session_id.flag"
done_flag_file="$FLAG_DIR/$session_id.done.flag"
start_file="$STARTS_DIR/$session_id.start"

# cwd is included so the VS Code extension can tell which open window this
# prompt (or completed task) belongs to (its workspace folder) vs. every
# other window.
case "$event" in
  PermissionRequest)
    jq -n --arg message "Claude needs your permission to use ${tool_name:-a tool}" \
          --arg cwd "$cwd" --arg tool "$tool_name" --arg session "$session_id" \
          '{message: $message, cwd: $cwd, tool: $tool, session_id: $session}' > "$flag_file"
    ;;
  Notification)
    if [ "$notification_type" = "permission_prompt" ]; then
      message="$(jq -r '.message // "Claude needs your permission"' <<<"$input")"
      jq -n --arg message "$message" --arg cwd "$cwd" --arg session "$session_id" \
            '{message: $message, cwd: $cwd, session_id: $session}' > "$flag_file"
    fi
    ;;
  UserPromptSubmit)
    date +%s > "$start_file"
    rm -f "$flag_file"
    ;;
  Stop)
    rm -f "$flag_file"
    if [ -f "$start_file" ]; then
      started="$(cat "$start_file" 2>/dev/null || echo "")"
      rm -f "$start_file"
      if [[ "$started" =~ ^[0-9]+$ ]]; then
        elapsed=$(( $(date +%s) - started ))
        if [ "$elapsed" -ge "$DONE_THRESHOLD_SECONDS" ]; then
          jq -n --arg message "Claude finished a task (${elapsed}s)" \
                --arg cwd "$cwd" --arg session "$session_id" \
                '{type: "done", message: $message, cwd: $cwd, session_id: $session}' > "$done_flag_file"
        fi
      fi
    fi
    ;;
  *)
    rm -f "$flag_file"
    ;;
esac
