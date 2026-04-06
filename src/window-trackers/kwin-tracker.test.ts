import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vm from 'node:vm';
import { detectCompositor } from './index';
import {
  buildKWinBridgeScript,
  buildKWinTrackerPluginName,
  buildKWinTrackerServiceName,
  KWinWindowTracker,
  selectKWinMpvWindow,
  type KWinWindow,
} from './kwin-tracker';

const NativeWeakSet = globalThis.WeakSet;

type ScriptCallback = (...args: unknown[]) => void;

function createScriptSignal() {
  const callbacks: ScriptCallback[] = [];
  return {
    callbacks,
    connect(callback: ScriptCallback) {
      callbacks.push(callback);
    },
    emit(...args: unknown[]) {
      for (const callback of callbacks) {
        callback(...args);
      }
    },
  };
}

type ScriptSignal = ReturnType<typeof createScriptSignal>;

interface ScriptWindow {
  __weakSetUnsafe?: boolean;
  testId?: string;
  active: boolean;
  caption: string;
  managed: boolean;
  deleted: boolean;
  minimized: boolean;
  normalWindow: boolean;
  specialWindow: boolean;
  transient: boolean;
  popupWindow: boolean;
  outline: boolean;
  modal: boolean;
  pid: number;
  resourceClass: string;
  resourceName: string;
  keepAbove: boolean;
  visible: boolean;
  hidden?: boolean;
  clientGeometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  frameGeometry?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  closed: ScriptSignal;
  clientGeometryChanged: ScriptSignal;
  frameGeometryChanged: ScriptSignal;
  outputChanged: ScriptSignal;
  windowClassChanged: ScriptSignal;
  windowShown: ScriptSignal;
  windowHidden: ScriptSignal;
  activeChanged: ScriptSignal;
}

interface ScriptWorkspace {
  windowList: () => ScriptWindow[];
  raiseWindow: (window: ScriptWindow) => void;
  windowAdded: ScriptSignal;
  windowRemoved: ScriptSignal;
  windowActivated: ScriptSignal;
  screensChanged: ScriptSignal;
  activeWindow?: ScriptWindow | null;
}

class GuardedWeakSet<T extends object> {
  private readonly inner = new NativeWeakSet<T>();

  has(value: T): boolean {
    this.assertSafe(value);
    return this.inner.has(value);
  }

  add(value: T): this {
    this.assertSafe(value);
    this.inner.add(value);
    return this;
  }

  private assertSafe(value: T): void {
    const candidate = value as { __weakSetUnsafe?: boolean; testId?: string };
    if (candidate.__weakSetUnsafe === true) {
      throw new Error(`unexpected WeakSet access for ${candidate.testId ?? 'window'}`);
    }
  }
}

function makeWindow(overrides: Partial<KWinWindow> = {}): KWinWindow {
  return {
    active: false,
    caption: 'mpv',
    minimized: false,
    normalWindow: true,
    pid: 100,
    resourceClass: 'mpv',
    resourceName: 'mpv',
    x: 10,
    y: 20,
    width: 1280,
    height: 720,
    ...overrides,
  };
}

function makeScriptWindow(overrides: Partial<ScriptWindow> = {}): ScriptWindow {
  return {
    active: false,
    caption: 'mpv',
    managed: true,
    deleted: false,
    minimized: false,
    normalWindow: true,
    specialWindow: false,
    transient: false,
    popupWindow: false,
    outline: false,
    modal: false,
    pid: 100,
    resourceClass: 'mpv',
    resourceName: 'mpv',
    keepAbove: false,
    visible: true,
    hidden: false,
    clientGeometry: {
      x: 10,
      y: 20,
      width: 1280,
      height: 720,
    },
    frameGeometry: {
      x: 10,
      y: 20,
      width: 1280,
      height: 720,
    },
    closed: createScriptSignal(),
    clientGeometryChanged: createScriptSignal(),
    frameGeometryChanged: createScriptSignal(),
    outputChanged: createScriptSignal(),
    windowClassChanged: createScriptSignal(),
    windowShown: createScriptSignal(),
    windowHidden: createScriptSignal(),
    activeChanged: createScriptSignal(),
    ...overrides,
  };
}

function makeOverlayScriptWindow(overrides: Partial<ScriptWindow> = {}): ScriptWindow {
  return makeScriptWindow({
    caption: 'SubMiner',
    pid: process.pid,
    resourceClass: 'subminer',
    resourceName: 'subminer',
    ...overrides,
  });
}

