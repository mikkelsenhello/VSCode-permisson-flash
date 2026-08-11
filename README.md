# Claude Permission Flash

Flashes VS Code's title bar / status bar / activity bar to a bold color whenever
Claude Code (running in this Mac) is blocked on a permission prompt, and reverts
to normal once it's resolved — so you notice it from across the room without sound.

It also gives a **task-done pulse**: a few short, self-clearing flashes in a
different color when a longer-running turn finishes, so "needs you" and
"finished, FYI" are never confused at a glance. See [Task-done pulse](#task-done-pulse)
below.

## How it works

1. A Claude Code hook (`hooks/permission-flag.sh`, installed at
   `~/.claude/scripts/permission-flag.sh`) is wired into the `PermissionRequest`, `Notification`,
   `PreToolUse`, `PostToolUse`, `Stop`, and `UserPromptSubmit` events in
   `~/.claude/settings.json`.
2. When `PermissionRequest` fires (or `Notification` fires with
   `notification_type: permission_prompt`), the script writes a flag file to
   `~/.claude/notification-plugin/flags/<session_id>.flag`.
   **`PermissionRequest` is the one that actually matters**: live testing
   confirmed `Notification` never fires from the VS Code graphical panel
   (only from the terminal CLI, as of Claude Code 2.1.202) — `PermissionRequest`
   is kept in as well since it's what's actually driving the flash today.
3. Any other event for that session deletes the flag file — those events only
   fire once the prompt has been resolved (allowed, denied, or the turn ended).
4. Each flag file also carries the Claude Code session's `cwd`. The VS Code
   extension (running independently in every open window) checks whether
   that `cwd` matches its own workspace folder:
   - **The window that owns the prompt** flashes — by default a smooth
     300ms-each-direction fade between `activeColor` and normal (or a hard
     blink if `animateFlash` is off) — so you can spot exactly which window
     needs you.
   - **Every other window** shows a steady `activeColor` — something is
     pending somewhere, but not here.
   - Click the status bar notification to silence the flash for that prompt
     (the window drops to the same steady look as other windows) without
     affecting the actual permission request — it resumes flashing on the
     next prompt.
   - Once no flags remain anywhere, everything reverts to normal.

## Two-tier coloring, and its one side effect

The steady "something's pending" color is a **User-level** VS Code setting,
shared by every window — that part works exactly as before.

The blink, however, has to be **window-specific**, and VS Code only supports
per-window `workbench.colorCustomizations` via **Workspace-level** settings —
which live in that project's `.vscode/settings.json`. So: while a prompt is
blinking in a given project, this extension is rapidly toggling a
`workbench.colorCustomizations` key in that project's `.vscode/settings.json`,
and clears it again once the prompt resolves. At rest you shouldn't see any
diff, but if your editor/git status happens to catch it mid-blink, that's
why. If this bothers you in a given repo, add `.vscode/settings.json` to that
repo's `.gitignore`.

If a window has no folder open (an empty/untitled window), there's nowhere to
write a workspace-level setting, so that window can't blink — it'll just show
the steady color like any other "other" window.

## Task-done pulse

Separately from the permission flash, the hook script brackets each turn with
`UserPromptSubmit` (start) and `Stop` (end). If a turn took at least
`DONE_THRESHOLD_SECONDS` (20s, a constant in the script — edit it there if you
want a different cutoff) — i.e. it looks like an actual task rather than a
quick reply — `Stop` writes a one-shot `<session_id>.done.flag`.

The extension picks that up and pulses the owning window's chrome
`donePulseCount` (fixed at 3) times, in `doneColor` — a different color than
the permission `activeColor` by default — then clears itself automatically.
Unlike the permission blink, this doesn't wait for acknowledgment and doesn't
show a steady "somewhere else" state on other windows: it's a one-time FYI,
not an ongoing thing to resolve. If the window is mid permission-flash when a
done flag arrives, the pulse is skipped for that flag (the more urgent signal
wins) and retried once the flash resolves.

Try it with **Claude Permission Flash: Test Done Flash** from the Command
Palette — it pulses immediately, bypassing the duration check.

## Install (unpacked, for personal use)

```bash
cd "/Users/mikkelsen/Documents/Claude/Projects/Notification plugin"
npm install
npm run compile
npx @vscode/vsce package
```

Then in VS Code: Extensions view → `...` menu → **Install from VSIX...** → pick
the generated `.vsix`.

(Alternatively, for active development, open this folder in VS Code and press
`F5` to launch an Extension Development Host with it loaded — no packaging
needed.)

## Try it

Run **Claude Permission Flash: Test Flash (3s)** from the Command Palette —
this window should blink for 5 seconds (it targets its own workspace folder).
Open a second window on a different folder first and run it again to see the
first window stay steady while the second one blinks.

Then trigger a real one: ask Claude Code to run a command it doesn't have
standing permission for, and don't respond immediately.

## Settings

All under `claudePermissionFlash.*` in VS Code settings:

- `activeColor` (default `#3B5239`) / `textColor` (default `#f0f0f0`) — the flash color, used both for the steady "other window" look and the "on" end of the flash.
- `animateFlash` (default `true`) — fade the owning window's colors smoothly between `activeColor` and normal (300ms each direction) instead of hard-blinking. Disable to fall back to the old on/off blink.
- `blinkIntervalMs` (default `450`) — how fast the owning window blinks. Only used when `animateFlash` is off.
- `doneColor` (default `#2C5F8A`) / `doneTextColor` (default `#f0f0f0`) — the color used for the task-done pulse (see [Task-done pulse](#task-done-pulse)). Deliberately different from `activeColor` by default.
- `tintEditorTabs` — also tint the editor tab bar for extra visibility.
- `flagDirectory` — must match the hook script's `FLAG_DIR` if you change one.
- `pollIntervalMs` — fallback poll interval in case native file-watching misses an event.

Commands:
- **Acknowledge (Stop Flash for This Window)** — also bound to clicking the status bar item; stops the flash for the currently pending prompt in this window without resolving the actual permission request.
- **Clear All Active Flags** — force-clear if a flag ever gets stuck (e.g. Claude Code was killed mid-prompt).
- **Reset Baseline Colors to Current** — re-capture your current `workbench.colorCustomizations` as "normal", useful if you change your theme colors later.
- **Test Done Flash** — pulses the task-done color immediately, bypassing the duration check.

### A caveat on the animated fade

VS Code gives extensions no API to read a theme's actual rendered chrome
colors — only whatever you've explicitly set via
`workbench.colorCustomizations`. So the "normal" end of the fade is: your
baseline's own color for a given bar if you'd customized it, otherwise a
generic dark (`#3c3c3c`/`#cccccc`) or light (`#dddddd`/`#333333`) stand-in
picked from your theme's light/dark kind. For most themes this looks right
since chrome colors tend to hug near-black/near-white regardless of the
editor's syntax palette, but it won't exactly match every custom theme's true
title bar color. It also writes to this project's `.vscode/settings.json`
roughly 15x/sec while flashing (vs. ~2x/sec for the old hard blink) — more
git-status/file-watcher churn than before; disable `animateFlash` if that's a
problem for you in a given repo.

## If you edit the hook script

The live copy lives at `~/.claude/scripts/permission-flag.sh`. After editing
`hooks/permission-flag.sh` here, redeploy it:

```bash
cp hooks/permission-flag.sh ~/.claude/scripts/permission-flag.sh
```

## Multiple sessions/windows

Flags are per Claude Code `session_id`, so multiple concurrent sessions each
get their own flag file. Window-to-prompt matching is done by comparing the
flag's `cwd` against each window's open workspace folder(s) — see "How it
works" above for what that means for which window blinks vs. stays steady.
