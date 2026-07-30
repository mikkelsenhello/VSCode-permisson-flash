import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BASELINE_KEY = 'claudePermissionFlash.baselineColorCustomizations';

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
const acknowledgedSessions = new Set<string>();

// Fixed per spec: a 300ms fade each direction. Not exposed as a setting.
const ANIMATION_LEG_MS = 300;
const ANIMATION_STEP_MS = 60;
let flashTimer: ReturnType<typeof setInterval> | undefined;
let flashT = 0;
let flashDirection: 1 | -1 = 1;
let flashWriteInFlight = false;

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

function listFlagFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.flag'));
  } catch {
    return [];
  }
}

function readFlags(dir: string, files: string[]): FlagData[] {
  const result: FlagData[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      if (!raw) continue;
      try {
        result.push(JSON.parse(raw));
      } catch {
        result.push({ message: raw }); // legacy plain-text flag format
      }
    } catch {
      // ignore
    }
  }
  return result;
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

function buildActiveCustomizations(): Record<string, unknown> {
  const color = config().get<string>('activeColor', '#3B5239');
  const textColor = config().get<string>('textColor', '#f0f0f0');
  const tintTabs = config().get<boolean>('tintEditorTabs', false);

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

// Global (User-level) customization is shared by every VS Code window on
// this machine — this is the steady "something's pending somewhere" look
// seen by windows that are NOT the one with the actual prompt.
async function applyGlobalActiveColor() {
  await vscode.workspace
    .getConfiguration()
    .update('workbench.colorCustomizations', buildActiveCustomizations(), vscode.ConfigurationTarget.Global);
}

async function restoreGlobalBaseline() {
  await vscode.workspace
    .getConfiguration()
    .update('workbench.colorCustomizations', getBaseline(), vscode.ConfigurationTarget.Global);
}

function canUseWorkspaceScope(): boolean {
  return !!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
}

// Workspace-level customization only affects THIS window (it's written to
// this project's .vscode/settings.json), which is what lets the owning
// window blink independently of every other open window.
async function setWorkspaceOverride(value: Record<string, unknown> | undefined) {
  if (!canUseWorkspaceScope()) return;
  try {
    await vscode.workspace
      .getConfiguration()
      .update('workbench.colorCustomizations', value, vscode.ConfigurationTarget.Workspace);
  } catch {
    // no writable workspace settings (e.g. an untitled/folderless window) —
    // this window just keeps showing the steady global color instead.
  }
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

async function refresh() {
  const dir = getFlagDir();
  const files = listFlagFiles(dir);
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
      await refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePermissionFlash.resetBaseline', async () => {
      const current = vscode.workspace.getConfiguration().get<Record<string, unknown>>('workbench.colorCustomizations') || {};
      await extensionContext.globalState.update(BASELINE_KEY, current);
      vscode.window.showInformationMessage('Claude Permission Flash: current colors saved as the baseline to restore to.');
    })
  );

  context.subscriptions.push({
    dispose: () => {
      watcher?.close();
      if (pollTimer) clearInterval(pollTimer);
      stopFlashing();
      if (isMineActive) void setWorkspaceOverride(undefined);
      if (isGlobalActive) void restoreGlobalBaseline();
    },
  });
}

export async function deactivate() {
  stopFlashing();
  if (isMineActive) {
    await setWorkspaceOverride(undefined);
  }
  if (isGlobalActive) {
    await restoreGlobalBaseline();
  }
}