function trackWindowMutations(window: ScriptWindow): ScriptWindow & {
  frameGeometryAssignments: Array<{ x: number; y: number; width: number; height: number }>;
  minimizedAssignments: boolean[];
  keepAboveAssignments: boolean[];
} {
  let frameGeometryValue = {
    x: Number(window.frameGeometry?.x || 0),
    y: Number(window.frameGeometry?.y || 0),
    width: Number(window.frameGeometry?.width || 0),
    height: Number(window.frameGeometry?.height || 0),
  };
  let minimizedValue = window.minimized;
  let keepAboveValue = window.keepAbove;
  const frameGeometryAssignments: Array<{ x: number; y: number; width: number; height: number }> =
    [];
  const minimizedAssignments: boolean[] = [];
  const keepAboveAssignments: boolean[] = [];

  Object.defineProperty(window, 'frameGeometry', {
    configurable: true,
    enumerable: true,
    get: () => frameGeometryValue,
    set: (value) => {
      frameGeometryValue = {
        x: Number(value?.x || 0),
        y: Number(value?.y || 0),
        width: Number(value?.width || 0),
        height: Number(value?.height || 0),
      };
      frameGeometryAssignments.push(frameGeometryValue);
    },
  });

  Object.defineProperty(window, 'minimized', {
    configurable: true,
    enumerable: true,
    get: () => minimizedValue,
    set: (value) => {
      minimizedValue = value === true;
      minimizedAssignments.push(minimizedValue);
    },
  });

  Object.defineProperty(window, 'keepAbove', {
    configurable: true,
    enumerable: true,
    get: () => keepAboveValue,
    set: (value) => {
      keepAboveValue = value === true;
      keepAboveAssignments.push(keepAboveValue);
    },
  });

  return Object.assign(window, {
    frameGeometryAssignments,
    minimizedAssignments,
    keepAboveAssignments,
  });
}

function parseLastBridgePayload(payloads: string[]): {
  degraded?: boolean;
  selectionBlocked?: boolean;
  window?: KWinWindow | null;
  windows?: KWinWindow[];
} {
  const payload = payloads.at(-1);
  assert.notEqual(payload, undefined);
  return JSON.parse(payload! as string) as {
    degraded?: boolean;
    selectionBlocked?: boolean;
    window?: KWinWindow | null;
    windows?: KWinWindow[];
  };
}

interface RunKWinBridgeScriptOptions {
  emitWorkspaceActivatedOnSet?: boolean;
  emitPreviousActiveChangedOnSet?: boolean;
  emitTargetActiveChangedOnSet?: boolean;
  failActiveWindowSetCount?: number;
  targetMpvPid?: number | null;
  requireTargetMpvPid?: boolean;
}

function runKWinBridgeScript(
  windows: ScriptWindow[],
  options: RunKWinBridgeScriptOptions = {},
): {
  dbusPayloads: string[];
  workspace: ScriptWorkspace;
  activeWindowHistory: string[];
  activeWindowSetAttempts: string[];
  raiseCalls: string[];
} {
  const dbusPayloads: string[] = [];
  const raiseCalls: string[] = [];
  const activeWindowHistory: string[] = [];
  const activeWindowSetAttempts: string[] = [];
  let activeWindow: ScriptWindow | null = null;
  const workspace: ScriptWorkspace = {
    windowList: () => windows,
    raiseWindow: (window: ScriptWindow) => {
      raiseCalls.push(window.testId ?? window.caption);
    },
    windowAdded: createScriptSignal(),
    windowRemoved: createScriptSignal(),
    windowActivated: createScriptSignal(),
    screensChanged: createScriptSignal(),
  };

  Object.defineProperty(workspace, 'activeWindow', {
    configurable: true,
    enumerable: true,
    get: () => activeWindow,
    set: (window: ScriptWindow | null) => {
      activeWindowSetAttempts.push(window?.testId ?? window?.caption ?? 'null');
      if ((options.failActiveWindowSetCount ?? 0) > 0) {
        options.failActiveWindowSetCount = (options.failActiveWindowSetCount ?? 0) - 1;
        throw new Error('activeWindow set failed');
      }
      const previousWindow = activeWindow;
      activeWindow = window;
      activeWindowHistory.push(window?.testId ?? window?.caption ?? 'null');
      if (options.emitPreviousActiveChangedOnSet && previousWindow && window !== previousWindow) {
        previousWindow.active = false;
        previousWindow.activeChanged.emit(previousWindow);
      }
      if (options.emitWorkspaceActivatedOnSet && window && window !== previousWindow) {
        workspace.windowActivated.emit(window);
      }
      if (options.emitTargetActiveChangedOnSet && window && window !== previousWindow) {
        window.active = true;
        window.activeChanged.emit(window);
      }
    },
  });

  vm.runInNewContext(
    buildKWinBridgeScript(
      'io.github.subminer.kwinbridge.test',
      options.targetMpvPid ?? null,
      options.requireTargetMpvPid === true,
    ),
    {
      Array,
      GuardedWeakSet,
      JSON,
      Number,
      Object,
      String,
      WeakSet: GuardedWeakSet,
      callDBus: (
        _serviceName: string,
        _objectPath: string,
        _interfaceName: string,
        member: string,
        payload: string,
      ) => {
        assert.equal(member, 'Update');
        dbusPayloads.push(payload);
      },
      workspace,
    },
  );

  return { dbusPayloads, workspace, activeWindowHistory, activeWindowSetAttempts, raiseCalls };
}

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  try {
    return callback();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(process, 'platform', originalDescriptor);
    }
  }
}

