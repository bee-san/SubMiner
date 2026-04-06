/*
  SubMiner - All-in-one sentence mining overlay
  Copyright (C) 2024 sudacode

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as dbus from 'dbus-next';
import { BaseWindowTracker } from './base-tracker';
import { createLogger } from '../logger';

const log = createLogger('tracker').child('kwin');

const KWIN_SERVICE_NAME = 'org.kde.KWin';
const KWIN_SCRIPTING_PATH = '/Scripting';
const KWIN_SCRIPTING_INTERFACE = 'org.kde.kwin.Scripting';
const KWIN_SCRIPT_INTERFACE = 'org.kde.kwin.Script';
const BRIDGE_INTERFACE_NAME = 'io.github.subminer.kwinbridge.Interface';
const BRIDGE_OBJECT_PATH = '/io/github/subminer/kwinbridge';
const COMMAND_LINE_CACHE_TTL_MS = 1000;

type MessageBus = dbus.MessageBus;
type KWinLoadedScript = {
  scriptId: number;
  unloadKey: string;
};

export interface KWinWindow {
  active?: boolean;
  caption?: string;
  hidden?: boolean;
  minimized?: boolean;
  normalWindow?: boolean;
  pid?: number;
  resourceClass?: string;
  resourceName?: string;
  visible?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface KWinUpdatePayload {
  degraded?: boolean;
  selectionBlocked?: boolean;
  window?: KWinWindow | null;
  windows?: KWinWindow[];
}

interface SelectKWinMpvWindowOptions {
  targetMpvSocketPath: string | null;
  getWindowCommandLine: (pid: number) => string | null;
}

function createKWinTrackerInstanceToken(
  pid: number = process.pid,
  now: number = Date.now(),
  randomSuffix: string = Math.random().toString(36).slice(2, 10) || 'tracker',
): string {
  return `p${pid}_${now.toString(36)}_${randomSuffix}`;
}

export function buildKWinTrackerServiceName(instanceToken: string): string {
  return `io.github.subminer.kwinbridge.${instanceToken}`;
}

export function buildKWinTrackerPluginName(instanceToken: string): string {
  return `subminerKWinTracker_${instanceToken}`;
}

function shouldRetryUnnamedLoadScript(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes("Expected 1 body elements for signature 's'") ||
    message.includes('UnknownMethod')
  );
}

function normalizeWindowText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function matchesTargetSocketArgs(args: string[], targetMpvSocketPath: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (!argument) {
      continue;
    }

    if (argument === `--input-ipc-server=${targetMpvSocketPath}`) {
      return true;
    }

    if (argument === '--input-ipc-server' && args[i + 1] === targetMpvSocketPath) {
      return true;
    }
  }

  return false;
}

function hasDelimitedCommandLineMatch(commandLine: string, candidate: string): boolean {
  let startIndex = commandLine.indexOf(candidate);
  while (startIndex >= 0) {
    const endIndex = startIndex + candidate.length;
    const hasLeadingBoundary = startIndex === 0 || /\s/.test(commandLine[startIndex - 1]!);
    const hasTrailingBoundary =
      endIndex === commandLine.length || /\s/.test(commandLine[endIndex]!);

    if (hasLeadingBoundary && hasTrailingBoundary) {
      return true;
    }

    startIndex = commandLine.indexOf(candidate, startIndex + 1);
  }

  return false;
}

function matchesTargetSocket(commandLine: string, targetMpvSocketPath: string): boolean {
  if (commandLine.includes('\0')) {
    return matchesTargetSocketArgs(
      commandLine.split('\0').filter((value) => value.length > 0),
      targetMpvSocketPath,
    );
  }

  const candidates = [
    `--input-ipc-server=${targetMpvSocketPath}`,
    `--input-ipc-server ${targetMpvSocketPath}`,
    `--input-ipc-server="${targetMpvSocketPath}"`,
    `--input-ipc-server='${targetMpvSocketPath}'`,
    `--input-ipc-server "${targetMpvSocketPath}"`,
    `--input-ipc-server '${targetMpvSocketPath}'`,
  ];
  return candidates.some((candidate) => hasDelimitedCommandLineMatch(commandLine, candidate));
}

function preferActiveKWinWindow(windows: KWinWindow[]): KWinWindow | null {
  return windows.find((window) => window.active === true) ?? windows[0] ?? null;
}

function isMpvWindow(window: KWinWindow): boolean {
  return [window.resourceClass, window.resourceName, window.caption].some((value) =>
    normalizeWindowText(value).includes('mpv'),
  );
}

function hasValidGeometry(window: KWinWindow): boolean {
  return (
    Number.isFinite(window.x) &&
    Number.isFinite(window.y) &&
    Number.isFinite(window.width) &&
    Number.isFinite(window.height) &&
    (window.width ?? 0) > 0 &&
    (window.height ?? 0) > 0
  );
}

function isVisibleKWinWindow(window: KWinWindow): boolean {
  return window.minimized !== true && window.visible !== false && window.hidden !== true;
}

export function selectKWinMpvWindow(
  windows: KWinWindow[],
  options: SelectKWinMpvWindowOptions,
): KWinWindow | null {
  const visibleMpvWindows = windows.filter(
    (window) =>
      window.normalWindow !== false &&
      isVisibleKWinWindow(window) &&
      isMpvWindow(window) &&
      hasValidGeometry(window),
  );

  if (!options.targetMpvSocketPath) {
    return preferActiveKWinWindow(visibleMpvWindows);
  }

  const targetMpvSocketPath = options.targetMpvSocketPath;
  const matchingWindows = visibleMpvWindows.filter((window) => {
    if (!Number.isInteger(window.pid) || (window.pid ?? 0) <= 0) {
      return false;
    }

    const commandLine = options.getWindowCommandLine(window.pid!);
    if (!commandLine) {
      return false;
    }

    return matchesTargetSocket(commandLine, targetMpvSocketPath);
  });

  return preferActiveKWinWindow(matchingWindows);
}

function isKWinWindowCandidate(candidate: unknown): candidate is KWinWindow {
  return candidate !== null && typeof candidate === 'object';
}

class KWinTrackerBridgeInterface extends dbus.interface.Interface {
  private readonly onUpdatePayload: (payload: string) => void;

  constructor(onUpdatePayload: (payload: string) => void) {
    super(BRIDGE_INTERFACE_NAME);
    this.onUpdatePayload = onUpdatePayload;
  }

  Update(payload: string): void {
    this.onUpdatePayload(payload);
  }
}

KWinTrackerBridgeInterface.configureMembers({
  methods: {
    Update: {
      inSignature: 's',
      outSignature: '',
    },
  },
});

export function buildKWinBridgeScript(
  serviceName: string,
  targetMpvPid: number | null = null,
  requireTargetMpvPid: boolean = false,
): string {
  return `
const SERVICE_NAME = ${JSON.stringify(serviceName)};
const OBJECT_PATH = ${JSON.stringify(BRIDGE_OBJECT_PATH)};
const INTERFACE_NAME = ${JSON.stringify(BRIDGE_INTERFACE_NAME)};
const TARGET_MPV_PID = ${JSON.stringify(targetMpvPid)};
const REQUIRE_TARGET_MPV_PID = ${JSON.stringify(requireTargetMpvPid)};
const trackedWindows = new WeakSet();
const geometryWatchedWindows = new WeakSet();
const geometryPreference = new WeakMap();
const MAX_BRIDGE_PAYLOAD_BYTES = 32768;
let bridgeDisabled = false;
let bridgeDegradedStateEmitted = false;
let lastEmittedPayload = "";

function isWatchableWindow(window) {
  try {
    if (!window || typeof window !== "object") {
      return false;
    }
    if (window.managed === false || window.deleted === true) {
      return false;
    }
    if (window.normalWindow !== true) {
      return false;
    }
    if (window.specialWindow === true || window.transient === true) {
      return false;
    }
    if (window.popupWindow === true || window.outline === true) {
      return false;
    }
  } catch (_error) {
    return false;
  }

  return true;
}

function isMpvWindow(window) {
  if (!isWatchableWindow(window)) {
    return false;
  }

  const values = [window.resourceClass, window.resourceName, window.caption];
  for (const value of values) {
    if (String(value || "").toLowerCase().includes("mpv")) {
      return true;
    }
  }

  return false;
}

function isOverlayWindow(window) {
  const values = [window.resourceClass, window.resourceName, window.caption];
  for (const value of values) {
    if (String(value || "").toLowerCase().includes("subminer")) {
      return true;
    }
  }

  return false;
}

function primeGeometryPreference(window) {
  if (window.clientGeometry) {
    geometryPreference.set(window, "client");
    return;
  }
  if (window.frameGeometry) {
    geometryPreference.set(window, "frame");
  }
}

function getWindowGeometry(window) {
  const preferredGeometry = geometryPreference.get(window);
  if (preferredGeometry === "frame" && window.frameGeometry) {
    return window.frameGeometry;
  }
  if (preferredGeometry === "client" && window.clientGeometry) {
    return window.clientGeometry;
  }
  return window.clientGeometry || window.frameGeometry || {};
}

function serializeWindow(window) {
  const geometry = getWindowGeometry(window);
  return {
    active: window.active === true,
    caption: String(window.caption || ""),
    hidden: window.hidden === true ? true : undefined,
    minimized: window.minimized === true,
    normalWindow: window.normalWindow === true,
    pid: Number(window.pid || 0),
    resourceClass: String(window.resourceClass || ""),
    resourceName: String(window.resourceName || ""),
    visible: window.visible === false ? false : undefined,
    x: Number(geometry.x || 0),
    y: Number(geometry.y || 0),
    width: Number(geometry.width || 0),
    height: Number(geometry.height || 0),
  };
}

function hasUsableGeometry(window) {
  const geometry = getWindowGeometry(window);
  return (
    Number(geometry.width || 0) > 0 &&
    Number(geometry.height || 0) > 0
  );
}

function isWindowVisible(window) {
  if (!window) {
    return false;
  }
  if (window.minimized === true) {
    return false;
  }
  if (window.visible === false) {
    return false;
  }
  if (window.hidden === true) {
    return false;
  }
  return true;
}

function preferActiveScriptWindow(windows) {
  for (const window of windows) {
    if (window && window.active === true) {
      return window;
    }
  }

  return windows[0] || null;
}

function selectTargetMpvWindow() {
  const visibleMpvWindows = [];
  const hiddenMpvWindows = [];

  for (const window of workspace.windowList()) {
    if (!isMpvWindow(window) || !hasUsableGeometry(window)) {
      continue;
    }
    if (isWindowVisible(window)) {
      visibleMpvWindows.push(window);
    } else {
      hiddenMpvWindows.push(window);
    }
  }

  const targetMpvPid = Number(TARGET_MPV_PID || 0);
  if (targetMpvPid > 0) {
    const matchingVisibleWindows = visibleMpvWindows.filter(function (window) {
      return Number(window.pid || 0) === targetMpvPid;
    });
    if (matchingVisibleWindows.length > 0) {
      return preferActiveScriptWindow(matchingVisibleWindows);
    }

    const matchingHiddenWindows = hiddenMpvWindows.filter(function (window) {
      return Number(window.pid || 0) === targetMpvPid;
    });
    if (matchingHiddenWindows.length > 0) {
      return preferActiveScriptWindow(matchingHiddenWindows);
    }

    return null;
  }

  if (REQUIRE_TARGET_MPV_PID) {
    return null;
  }

  if (visibleMpvWindows.length > 0) {
    return preferActiveScriptWindow(visibleMpvWindows);
  }

  return preferActiveScriptWindow(hiddenMpvWindows);
}

function disableBridge() {
  if (bridgeDisabled) {
    return;
  }

  bridgeDisabled = true;
  if (bridgeDegradedStateEmitted) {
    return;
  }

  bridgeDegradedStateEmitted = true;
  const payload = JSON.stringify({ window: null, degraded: true });
  lastEmittedPayload = payload;

  try {
    callDBus(
      SERVICE_NAME,
      OBJECT_PATH,
      INTERFACE_NAME,
      "Update",
      payload
    );
  } catch (_error) {
    // ignore
  }
}

function emitState() {
  if (bridgeDisabled) {
    return;
  }

  try {
    const selectedWindow = selectTargetMpvWindow();
    const windows = [];
    for (const window of workspace.windowList()) {
      if (!isMpvWindow(window)) {
        continue;
      }
      windows.push(serializeWindow(window));
    }
    const selectionBlocked =
      (selectedWindow && (!isWindowVisible(selectedWindow) || !hasUsableGeometry(selectedWindow)))
      || (!selectedWindow && REQUIRE_TARGET_MPV_PID);

    const payload = JSON.stringify({
      selectionBlocked: selectionBlocked === true ? true : undefined,
      window:
        !selectionBlocked && selectedWindow && isWindowVisible(selectedWindow) && hasUsableGeometry(selectedWindow)
          ? serializeWindow(selectedWindow)
          : null,
      windows: windows,
    });

    if (payload.length > MAX_BRIDGE_PAYLOAD_BYTES) {
      disableBridge();
      return;
    }

    if (payload === lastEmittedPayload) {
      return;
    }

    lastEmittedPayload = payload;
    callDBus(
      SERVICE_NAME,
      OBJECT_PATH,
      INTERFACE_NAME,
      "Update",
      payload
    );
  } catch (_error) {
    disableBridge();
  }
}

function ensureGeometryWatchers(window) {
  if (geometryWatchedWindows.has(window)) {
    return;
  }

  geometryWatchedWindows.add(window);
  primeGeometryPreference(window);
  if (window.frameGeometryChanged) {
    window.frameGeometryChanged.connect(function () {
      geometryPreference.set(window, "frame");
      emitState();
    });
  }
  if (window.clientGeometryChanged) {
    window.clientGeometryChanged.connect(function () {
      geometryPreference.set(window, "client");
      emitState();
    });
  }
  if (window.outputChanged) {
    window.outputChanged.connect(function () {
      emitState();
    });
  }
}

function watchWindow(window) {
  if (bridgeDisabled || !isWatchableWindow(window) || isOverlayWindow(window) || trackedWindows.has(window)) {
    return;
  }

  trackedWindows.add(window);
  if (isMpvWindow(window)) {
    ensureGeometryWatchers(window);
  }
  if (window.closed) {
    window.closed.connect(function () {
      emitState();
    });
  }
  if (window.windowClassChanged) {
    window.windowClassChanged.connect(function () {
      if (isMpvWindow(window)) {
        ensureGeometryWatchers(window);
      }
      emitState();
    });
  }
  if (window.windowShown) {
    window.windowShown.connect(function () {
      emitState();
    });
  }
  if (window.windowHidden) {
    window.windowHidden.connect(function () {
      emitState();
    });
  }
}

function refresh() {
  if (bridgeDisabled) {
    return;
  }

  for (const window of workspace.windowList()) {
    watchWindow(window);
  }
  emitState();
}

workspace.windowAdded.connect(function (window) {
  watchWindow(window);
  emitState();
});
workspace.windowRemoved.connect(function () {
  emitState();
});
workspace.screensChanged.connect(function () {
  emitState();
});

refresh();
`;
}

export class KWinWindowTracker extends BaseWindowTracker {
  private readonly targetMpvSocketPath: string | null;
  private readonly serviceName: string;
  private readonly pluginName: string;
  private readonly bridgeInterface: KWinTrackerBridgeInterface;
  private tempDir: string | null = null;
  private scriptPath: string | null = null;
  private bus: MessageBus | null = null;
  private scriptId: number | null = null;
  private unloadScriptKey: string | null = null;
  private readonly commandLineCache = new Map<
    number,
    { expiresAt: number; value: string | null }
  >();
  private stopped = false;

  constructor(targetMpvSocketPath?: string) {
    super();
    const instanceToken = createKWinTrackerInstanceToken();
    this.targetMpvSocketPath = targetMpvSocketPath?.trim() || null;
    this.serviceName = buildKWinTrackerServiceName(instanceToken);
    this.pluginName = buildKWinTrackerPluginName(instanceToken);
    this.bridgeInterface = new KWinTrackerBridgeInterface((payload) => this.handleUpdate(payload));
  }

  override hasAuthoritativeFocus(): boolean {
    return false;
  }

  override shouldAutoFocusVisibleOverlay(): boolean {
    return false;
  }

  start(): void {
    this.stopped = false;
    void this.startAsync();
  }

  stop(): void {
    this.stopped = true;
    void this.stopAsync();
  }

  private async startAsync(): Promise<void> {
    try {
      const scriptPath = this.ensureScriptWorkspace();
      const targetMpvPid = this.resolveTargetMpvPid();
      fs.writeFileSync(
        scriptPath,
        buildKWinBridgeScript(this.serviceName, targetMpvPid, this.targetMpvSocketPath !== null),
        'utf-8',
      );
      const bus = dbus.sessionBus();
      bus.on('error', (error) => {
        log.error('KWin session bus error:', (error as Error).message);
      });
      this.bus = bus;
      await bus.requestName(this.serviceName, 0);
      bus.export(BRIDGE_OBJECT_PATH, this.bridgeInterface);

      const loadedScript = await this.loadScript(bus, scriptPath, this.pluginName);
      this.scriptId = loadedScript.scriptId;
      this.unloadScriptKey = loadedScript.unloadKey;
      await this.runScript(bus, loadedScript.scriptId);

      if (this.stopped) {
        await this.stopAsync();
      }
    } catch (error) {
      log.error('Failed to start KWin window tracker:', (error as Error).message);
      this.updateGeometry(null);
      await this.stopAsync();
    }
  }

  private async stopAsync(): Promise<void> {
    const bus = this.bus;
    const scriptId = this.scriptId;
    const unloadScriptKey = this.unloadScriptKey;
    const tempDir = this.tempDir;
    this.scriptId = null;
    this.bus = null;
    this.unloadScriptKey = null;
    this.tempDir = null;
    this.scriptPath = null;
    this.commandLineCache.clear();

    if (bus && scriptId !== null) {
      try {
        await this.stopScript(bus, scriptId);
      } catch {
        // ignore
      }
    }

    if (bus && unloadScriptKey) {
      try {
        await this.unloadScript(bus, unloadScriptKey);
      } catch {
        // ignore
      }
    }

    if (bus) {
      try {
        bus.unexport(BRIDGE_OBJECT_PATH, this.bridgeInterface);
      } catch {
        // ignore
      }

      try {
        await bus.releaseName(this.serviceName);
      } catch {
        // ignore
      }

      bus.disconnect();
    }

    try {
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  private handleUpdate(payload: string): void {
    const parsed = this.parsePayload(payload);
    if (!parsed) {
      this.updateGeometry(null);
      return;
    }

    if (parsed.degraded === true || parsed.selectionBlocked === true) {
      this.updateGeometry(null);
      return;
    }

    const windows = Array.isArray(parsed.windows)
      ? parsed.windows.filter(isKWinWindowCandidate)
      : [];
    const compactWindow = isKWinWindowCandidate(parsed.window) ? parsed.window : null;
    let targetWindow: KWinWindow | null = null;
    if (windows.length > 0) {
      targetWindow = selectKWinMpvWindow(windows, {
        targetMpvSocketPath: this.targetMpvSocketPath,
        getWindowCommandLine: (pid) => this.getWindowCommandLine(pid),
      });
    }

    if (!targetWindow && !this.targetMpvSocketPath && compactWindow) {
      targetWindow = compactWindow;
    }

    if (
      !targetWindow ||
      targetWindow.normalWindow === false ||
      !isVisibleKWinWindow(targetWindow) ||
      !hasValidGeometry(targetWindow)
    ) {
      this.updateGeometry(null);
      return;
    }

    this.updateFocus(targetWindow.active === true);
    this.updateGeometry({
      x: targetWindow.x ?? 0,
      y: targetWindow.y ?? 0,
      width: targetWindow.width ?? 0,
      height: targetWindow.height ?? 0,
    });
  }

  private parsePayload(payload: string): KWinUpdatePayload | null {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed as KWinUpdatePayload;
    } catch {
      return null;
    }
  }

  private getWindowCommandLine(pid: number): string | null {
    const cached = this.commandLineCache.get(pid);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const commandLine = this.readProcessCommandLine(pid);
    this.commandLineCache.set(pid, {
      expiresAt: now + COMMAND_LINE_CACHE_TTL_MS,
      value: commandLine,
    });
    return commandLine;
  }

  private resolveTargetMpvPid(): number | null {
    if (!this.targetMpvSocketPath) {
      return null;
    }

    try {
      const output = execFileSync('ps', ['-eo', 'pid='], {
        encoding: 'utf-8',
      });
      for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const pid = Number.parseInt(line, 10);
        if (!Number.isInteger(pid) || pid <= 0) {
          continue;
        }
        const commandLine = this.readProcessCommandLine(pid);
        if (commandLine && matchesTargetSocket(commandLine, this.targetMpvSocketPath)) {
          return pid;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private readProcessCommandLine(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    const safePid = String(pid);
    if (process.platform === 'linux') {
      try {
        const commandLine = fs
          .readFileSync(`/proc/${safePid}/cmdline`, 'utf-8')
          .replace(/\0+$/, '');
        return commandLine || null;
      } catch {
        // fall through to ps for environments without /proc access
      }
    }

    try {
      const commandLine = execFileSync('ps', ['-p', safePid, '-o', 'args='], {
        encoding: 'utf-8',
      }).trim();
      return commandLine || null;
    } catch {
      return null;
    }
  }

  private ensureScriptWorkspace(): string {
    if (!this.tempDir || !this.scriptPath) {
      this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subminer-kwin-'));
      this.scriptPath = path.join(this.tempDir, 'main.js');
    }

    return this.scriptPath;
  }

  private async loadScript(
    bus: MessageBus,
    filePath: string,
    pluginName: string,
  ): Promise<KWinLoadedScript> {
    try {
      const scriptId = await this.callMethod<number>(bus, {
        path: KWIN_SCRIPTING_PATH,
        interfaceName: KWIN_SCRIPTING_INTERFACE,
        member: 'loadScript',
        signature: 'ss',
        body: [filePath, pluginName],
      });
      return { scriptId, unloadKey: pluginName };
    } catch (error) {
      if (!shouldRetryUnnamedLoadScript(error)) {
        throw error;
      }

      log.warn('KWin named loadScript overload failed; retrying unnamed loadScript call.');
      const scriptId = await this.callMethod<number>(bus, {
        path: KWIN_SCRIPTING_PATH,
        interfaceName: KWIN_SCRIPTING_INTERFACE,
        member: 'loadScript',
        signature: 's',
        body: [filePath],
      });
      return { scriptId, unloadKey: filePath };
    }
  }

  private async unloadScript(bus: MessageBus, pluginName: string): Promise<boolean> {
    return this.callMethod<boolean>(bus, {
      path: KWIN_SCRIPTING_PATH,
      interfaceName: KWIN_SCRIPTING_INTERFACE,
      member: 'unloadScript',
      signature: 's',
      body: [pluginName],
    });
  }

  private async runScript(bus: MessageBus, scriptId: number): Promise<void> {
    await this.callMethod<void>(bus, {
      path: `${KWIN_SCRIPTING_PATH}/Script${scriptId}`,
      interfaceName: KWIN_SCRIPT_INTERFACE,
      member: 'run',
    });
  }

  private async stopScript(bus: MessageBus, scriptId: number): Promise<void> {
    await this.callMethod<void>(bus, {
      path: `${KWIN_SCRIPTING_PATH}/Script${scriptId}`,
      interfaceName: KWIN_SCRIPT_INTERFACE,
      member: 'stop',
    });
  }

  private async callMethod<T>(
    bus: MessageBus,
    options: {
      path: string;
      interfaceName: string;
      member: string;
      signature?: string;
      body?: unknown[];
    },
  ): Promise<T> {
    const reply = await bus.call(
      new dbus.Message({
        destination: KWIN_SERVICE_NAME,
        path: options.path,
        interface: options.interfaceName,
        member: options.member,
        signature: options.signature ?? '',
        body: options.body ?? [],
      }),
    );

    if (!reply) {
      throw new Error(`No reply received from ${options.interfaceName}.${options.member}`);
    }

    const values = (reply.body ?? []) as T[];
    if (values.length === 0 && options.signature) {
      throw new Error(`Empty reply body from ${options.interfaceName}.${options.member}`);
    }
    return values[0] as T;
  }
}
