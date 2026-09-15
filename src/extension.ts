import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Bumped to .v2: the original key was captured once, at first-ever
// activation, and trusted forever after that with no way to re-derive it.
// If that first capture ever happened while a flash/pulse was already
// applied (e.g. a leftover flag from a prior crash, or activating mid-test),
// the "normal" colors this extension restores to are permanently the flash
// color — no amount of clearing flags fixes that, since the code is
// correctly restoring to what it believes is baseline. Bumping the key
// forces one fresh, clean re-capture on next activation instead of trusting
// the old, possibly-poisoned snapshot.
const BASELINE_KEY = 'claudePermissionFlash.baselineColorCustomizations.v2';

interface FlagData {
  message?: string;
  cwd?: string;
  tool?: string;
  session_id?: string;
}

let isGlobalActive = false;
let isMineActive = false;
let blinkTimer: ReturnType<typeof setInterval> | undefined;
let blinkOn = false;
let watcher: fs.FSWatcher | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext;
let extensionDisposed = false;
const acknowledgedSessions = new Set<string>();

// Fixed per spec: a 300ms fade each direction. Not exposed as a setting.
const ANIMATION_LEG_MS = 300;
const ANIMATION_STEP_MS = 60;
let flashTimer: ReturnType<typeof setInterval> | undefined;
let flashT = 0;
let flashDirection: 1 | -1 = 1;
let flashWriteInFlight = false;

// Cooperative cancel flag for forceResetColors(): loops that write colors in
// a tight sequence (the done pulse) check this so they stop enqueueing new
// writes the moment a force-reset is requested, instead of racing it.
let forceStopRequested = false;

// Every write to workbench.colorCustomizations (workspace or global scope)
// goes through one of these two chains so writes always land in the order
// they were issued. Without this, two concurrent `config().update(...)`
// calls (e.g. an in-flight animation frame and a "stop flashing, clear the
// color" call) can resolve out of call order, and whichever one happens to
// finish last wins — which is how the chrome color gets stuck on a color
// the extension itself believes it already cleared.
function makeSerializer() {
  let chain: Promise<void> = Promise.resolve();
  return function run(fn: () => Promise<void>): Promise<void> {
    const result = chain.then(fn, fn);
    chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

const runWorkspaceWrite = makeSerializer();
const runGlobalWrite = makeSerializer();

// "Task done" pulse: a short, finite, self-clearing animation — distinct in
// both color and shape from the permission blink/fade, which is sustained
// until the prompt resolves or is acknowledged. Fixed per spec, like the
// permission fade's timing above; not exposed as settings.
const DONE_PULSE_LEG_MS = 220;
const DONE_PULSE_STEP_MS = 40;
const DONE_PULSE_COUNT = 2;
let donePulseInFlight = false;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function config() {
  return vscode.workspace.getConfiguration('claudePermissionFlash');
}

function getFlagDir(): string {
  return expandHome(config().get<string>('flagDirectory', '~/.claude/notification-plugin/flags'));
}

// A flag file can be orphaned forever if its Claude Code session ends
// abruptly (crash, closed window) between writing it and whatever event
// would normally clear it — leaving the flash stuck on in every window.
// Purge anything older than staleFlagMinutes so that can't happen.
function isStaleFlag(dir: string, file: string): boolean {
  const maxAgeMs = config().get<number>('staleFlagMinutes', 15) * 60 * 1000;
  try {
    return Date.now() - fs.statSync(path.join(dir, file)).mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

function listFlagFiles(dir: string): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.flag'));
  } catch {
    return [];
  }
  const fresh: string[] = [];
  for (const f of files) {
    if (isStaleFlag(dir, f)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // ignore
      }
    } else {
      fresh.push(f);
    }
  }
  return fresh;
}

// "Done" flags use a `.done.flag` suffix so they can be told apart from
// permission flags by filename alone — no need to trust file contents.
function partitionFlagFiles(files: string[]): { permission: string[]; done: string[] } {
  const done = files.filter((f) => f.endsWith('.done.flag'));
  const permission = files.filter((f) => !f.endsWith('.done.flag'));
  return { permission, done };
}

function readFlagsWithNames(dir: string, files: string[]): Array<{ file: string; data: FlagData }> {
  const result: Array<{ file: string; data: FlagData }> = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      if (!raw) continue;
      try {
        result.push({ file: f, data: JSON.parse(raw) });
      } catch {
        result.push({ file: f, data: { message: raw } }); // legacy plain-text flag format
      }
    } catch {
      // ignore
    }
  }
  return result;
}