function withEnv<T>(overrides: Record<string, string | undefined>, callback: () => T): T {
  const originalValues = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    originalValues.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('selectKWinMpvWindow prefers the active window among socket matches', () => {
  const commandLines = new Map<number, string>([
    [10, 'mpv --input-ipc-server=/tmp/subminer.sock first.mkv'],
    [20, 'mpv --input-ipc-server=/tmp/subminer.sock second.mkv'],
  ]);

  const selected = selectKWinMpvWindow(
    [makeWindow({ pid: 10, active: false }), makeWindow({ pid: 20, active: true })],
    {
      targetMpvSocketPath: '/tmp/subminer.sock',
      getWindowCommandLine: (pid) => commandLines.get(pid) ?? null,
    },
  );

  assert.equal(selected?.pid, 20);
});

test('selectKWinMpvWindow requires an exact socket-path match', () => {
  const selected = selectKWinMpvWindow(
    [makeWindow({ pid: 10, active: true }), makeWindow({ pid: 20, active: false })],
    {
      targetMpvSocketPath: '/tmp/subminer.sock',
      getWindowCommandLine: (pid) => {
        if (pid === 10) return 'mpv --input-ipc-server=/tmp/subminer.sock2 second.mkv';
        if (pid === 20) return 'mpv --input-ipc-server=/tmp/subminer.sock first.mkv';
        return null;
      },
    },
  );

  assert.equal(selected?.pid, 20);
});

test('selectKWinMpvWindow matches Linux /proc-style socket paths with spaces', () => {
  const selected = selectKWinMpvWindow([makeWindow({ pid: 10, active: true })], {
    targetMpvSocketPath: '/tmp/subminer socket.sock',
    getWindowCommandLine: () => 'mpv\0--input-ipc-server=/tmp/subminer socket.sock\0first.mkv\0',
  });

  assert.equal(selected?.pid, 10);
});

test('selectKWinMpvWindow ignores minimized and non-mpv windows', () => {
  const selected = selectKWinMpvWindow(
    [
      makeWindow({ minimized: true, pid: 1 }),
      makeWindow({
        resourceClass: 'vlc',
        resourceName: 'vlc',
        caption: 'VLC media player',
        pid: 2,
      }),
      makeWindow({ pid: 3, x: 100, y: 200, width: 1920, height: 1080 }),
    ],
    {
      targetMpvSocketPath: null,
      getWindowCommandLine: () => null,
    },
  );

  assert.equal(selected?.pid, 3);
});

test('selectKWinMpvWindow ignores hidden serialized windows', () => {
  const selected = selectKWinMpvWindow(
    [
      makeWindow({ active: true, hidden: true, pid: 1, visible: false }),
      makeWindow({ active: false, pid: 2 }),
    ],
    {
      targetMpvSocketPath: null,
      getWindowCommandLine: () => null,
    },
  );

  assert.equal(selected?.pid, 2);
});

test('detectCompositor resolves kwin on KDE Plasma Wayland', () => {
  withPlatform('linux', () => {
    withEnv(
      {
        HYPRLAND_INSTANCE_SIGNATURE: undefined,
        SWAYSOCK: undefined,
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: 'KDE',
        XDG_SESSION_DESKTOP: 'KDE',
      },
      () => {
        assert.equal(detectCompositor(), 'kwin');
      },
    );
  });
});

test('detectCompositor resolves sway when SWAYSOCK is present', () => {
  withPlatform('linux', () => {
    withEnv(
      {
        HYPRLAND_INSTANCE_SIGNATURE: undefined,
        SWAYSOCK: '/tmp/sway.sock',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: undefined,
        XDG_SESSION_DESKTOP: undefined,
      },
      () => {
        assert.equal(detectCompositor(), 'sway');
      },
    );
  });
});

test('KWin tracker names are instance-scoped', () => {
  assert.equal(buildKWinTrackerServiceName('p123_abc'), 'io.github.subminer.kwinbridge.p123_abc');
  assert.equal(buildKWinTrackerPluginName('p123_abc'), 'subminerKWinTracker_p123_abc');
});

test('KWin bridge script skips unsafe windows before WeakSet access', () => {
  const safeMpvWindow = makeScriptWindow({ testId: 'safe-mpv' });
  const overlayWindow = makeOverlayScriptWindow({ testId: 'overlay-window' });
  const safeCandidateWindow = makeScriptWindow({
    caption: 'Terminal',
    resourceClass: 'konsole',
    resourceName: 'konsole',
    testId: 'safe-candidate',
  });
  const deletedWindow = makeScriptWindow({
    __weakSetUnsafe: true,
    deleted: true,
    testId: 'deleted-window',
  });
  const transientWindow = makeScriptWindow({
    __weakSetUnsafe: true,
    testId: 'transient-window',
    transient: true,
  });
  const unmanagedWindow = makeScriptWindow({
    __weakSetUnsafe: true,
    managed: false,
    testId: 'unmanaged-window',
  });
  const nonNormalWindow = makeScriptWindow({
    __weakSetUnsafe: true,
    normalWindow: false,
    testId: 'non-normal-window',
  });
  const specialWindow = makeScriptWindow({
    __weakSetUnsafe: true,
    specialWindow: true,
    testId: 'special-window',
  });
  const outlineWindow = makeScriptWindow({
    __weakSetUnsafe: true,
    outline: true,
    testId: 'outline-window',
  });
  const { dbusPayloads, workspace } = runKWinBridgeScript([
    safeMpvWindow,
    overlayWindow,
    safeCandidateWindow,
    deletedWindow,
    transientWindow,
    unmanagedWindow,
    nonNormalWindow,
    specialWindow,
    outlineWindow,
  ]);

  assert.equal(workspace.windowActivated.callbacks.length, 0);
  assert.equal(safeMpvWindow.closed.callbacks.length > 0, true);
  assert.equal(overlayWindow.closed.callbacks.length, 0);
  assert.equal(safeCandidateWindow.windowClassChanged.callbacks.length > 0, true);
  assert.equal(deletedWindow.closed.callbacks.length, 0);
  assert.equal(transientWindow.closed.callbacks.length, 0);
  assert.equal(unmanagedWindow.closed.callbacks.length, 0);
  assert.equal(nonNormalWindow.closed.callbacks.length, 0);
  assert.equal(specialWindow.closed.callbacks.length, 0);
  assert.equal(outlineWindow.closed.callbacks.length, 0);
  assert.equal(parseLastBridgePayload(dbusPayloads).window?.pid, 100);

  const popupWindow = makeScriptWindow({
    __weakSetUnsafe: true,
    popupWindow: true,
    testId: 'popup-window',
  });
  workspace.windowAdded.emit(popupWindow);
  assert.equal(popupWindow.closed.callbacks.length, 0);
});

test('KWin bridge script tracks windows that become mpv after being added', () => {
  const overlayWindow = makeOverlayScriptWindow({
    testId: 'overlay-window',
  });
  const windows: ScriptWindow[] = [overlayWindow];
  const { dbusPayloads, workspace } = runKWinBridgeScript(windows);
  const candidateWindow = makeScriptWindow({
    caption: 'Konsole',
    pid: 222,
    resourceClass: 'konsole',
    resourceName: 'konsole',
    testId: 'candidate-window',
  });

  windows.unshift(candidateWindow);
  workspace.windowAdded.emit(candidateWindow);

  assert.equal(parseLastBridgePayload(dbusPayloads).window, null);
  assert.equal(candidateWindow.clientGeometryChanged.callbacks.length, 0);

  candidateWindow.caption = 'mpv';
  candidateWindow.resourceClass = 'mpv';
  candidateWindow.resourceName = 'mpv';
  candidateWindow.windowClassChanged.emit(candidateWindow);

  assert.equal(candidateWindow.clientGeometryChanged.callbacks.length > 0, true);
  assert.equal(parseLastBridgePayload(dbusPayloads).window?.pid, 222);
});

test('KWin bridge script ignores overlay activation and reports only mpv windows', () => {
  const mpvWindow = makeScriptWindow({ active: false, testId: 'mpv-window' });
  const overlayWindow = makeOverlayScriptWindow({
    active: true,
    testId: 'overlay-window',
  });
  const { dbusPayloads, workspace } = runKWinBridgeScript([mpvWindow, overlayWindow]);

  const payload = parseLastBridgePayload(dbusPayloads);
  assert.equal(workspace.windowActivated.callbacks.length, 0);
  assert.equal(mpvWindow.activeChanged.callbacks.length, 0);
  assert.equal(overlayWindow.activeChanged.callbacks.length, 0);
  assert.equal(payload.window?.active, false);
  assert.deepEqual(
    payload.windows?.map((window) => window.caption),
    ['mpv'],
  );
});

test('KWin bridge script uses client geometry without mutating overlay windows', () => {
  const mpvWindow = makeScriptWindow({
    testId: 'mpv-window',
    clientGeometry: {
      x: 40,
      y: 60,
      width: 1280,
      height: 720,
    },
    frameGeometry: {
      x: 12,
      y: 24,
      width: 1360,
      height: 816,
    },
  });
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
      frameGeometry: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      },
    }),
  );
  const { dbusPayloads } = runKWinBridgeScript([mpvWindow, overlayWindow]);

  assert.equal(mpvWindow.clientGeometryChanged.callbacks.length > 0, true);
  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
  assert.equal(overlayWindow.minimizedAssignments.length, 0);
  assert.equal(overlayWindow.keepAboveAssignments.length, 0);
  assert.deepEqual(parseLastBridgePayload(dbusPayloads).window, {
    active: false,
    caption: 'mpv',
    minimized: false,
    normalWindow: true,
    pid: 100,
    resourceClass: 'mpv',
    resourceName: 'mpv',
    x: 40,
    y: 60,
    width: 1280,
    height: 720,
  });

  mpvWindow.clientGeometry = {
    x: 55,
    y: 75,
    width: 1200,
    height: 680,
  };
  mpvWindow.clientGeometryChanged.emit(mpvWindow);

  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
  assert.deepEqual(parseLastBridgePayload(dbusPayloads).window, {
    active: false,
    caption: 'mpv',
    minimized: false,
    normalWindow: true,
    pid: 100,
    resourceClass: 'mpv',
    resourceName: 'mpv',
    x: 55,
    y: 75,
    width: 1200,
    height: 680,
  });
});

test('KWin bridge script follows mpv moves when KWin signals frame geometry changes', () => {
  const mpvWindow = makeScriptWindow({
    clientGeometry: {
      x: 40,
      y: 60,
      width: 1280,
      height: 720,
    },
    testId: 'mpv-window',
    frameGeometry: {
      x: 12,
      y: 24,
      width: 1360,
      height: 816,
    },
  });
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
      frameGeometry: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      },
    }),
  );
  const { dbusPayloads } = runKWinBridgeScript([mpvWindow, overlayWindow]);

  mpvWindow.frameGeometry = {
    x: 85,
    y: 105,
    width: 1180,
    height: 660,
  };
  mpvWindow.frameGeometryChanged.emit(mpvWindow);

  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
  assert.equal(parseLastBridgePayload(dbusPayloads).degraded, undefined);
  assert.deepEqual(parseLastBridgePayload(dbusPayloads).window, {
    active: false,
    caption: 'mpv',
    minimized: false,
    normalWindow: true,
    pid: 100,
    resourceClass: 'mpv',
    resourceName: 'mpv',
    x: 85,
    y: 105,
    width: 1180,
    height: 660,
  });
});

test('KWin bridge script stays read-only during startup sync', () => {
  const mpvWindow = makeScriptWindow({
    active: true,
    testId: 'mpv-window',
  });
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
    }),
  );

  const { activeWindowSetAttempts, dbusPayloads, raiseCalls } = runKWinBridgeScript([
    mpvWindow,
    overlayWindow,
  ]);

  assert.deepEqual(raiseCalls, []);
  assert.deepEqual(activeWindowSetAttempts, []);
  assert.equal(parseLastBridgePayload(dbusPayloads).degraded, undefined);
  assert.equal(parseLastBridgePayload(dbusPayloads).window?.active, true);
  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
  assert.equal(overlayWindow.minimizedAssignments.length, 0);
  assert.equal(overlayWindow.keepAboveAssignments.length, 0);
});