function readFlags(dir: string, files: string[]): FlagData[] {
  return readFlagsWithNames(dir, files).map((r) => r.data);
}

// A flag "belongs" to this window when its cwd is this window's workspace
// folder, or a subdirectory of it — that's how we tell "my prompt" apart
// from "someone else's prompt in another window".
function isForThisWindow(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return false;
  const normalizedCwd = path.resolve(cwd);
  return folders.some((f) => {
    const folderPath = path.resolve(f.uri.fsPath);
    return normalizedCwd === folderPath || normalizedCwd.startsWith(folderPath + path.sep);
  });
}

function getBaseline(): Record<string, unknown> {
  return extensionContext.globalState.get<Record<string, unknown>>(BASELINE_KEY, {});
}

async function ensureBaselineCaptured() {
  if (extensionContext.globalState.get(BASELINE_KEY) === undefined) {
    const current = vscode.workspace.getConfiguration().get<Record<string, unknown>>('workbench.colorCustomizations') || {};
    await extensionContext.globalState.update(BASELINE_KEY, current);
  }
}

function buildCustomizationsFor(color: string, textColor: string, tintTabs: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...getBaseline(),
    'titleBar.activeBackground': color,
    'titleBar.activeForeground': textColor,
    'titleBar.inactiveBackground': color,
    'titleBar.inactiveForeground': textColor,
    'statusBar.background': color,
    'statusBar.foreground': textColor,
    'activityBar.background': color,
    'activityBar.foreground': textColor,
  };
  if (tintTabs) {
    next['editorGroupHeader.tabsBackground'] = color;
  }
  return next;
}

function buildActiveCustomizations(): Record<string, unknown> {
  const color = config().get<string>('activeColor', '#3B5239');
  const textColor = config().get<string>('textColor', '#f0f0f0');
  const tintTabs = config().get<boolean>('tintEditorTabs', false);
  return buildCustomizationsFor(color, textColor, tintTabs);
}

// Global (User-level) customization is shared by every VS Code window on
// this machine — this is the steady "something's pending somewhere" look
// seen by windows that are NOT the one with the actual prompt.
async function applyGlobalActiveColor() {
  await runGlobalWrite(async () => {
    await vscode.workspace
      .getConfiguration()
      .update('workbench.colorCustomizations', buildActiveCustomizations(), vscode.ConfigurationTarget.Global);
  });
}

async function restoreGlobalBaseline() {
  await runGlobalWrite(async () => {
    await vscode.workspace
      .getConfiguration()
      .update('workbench.colorCustomizations', getBaseline(), vscode.ConfigurationTarget.Global);
  });
}

function canUseWorkspaceScope(): boolean {
  return !!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
}

// Workspace-level customization only affects THIS window (it's written to
// this project's .vscode/settings.json), which is what lets the owning
// window blink independently of every other open window.
async function setWorkspaceOverride(value: Record<string, unknown> | undefined) {
  if (!canUseWorkspaceScope()) return;
  await runWorkspaceWrite(async () => {
    try {
      await vscode.workspace
        .getConfiguration()
        .update('workbench.colorCustomizations', value, vscode.ConfigurationTarget.Workspace);
    } catch {
      // no writable workspace settings (e.g. an untitled/folderless window) —
      // this window just keeps showing the steady global color instead.
    }
  });
}

async function blinkTick() {
  blinkOn = !blinkOn;
  if (blinkOn) {
    // clear the override so the window falls through to the global active color
    await setWorkspaceOverride(undefined);
  } else {
    // force this window back to normal, out of sync with the global color — the blink
    await setWorkspaceOverride(getBaseline());
  }
}

function startBlinking() {
  stopBlinking();
  blinkOn = false;
  void blinkTick();
  const interval = config().get<number>('blinkIntervalMs', 450);
  blinkTimer = setInterval(() => void blinkTick(), interval);
}

function stopBlinking() {
  if (blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = undefined;
  }
}