test('KWin bridge script prefers the configured target mpv pid over another active mpv window', () => {
  const activeOtherMpvWindow = makeScriptWindow({
    active: true,
    pid: 101,
    testId: 'other-mpv-window',
    clientGeometry: {
      x: 10,
      y: 20,
      width: 640,
      height: 360,
    },
  });
  const targetMpvWindow = makeScriptWindow({
    active: false,
    pid: 202,
    testId: 'target-mpv-window',
    clientGeometry: {
      x: 40,
      y: 60,
      width: 1280,
      height: 720,
    },
  });
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
    }),
  );

  const { dbusPayloads } = runKWinBridgeScript(
    [activeOtherMpvWindow, targetMpvWindow, overlayWindow],
    { requireTargetMpvPid: true, targetMpvPid: 202 },
  );

  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
  assert.equal(parseLastBridgePayload(dbusPayloads).window?.pid, 202);
});

test('KWin bridge script fails closed when the configured target mpv pid is absent', () => {
  const activeOtherMpvWindow = makeScriptWindow({
    active: true,
    pid: 101,
    testId: 'other-mpv-window',
    clientGeometry: {
      x: 10,
      y: 20,
      width: 640,
      height: 360,
    },
  });
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
    }),
  );

  const { dbusPayloads } = runKWinBridgeScript([activeOtherMpvWindow, overlayWindow], {
    requireTargetMpvPid: true,
    targetMpvPid: 202,
  });

  assert.equal(parseLastBridgePayload(dbusPayloads).selectionBlocked, true);
  assert.equal(parseLastBridgePayload(dbusPayloads).window, null);
  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
});

test('KWin bridge script fails closed when socket targeting is required but no target pid was resolved', () => {
  const activeOtherMpvWindow = makeScriptWindow({
    active: true,
    pid: 101,
    testId: 'other-mpv-window',
    clientGeometry: {
      x: 10,
      y: 20,
      width: 640,
      height: 360,
    },
  });
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
    }),
  );

  const { dbusPayloads } = runKWinBridgeScript([activeOtherMpvWindow, overlayWindow], {
    requireTargetMpvPid: true,
    targetMpvPid: null,
  });

  assert.equal(parseLastBridgePayload(dbusPayloads).selectionBlocked, true);
  assert.equal(parseLastBridgePayload(dbusPayloads).window, null);
  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
});

test('KWin bridge script does not mutate overlay windows when mpv visibility changes', () => {
  const mpvWindow = trackWindowMutations(
    makeScriptWindow({
      active: true,
      testId: 'mpv-window',
    }),
  );
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
    }),
  );

  const { dbusPayloads } = runKWinBridgeScript([mpvWindow, overlayWindow]);

  mpvWindow.minimized = true;
  mpvWindow.windowHidden.emit(mpvWindow);

  assert.equal(parseLastBridgePayload(dbusPayloads).selectionBlocked, true);
  assert.equal(parseLastBridgePayload(dbusPayloads).window, null);
  assert.equal(overlayWindow.frameGeometryAssignments.length, 0);
  assert.equal(overlayWindow.minimizedAssignments.length, 0);
  assert.equal(overlayWindow.keepAboveAssignments.length, 0);
});

test('KWin bridge script does not write workspace.activeWindow when an mpv window is added later', () => {
  const overlayWindow = trackWindowMutations(
    makeOverlayScriptWindow({
      testId: 'overlay-window',
    }),
  );
  const windows: ScriptWindow[] = [overlayWindow];

  const { activeWindowSetAttempts, dbusPayloads, raiseCalls, workspace } =
    runKWinBridgeScript(windows);
  const initialRaiseCallCount = raiseCalls.length;

  const mpvWindow = makeScriptWindow({
    active: true,
    testId: 'mpv-window',
  });
  windows.unshift(mpvWindow);
  workspace.windowAdded.emit(mpvWindow);

  assert.deepEqual(raiseCalls.slice(initialRaiseCallCount), []);
  assert.deepEqual(activeWindowSetAttempts, []);
  assert.equal(parseLastBridgePayload(dbusPayloads).degraded, undefined);
  assert.equal(parseLastBridgePayload(dbusPayloads).window?.pid, 100);
});

test('KWin bridge script skips redundant DBus updates when overlay-only churn does not change mpv state', () => {
  const mpvWindow = makeScriptWindow({
    testId: 'mpv-window',
  });
  const overlayWindow = makeOverlayScriptWindow({
    testId: 'overlay-window',
  });

  const { dbusPayloads } = runKWinBridgeScript([mpvWindow, overlayWindow]);
  const initialPayloadCount = dbusPayloads.length;

  assert.equal(overlayWindow.frameGeometryChanged.callbacks.length, 0);
  overlayWindow.frameGeometryChanged.emit(overlayWindow);

  assert.equal(dbusPayloads.length, initialPayloadCount);
});

test('KWin bridge script degrades safely when a payload would exceed the size limit', () => {
  const mpvWindow = makeScriptWindow({
    caption: `mpv ${'x'.repeat(40000)}`,
    testId: 'mpv-window',
  });

  const { dbusPayloads } = runKWinBridgeScript([mpvWindow]);

  assert.equal(dbusPayloads.length, 1);
  assert.deepEqual(parseLastBridgePayload(dbusPayloads), {
    degraded: true,
    window: null,
  });

  mpvWindow.clientGeometryChanged.emit(mpvWindow);
  assert.equal(dbusPayloads.length, 1);
});

test('KWin tracker exposes passive focus capabilities', async () => {
  const tracker = new KWinWindowTracker();

  assert.equal(tracker.hasAuthoritativeFocus(), false);
  assert.equal(tracker.shouldAutoFocusVisibleOverlay(), false);

  await (tracker as any).stopAsync();
});