// VS Code gives extensions no way to read the theme's actually-rendered chrome
// colors, so when the baseline has no explicit override for a key we fade
// towards a plausible dark/light stand-in for "normal" instead of the real
// theme color, which is unknowable here.
function themeDefaultColors(): { bg: string; fg: string } {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) {
    return { bg: '#dddddd', fg: '#333333' };
  }
  return { bg: '#3c3c3c', fg: '#cccccc' };
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').slice(0, 6).padEnd(6, '0');
  const normalized = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const bigint = parseInt(normalized, 16);
  return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const toHex = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function lerpColor(fromHex: string, toHex: string, t: number): string {
  const a = hexToRgb(fromHex);
  const b = hexToRgb(toHex);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

// The "off" end of the fade: baseline's own color for a key when the user
// already customized it, otherwise the theme-default stand-in above.
function buildAnimationEndColors(): Record<string, string> {
  const baseline = getBaseline();
  const tintTabs = config().get<boolean>('tintEditorTabs', false);
  const { bg, fg } = themeDefaultColors();
  const keys: Record<string, 'bg' | 'fg'> = {
    'titleBar.activeBackground': 'bg',
    'titleBar.activeForeground': 'fg',
    'titleBar.inactiveBackground': 'bg',
    'titleBar.inactiveForeground': 'fg',
    'statusBar.background': 'bg',
    'statusBar.foreground': 'fg',
    'activityBar.background': 'bg',
    'activityBar.foreground': 'fg',
  };
  if (tintTabs) keys['editorGroupHeader.tabsBackground'] = 'bg';

  const result: Record<string, string> = {};
  for (const [key, kind] of Object.entries(keys)) {
    const existing = baseline[key];
    result[key] = typeof existing === 'string' ? existing : kind === 'bg' ? bg : fg;
  }
  return result;
}

async function animationTick() {
  if (flashWriteInFlight) return; // previous write still landing — catch up next tick rather than overlap
  flashT += flashDirection * (ANIMATION_STEP_MS / ANIMATION_LEG_MS);
  if (flashT >= 1) {
    flashT = 1;
    flashDirection = -1;
  } else if (flashT <= 0) {
    flashT = 0;
    flashDirection = 1;
  }

  const active = buildActiveCustomizations();
  const end = buildAnimationEndColors();
  const mixed: Record<string, unknown> = { ...getBaseline() };
  for (const key of Object.keys(end)) {
    const from = active[key] as string;
    mixed[key] = lerpColor(from, end[key], flashT);
  }

  flashWriteInFlight = true;
  try {
    await setWorkspaceOverride(mixed);
  } finally {
    flashWriteInFlight = false;
  }
}

function startAnimating() {
  stopAnimating();
  flashT = 0;
  flashDirection = 1;
  void animationTick();
  flashTimer = setInterval(() => void animationTick(), ANIMATION_STEP_MS);
}

function stopAnimating() {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = undefined;
  }
}

function startFlashing() {
  if (config().get<boolean>('animateFlash', true)) {
    stopBlinking();
    startAnimating();
  } else {
    stopAnimating();
    startBlinking();
  }
}