test('KWin tracker falls back to unloading unnamed loadScript calls by file path', async () => {
  const tracker = new KWinWindowTracker() as any;
  const callSignatures: string[] = [];

  tracker.callMethod = async (_bus: unknown, options: { member: string; signature?: string }) => {
    if (options.member !== 'loadScript') {
      throw new Error(`unexpected method: ${options.member}`);
    }

    callSignatures.push(options.signature ?? '');
    if (options.signature === 'ss') {
      throw new Error("Expected 1 body elements for signature 's'");
    }

    return 17;
  };

  try {
    const loadedScript = await tracker.loadScript(
      {} as never,
      '/tmp/subminer-kwin-test/main.js',
      'subminerKWinTracker_test',
    );

    assert.deepEqual(loadedScript, {
      scriptId: 17,
      unloadKey: '/tmp/subminer-kwin-test/main.js',
    });
    assert.deepEqual(callSignatures, ['ss', 's']);
  } finally {
    await tracker.stopAsync();
  }
});

test('KWin tracker rejects empty non-void DBus replies', async () => {
  const tracker = new KWinWindowTracker() as any;

  try {
    await assert.rejects(
      tracker.callMethod(
        {
          call: async () => ({
            body: [],
          }),
        } as never,
        {
          path: '/Scripting',
          interfaceName: 'org.kde.kwin.Scripting',
          member: 'loadScript',
          signature: 's',
          body: ['/tmp/subminer-kwin-test/main.js'],
        },
      ),
      /Empty reply body from org\.kde\.kwin\.Scripting\.loadScript/,
    );
  } finally {
    await tracker.stopAsync();
  }
});

test('KWin tracker stop unloads the tracked fallback script key', async () => {
  const tracker = new KWinWindowTracker() as any;
  const calls: string[] = [];

  tracker.bus = {
    disconnect: () => {
      calls.push('disconnect');
    },
    releaseName: async () => {
      calls.push('releaseName');
    },
    unexport: () => {
      calls.push('unexport');
    },
  };
  tracker.scriptId = 23;
  tracker.unloadScriptKey = '/tmp/subminer-kwin-test/main.js';
  tracker.stopScript = async (_bus: unknown, scriptId: number) => {
    calls.push(`stop:${scriptId}`);
  };
  tracker.unloadScript = async (_bus: unknown, unloadKey: string) => {
    calls.push(`unload:${unloadKey}`);
    return true;
  };

  await tracker.stopAsync();

  assert.deepEqual(calls.slice(0, 2), ['stop:23', 'unload:/tmp/subminer-kwin-test/main.js']);
});

test('KWin tracker recreates its temp workspace after stop', async () => {
  const tracker = new KWinWindowTracker() as any;
  const firstScriptPath = tracker.ensureScriptWorkspace();

  assert.equal(fs.existsSync(path.dirname(firstScriptPath)), true);

  await tracker.stopAsync();

  const secondScriptPath = tracker.ensureScriptWorkspace();
  assert.notEqual(secondScriptPath, firstScriptPath);
  assert.equal(fs.existsSync(path.dirname(secondScriptPath)), true);

  await tracker.stopAsync();
});

test('KWin tracker ignores malformed windows payloads', async () => {
  const tracker = new KWinWindowTracker() as any;
  const geometries: unknown[] = [];

  tracker.updateGeometry = (geometry: unknown) => {
    geometries.push(geometry);
  };
  tracker.updateFocus = () => {};
  tracker.handleUpdate(JSON.stringify({ windows: { pid: 1 } }));

  assert.deepEqual(geometries, [null]);
  await tracker.stopAsync();
});

test('KWin tracker filters malformed window entries before selection', async () => {
  const tracker = new KWinWindowTracker() as any;
  tracker.getWindowCommandLine = () => null;

  tracker.handleUpdate(
    JSON.stringify({
      windows: [null, 42, 'mpv', { pid: 7 }, makeWindow({ active: true, pid: 9, x: 50, y: 60 })],
    }),
  );

  assert.deepEqual(tracker.getGeometry(), { x: 50, y: 60, width: 1280, height: 720 });
  assert.equal(tracker.isTargetWindowFocused(), true);
  await tracker.stopAsync();
});

test('KWin tracker reports an initially inactive window as unfocused without a transient focused=true transition', async () => {
  const tracker = new KWinWindowTracker() as any;
  const focusTransitions: boolean[] = [];

  tracker.onWindowFocusChange = (focused: boolean) => {
    focusTransitions.push(focused);
  };

  tracker.handleUpdate(
    JSON.stringify({
      window: makeWindow({ active: false, pid: 9, x: 50, y: 60 }),
    }),
  );

  assert.deepEqual(focusTransitions, []);
  await tracker.stopAsync();
});