function stopFlashing() {
  stopBlinking();
  stopAnimating();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A short, finite pulse for "task done" — distinct from the permission
// blink/fade both in color and in shape: it runs a fixed number of times
// and clears itself, rather than continuing until acknowledged.
async function runDonePulse() {
  if (!canUseWorkspaceScope() || isMineActive) return;

  const color = config().get<string>('doneColor', '#2C5F8A');
  const textColor = config().get<string>('doneTextColor', '#f0f0f0');
  const tintTabs = config().get<boolean>('tintEditorTabs', false);
  const active = buildCustomizationsFor(color, textColor, tintTabs);
  const end = buildAnimationEndColors();
  const steps = Math.max(1, Math.round(DONE_PULSE_LEG_MS / DONE_PULSE_STEP_MS));

  donePulseInFlight = true;
  try {
    for (let pulse = 0; pulse < DONE_PULSE_COUNT && !extensionDisposed && !isMineActive && !forceStopRequested; pulse++) {
      for (const dir of [1, -1] as const) {
        for (let s = 1; s <= steps; s++) {
          if (extensionDisposed || isMineActive || forceStopRequested) break;
          const t = dir === 1 ? s / steps : 1 - s / steps;
          const mixed: Record<string, unknown> = { ...getBaseline() };
          for (const key of Object.keys(end)) {
            mixed[key] = lerpColor(end[key], active[key] as string, t);
          }
          await setWorkspaceOverride(mixed);
          await sleep(DONE_PULSE_STEP_MS);
        }
      }
    }
  } finally {
    donePulseInFlight = false;
    // Skip the clear here if a force-reset is in progress — it already
    // issues its own (later-queued) clear, and this one would just be an
    // extra redundant write racing behind it.
    if (!isMineActive && !forceStopRequested) {
      await setWorkspaceOverride(undefined);
    }
  }
}

// Done flags are one-shot: claim (delete) the ones belonging to this window
// and pulse once for the batch, rather than once per flag. Skip entirely
// while a permission flash owns this window's chrome — the flags are left
// on disk and retried on the next refresh once that resolves.
async function processDoneFlags(dir: string, doneFileNames: string[]) {
  if (doneFileNames.length === 0 || donePulseInFlight || isMineActive) return;
  const mine = readFlagsWithNames(dir, doneFileNames).filter((d) => isForThisWindow(d.data.cwd));
  if (mine.length === 0) return;
  for (const d of mine) {
    try {
      fs.unlinkSync(path.join(dir, d.file));
    } catch {
      // ignore
    }
  }
  await runDonePulse();
}

async function refresh() {
  const dir = getFlagDir();
  const { permission: files, done: doneFiles } = partitionFlagFiles(listFlagFiles(dir));
  const flags = readFlags(dir, files);

  // Drop acknowledgments for sessions whose flag is gone (prompt resolved) so
  // the set doesn't grow forever and a reused session_id doesn't stay silenced.
  const currentSessionIds = new Set(flags.map((f) => f.session_id).filter((id): id is string => !!id));
  for (const id of Array.from(acknowledgedSessions)) {
    if (!currentSessionIds.has(id)) acknowledgedSessions.delete(id);
  }

  const rawMine = flags.find((f) => isForThisWindow(f.cwd));
  const acknowledged = !!rawMine?.session_id && acknowledgedSessions.has(rawMine.session_id);
  const mine = acknowledged ? undefined : rawMine;
  const globalActive = flags.length > 0;

  if (statusBarItem) {
    if (flags.length > 0) {
      const display = rawMine ?? flags[0];
      statusBarItem.text = rawMine
        ? mine
          ? '$(bell-dot) Claude needs permission — this window'
          : '$(bell) Claude needs permission — this window (acknowledged)'
        : '$(bell-dot) Claude waiting for permission elsewhere';
      statusBarItem.tooltip =
        (display.message ?? 'Claude needs your permission') +
        (rawMine ? ' — click to stop the flash until it resolves' : '');
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  }

  if (globalActive !== isGlobalActive) {
    isGlobalActive = globalActive;
    if (globalActive) {
      await applyGlobalActiveColor();
    } else {
      await restoreGlobalBaseline();
    }
  }

  const mineActive = !!mine;
  if (mineActive !== isMineActive) {
    isMineActive = mineActive;
    if (mineActive) {
      startFlashing();
    } else {
      stopFlashing();
      await setWorkspaceOverride(undefined);
    }
  }

  await processDoneFlags(dir, doneFiles);
}

// Unconditionally puts both scopes' chrome colors back to baseline, ignoring
// what refresh()'s isMineActive/isGlobalActive bookkeeping currently
// believes. refresh() only ever writes colors on a state *transition*, so if
// a color ever got stuck out of sync with that bookkeeping (e.g. a past
// write race), simply deleting flags and calling refresh() again does
// nothing — this is the actual "un-stick it" escape hatch.
async function forceResetColors(): Promise<void> {
  stopFlashing();
  forceStopRequested = true;
  isGlobalActive = false;
  isMineActive = false;
  try {
    await Promise.all([setWorkspaceOverride(undefined), restoreGlobalBaseline()]);
  } finally {
    forceStopRequested = false;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  await ensureBaselineCaptured();

  const dir = getFlagDir();
  fs.mkdirSync(dir, { recursive: true });

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBarItem.command = 'claudePermissionFlash.acknowledge';
  context.subscriptions.push(statusBarItem);

  await refresh();

  try {
    watcher = fs.watch(dir, { persistent: false }, () => {
      void refresh();
    });
  } catch {
    // native watching unavailable; polling below still covers us
  }

  pollTimer = setInterval(() => void refresh(), config().get<number>('pollIntervalMs', 1000));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudePermissionFlash.flagDirectory')) {
        watcher?.close();
        const newDir = getFlagDir();
        fs.mkdirSync(newDir, { recursive: true });
        try {
          watcher = fs.watch(newDir, { persistent: false }, () => void refresh());
        } catch {
          // ignore
        }
        void refresh();
      }
      if (e.affectsConfiguration('claudePermissionFlash.pollIntervalMs')) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => void refresh(), config().get<number>('pollIntervalMs', 1000));
      }
      if (e.affectsConfiguration('claudePermissionFlash.blinkIntervalMs') && isMineActive && !config().get<boolean>('animateFlash', true)) {
        startBlinking();
      }
      if (e.affectsConfiguration('claudePermissionFlash.animateFlash') && isMineActive) {
        startFlashing();
      }
      if (
        isGlobalActive &&
        (e.affectsConfiguration('claudePermissionFlash.activeColor') ||
          e.affectsConfiguration('claudePermissionFlash.textColor') ||
          e.affectsConfiguration('claudePermissionFlash.tintEditorTabs'))
      ) {
        void applyGlobalActiveColor();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePermissionFlash.testFlash', async () => {
      const targetCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const testFlag = path.join(getFlagDir(), '__test__.flag');
      fs.writeFileSync(
        testFlag,
        JSON.stringify({
          message: 'Test flash — this will clear itself in 5 seconds.',
          cwd: targetCwd,
        })
      );
      await refresh();
      setTimeout(() => {
        try {
          fs.unlinkSync(testFlag);
        } catch {
          // ignore
        }
        void refresh();
      }, 5000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePermissionFlash.testDoneFlash', async () => {
      const targetCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const testFlag = path.join(getFlagDir(), '__test__.done.flag');
      fs.writeFileSync(
        testFlag,
        JSON.stringify({
          type: 'done',
          message: 'Test done pulse.',
          cwd: targetCwd,
        })
      );
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePermissionFlash.acknowledge', async () => {
      const d = getFlagDir();
      const flags = readFlags(d, listFlagFiles(d));
      const mine = flags.find((f) => isForThisWindow(f.cwd));
      if (mine?.session_id) {
        acknowledgedSessions.add(mine.session_id);
      }
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePermissionFlash.clearAll', async () => {
      const d = getFlagDir();
      for (const f of listFlagFiles(d)) {
        try {
          fs.unlinkSync(path.join(d, f));
        } catch {
          // ignore
        }
      }
      // Force the colors back to baseline unconditionally, rather than
      // relying on refresh()'s transition detection — see forceResetColors().
      await forceResetColors();
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePermissionFlash.forceReset', async () => {
      await forceResetColors();
      await refresh();
      vscode.window.showInformationMessage('Claude Permission Flash: chrome colors force-reset to baseline.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePermissionFlash.resetBaseline', async () => {
      if (isMineActive || isGlobalActive) {
        vscode.window.showWarningMessage(
          'Claude Permission Flash: a flash is currently active — resolve it (or run "Force Reset Colors") before setting a new baseline, otherwise the flash color gets baked in as "normal".'
        );
        return;
      }
      const current = vscode.workspace.getConfiguration().get<Record<string, unknown>>('workbench.colorCustomizations') || {};
      await extensionContext.globalState.update(BASELINE_KEY, current);
      vscode.window.showInformationMessage('Claude Permission Flash: current colors saved as the baseline to restore to.');
    })
  );

  context.subscriptions.push({
    dispose: () => {
      extensionDisposed = true;
      watcher?.close();
      if (pollTimer) clearInterval(pollTimer);
      stopFlashing();
      if (isMineActive) void setWorkspaceOverride(undefined);
      if (isGlobalActive) void restoreGlobalBaseline();
    },
  });
}

export async function deactivate() {
  extensionDisposed = true;
  stopFlashing();
  if (isMineActive) {
    await setWorkspaceOverride(undefined);
  }
  if (isGlobalActive) {
    await restoreGlobalBaseline();
  }
}