test('KWin tracker consumes compact single-window payloads', async () => {
  const tracker = new KWinWindowTracker() as any;

  tracker.handleUpdate(
    JSON.stringify({
      window: makeWindow({ active: true, pid: 9, x: 50, y: 60 }),
    }),
  );

  assert.deepEqual(tracker.getGeometry(), { x: 50, y: 60, width: 1280, height: 720 });
  assert.equal(tracker.isTargetWindowFocused(), true);
  await tracker.stopAsync();
});

test('KWin tracker prefers windows payload selection when socket filtering is available', async () => {
  const tracker = new KWinWindowTracker('/tmp/subminer.sock') as any;
  tracker.getWindowCommandLine = (pid: number) => {
    if (pid === 10) {
      return 'mpv --input-ipc-server=/tmp/other.sock first.mkv';
    }
    if (pid === 20) {
      return 'mpv --input-ipc-server=/tmp/subminer.sock second.mkv';
    }
    return null;
  };

  tracker.handleUpdate(
    JSON.stringify({
      window: makeWindow({ active: true, pid: 10, x: 10, y: 20 }),
      windows: [
        makeWindow({ active: true, pid: 10, x: 10, y: 20 }),
        makeWindow({ active: false, pid: 20, x: 50, y: 60 }),
      ],
    }),
  );

  assert.deepEqual(tracker.getGeometry(), { x: 50, y: 60, width: 1280, height: 720 });
  assert.equal(tracker.isTargetWindowFocused(), false);
  await tracker.stopAsync();
});

test('KWin tracker fails closed when socket filtering cannot resolve a match', async () => {
  const tracker = new KWinWindowTracker('/tmp/subminer.sock') as any;
  const geometries: unknown[] = [];
  const focusStates: boolean[] = [];

  tracker.updateGeometry = (geometry: unknown) => {
    geometries.push(geometry);
  };
  tracker.updateFocus = (focused: boolean) => {
    focusStates.push(focused);
  };
  tracker.getWindowCommandLine = () => null;

  tracker.handleUpdate(
    JSON.stringify({
      window: makeWindow({ active: true, pid: 10, x: 10, y: 20 }),
      windows: [
        makeWindow({ active: true, pid: 10, x: 10, y: 20 }),
        makeWindow({ active: false, pid: 20, x: 50, y: 60 }),
      ],
    }),
  );

  assert.deepEqual(geometries, [null]);
  assert.deepEqual(focusStates, []);
  await tracker.stopAsync();
});

test('KWin tracker clears geometry when the bridge blocks target selection', async () => {
  const tracker = new KWinWindowTracker('/tmp/subminer.sock') as any;
  const geometries: unknown[] = [];
  const focusStates: boolean[] = [];

  tracker.updateGeometry = (geometry: unknown) => {
    geometries.push(geometry);
  };
  tracker.updateFocus = (focused: boolean) => {
    focusStates.push(focused);
  };
  tracker.getWindowCommandLine = () => 'mpv --input-ipc-server=/tmp/subminer.sock';

  tracker.handleUpdate(
    JSON.stringify({
      selectionBlocked: true,
      window: null,
      windows: [makeWindow({ hidden: true, pid: 20, visible: false, x: 50, y: 60 })],
    }),
  );

  assert.deepEqual(geometries, [null]);
  assert.deepEqual(focusStates, []);
  await tracker.stopAsync();
});

test('KWin tracker clears geometry when the bridge reports degraded mode', async () => {
  const tracker = new KWinWindowTracker() as any;
  const geometries: unknown[] = [];

  tracker.updateGeometry = (geometry: unknown) => {
    geometries.push(geometry);
  };
  tracker.updateFocus = () => {};

  tracker.handleUpdate(JSON.stringify({ degraded: true, window: null }));

  assert.deepEqual(geometries, [null]);
  await tracker.stopAsync();
});

test('KWin tracker caches process command lines between updates', async () => {
  const tracker = new KWinWindowTracker() as any;
  let readCount = 0;

  tracker.readProcessCommandLine = (pid: number) => {
    readCount += 1;
    return `mpv --input-ipc-server=/tmp/subminer-${pid}.sock`;
  };

  assert.equal(tracker.getWindowCommandLine(42), 'mpv --input-ipc-server=/tmp/subminer-42.sock');
  assert.equal(tracker.getWindowCommandLine(42), 'mpv --input-ipc-server=/tmp/subminer-42.sock');
  assert.equal(readCount, 1);

  await tracker.stopAsync();
});

test('KWin tracker rejects invalid pids before reading process command lines', async () => {
  const tracker = new KWinWindowTracker() as any;

  assert.equal(tracker.readProcessCommandLine(0), null);
  assert.equal(tracker.readProcessCommandLine(-1), null);
  assert.equal(tracker.readProcessCommandLine(1.5), null);

  await tracker.stopAsync();
});
