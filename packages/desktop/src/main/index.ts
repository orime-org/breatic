// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The desktop client's main process (#1599): windows on the chosen server's
 * web app, a local connect window to choose that server, Google sign-in
 * through the system browser and the navigation rules that keep each window
 * on the app.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBrowserSignIn } from "@desktop/main/browser-sign-in.js";
import type { ConnectAnswer, ConnectInitial, ConnectReason } from "@desktop/main/connect-protocol.js";
import { BRAND } from "@desktop/main/brand.js";
import { appImageDesktopEntry, findDeepLink } from "@desktop/main/deep-link.js";
import { createLogger } from "@desktop/main/logger.js";
import { buildDockMenuTemplate, buildMenuTemplate } from "@desktop/main/menu.js";
import { nextWindowBounds, wantsNewWindow, windowsUserTasks } from "@desktop/main/new-window.js";
import { splashCloseDelay, splashQuery } from "@desktop/main/splash.js";
import { createUpdates } from "@desktop/main/updates.js";
import { decideNavigation, decideWindowOpen, isCertificateError, isServerLoadFailure, loadFailureReason } from "@desktop/main/navigation.js";
import { activateAction, quitsWhenConnectCloses } from "@desktop/main/window-policy.js";
import { checkServer, normalizeServerUrl, readServerConfig, resolveServerUrl, writeServerConfig } from "@desktop/main/server-config.js";
import { desktopText } from "@desktop/main/strings.js";

/** The server the build carries (brand.json, or BREATIC_DEFAULT_SERVER_URL at build time); empty asks on first launch. */
const DEFAULT_SERVER_URL = BRAND.serverUrl;
/** How long a code the browser handed back stays usable, counted from when it arrived; the server's handoff code lives as long (`config/auth.yaml`). */
const SIGN_IN_TTL_MS = 5 * 60_000;
/** Permissions the web app asks for; every other request is refused. */
const ALLOWED_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "notifications", "fullscreen", "media"]);

const here = __dirname;
/**
 * Where the chosen server is kept.
 * @returns The path of `config.json` in the app's data directory.
 */
const configFile = (): string => join(app.getPath("userData"), "config.json");
/**
 * Where the last closed window's size and place are kept.
 * @returns The path of `window-state.json` in the app's data directory.
 */
const windowStateFile = (): string => join(app.getPath("userData"), "window-state.json");
const isDev = !app.isPackaged;

/** False in a second launch: it hands its arguments to the first instance (second-instance) and ends. */
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

const logger = createLogger(app.getPath("logs"), BRAND.id);
const signIn = createBrowserSignIn({ openExternal: (url) => shell.openExternal(url), now: () => Date.now(), ttlMs: SIGN_IN_TTL_MS, scheme: BRAND.scheme });

let serverOrigin: string | null = null;
/** The server this client opens (environment, saved or built in); Dock and relaunch come back to it. */
let boundServer = "";
/** The app windows, least recently used first. */
let appWindows: BrowserWindow[] = [];
/** App windows that have shown the server at least once. */
const loadedWindows = new WeakSet<BrowserWindow>();
/** App windows hidden after the server stopped answering; Retry loads them all again. */
const failedWindows = new WeakSet<BrowserWindow>();
/** What every app window runs with, the ones the page opens included. */
const APP_WEB_PREFERENCES = { preload: join(here, "../preload/app.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false };
let connectWindow: BrowserWindow | null = null;
let connectInitial: ConnectInitial | null = null;
let queuedLink: string | null = null;
let splashWindow: BrowserWindow | null = null;
/** Resolves with the time the splash appeared (or was closed before it could). */
let splashShown: Promise<number> = Promise.resolve(0);
/** Callbacks waiting to hear that a window's leave confirmation answered Stay. */
const stayListeners = new Map<WebContents, () => void>();
/** A packaged build with an update feed: electron-builder wrote app-update.yml beside the app. */
const updatesEnabled = app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml"));
const updates = createUpdates({
  updater: electronUpdater.autoUpdater,
  enabled: updatesEnabled,
  every: (task, ms) => void setInterval(task, ms),
  ask: askToRestart,
  tell: tellUpdateOutcome,
  closeAllWindows,
  log: (err) => logger.error({ err }, "update_failed"),
});

// macOS hands a link that launched the app to `open-url` before `ready`.
app.on("will-finish-launching", () => {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleLink(url);
  });
});

app.on("second-instance", (_event, argv) => {
  const link = findDeepLink(argv, BRAND.scheme);
  if (link) handleLink(link);
  else if (wantsNewWindow(argv)) openNewWindow();
  else showSomeWindow();
});

app.on("activate", () => showSomeWindow());

app.on("window-all-closed", () => {
  // Restart now quits through the updater once every window has closed.
  if (updates.isRestarting()) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("web-contents-created", (_event, contents) => attachPolicies(contents));

if (primary) void app.whenReady().then(start).catch((err: unknown) => {
  logger.error({ err }, "desktop_start_failed");
  dialog.showErrorBox(BRAND.productName, err instanceof Error ? err.message : String(err));
  app.quit();
});

/**
 * Start: register the scheme, build the menu, open the configured server or
 * the connect window.
 * @throws {Error} if `BREATIC_SERVER_URL` is an address the client refuses.
 */
async function start(): Promise<void> {
  registerScheme();
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  registerIpc();
  buildMenu();
  openSplash();
  updates.start();
  const resolved = resolveServerUrl({
    // A packaged build opens the server it carries; the override is for development.
    envUrl: isDev ? process.env.BREATIC_SERVER_URL : undefined,
    savedUrl: readServerConfig(configFile()),
    builtInUrl: DEFAULT_SERVER_URL,
  });
  boundServer = resolved ?? "";
  if (resolved) {
    const answer = await openServer(resolved, { save: false });
    if (!answer.ok) openConnect({ mode: "unreachable", url: resolved, reason: answer.reason });
  } else {
    openConnect({ mode: "connect", url: DEFAULT_SERVER_URL, reason: null });
  }
  const link = queuedLink ?? findDeepLink(process.argv, BRAND.scheme);
  queuedLink = null;
  if (link) handleLink(link);
}

/** Register the build's scheme for this executable; an AppImage also writes its own desktop entry. */
function registerScheme(): void {
  if (process.platform === "linux" && process.env.APPIMAGE) {
    try {
      const dir = join(homedir(), ".local", "share", "applications");
      mkdirSync(dir, { recursive: true });
      const entry = BRAND.appImageEntryName;
      writeFileSync(join(dir, entry), appImageDesktopEntry(process.env.APPIMAGE, BRAND));
      execFile("xdg-mime", ["default", entry, `x-scheme-handler/${BRAND.scheme}`], (err) => {
        if (err) logger.error({ err }, "appimage_scheme_registration_failed");
      });
    } catch (err) {
      logger.error({ err }, "appimage_scheme_registration_failed");
    }
    return;
  }
  if (isDev && process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(BRAND.scheme, process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient(BRAND.scheme);
  }
}

/** Build the menu, the Dock menu and the taskbar task in the operating system's language. */
function buildMenu(): void {
  const text = desktopText(app.getLocale(), BRAND.productName);
  const labels = {
    file: text["desktop.menu.file"],
    back: text["desktop.menu.back"],
    forward: text["desktop.menu.forward"],
    newWindow: text["desktop.menu.newWindow"],
    checkForUpdates: text["desktop.menu.checkForUpdates"],
    help: text["desktop.menu.help"],
  };
  const template = buildMenuTemplate({
    platform: process.platform,
    isDev,
    labels,
    onNewWindow: openNewWindow,
    ...(updatesEnabled ? { onCheckForUpdates: () => void updates.checkNow() } : {}),
    onBack: () => {
      const history = BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
      if (history?.canGoBack()) history.goBack();
    },
    onForward: () => {
      const history = BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
      if (history?.canGoForward()) history.goForward();
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.dock?.setMenu(Menu.buildFromTemplate(buildDockMenuTemplate({ labels, onNewWindow: openNewWindow })));
  if (process.platform === "win32") app.setUserTasks(windowsUserTasks(process.execPath, labels.newWindow));
}

/**
 * Whether an IPC call came from a page of the server the client opened.
 * @param event - The call.
 * @returns True for the server's origin.
 */
function fromServer(event: IpcMainInvokeEvent): boolean {
  return serverOrigin !== null && event.senderFrame?.origin === serverOrigin;
}

/**
 * Whether an IPC call came from the connect window.
 * @param event - The call.
 * @returns True for the connect window's own page.
 */
function fromConnectWindow(event: IpcMainInvokeEvent): boolean {
  return connectWindow !== null && event.sender === connectWindow.webContents;
}

/** The calls the two preloads make. */
function registerIpc(): void {
  ipcMain.handle("sign-in:start", async (event, referralCode: unknown) => {
    if (!fromServer(event) || !serverOrigin) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    await signIn.start({ windowId: window?.id ?? -1, serverOrigin, referralCode: typeof referralCode === "string" && referralCode ? referralCode : null });
  });
  ipcMain.handle("sign-in:cancel", (event) => {
    if (fromServer(event)) signIn.cancel();
  });
  ipcMain.handle("sign-in:pending", (event) => fromServer(event) && signIn.isPending());
  ipcMain.handle("sign-in:take", (event) => (fromServer(event) ? signIn.take() : null));
  ipcMain.handle("connect:initial", (event) => (fromConnectWindow(event) ? connectInitial : null));
  ipcMain.handle("connect:connect", async (event, url: unknown): Promise<ConnectAnswer | null> => {
    if (!fromConnectWindow(event) || typeof url !== "string") return null;
    return connect(url);
  });
}

/**
 * Check an address and open it, from the connect window.
 * @param input - The address as typed.
 * @returns Whether the client now shows that server.
 */
async function connect(input: string): Promise<ConnectAnswer> {
  const normalized = normalizeServerUrl(input);
  if (!normalized.ok) return { ok: false, reason: "scheme" };
  const checked = await checkServer(normalized.origin, (url, init) => net.fetch(url, init));
  if (!checked.ok) return checked;
  return openServer(checked.origin, { save: true });
}

/**
 * Load a server's app in the app window that could not show it, or a new one.
 * The address is saved only once the window is really on it: a load the user
 * cancels from the leave dialog keeps the old server.
 * @param origin - The server.
 * @param options - Whether to save it as the server to open next time.
 * @param options.save - Save on success.
 * @returns Whether the window now shows the server, or why not.
 */
async function openServer(origin: string, options: { save: boolean }): Promise<ConnectAnswer> {
  const window = appWindows.findLast((other) => failedWindows.has(other)) ?? createAppWindow();
  const previous = serverOrigin;
  serverOrigin = origin;
  try {
    await window.loadURL(`${origin}/studio`);
  } catch (err) {
    serverOrigin = previous;
    const reason = loadFailureReason((err as { errno?: number }).errno ?? 0);
    if (reason !== "cancelled") logger.error({ err, origin }, "server_load_failed");
    return { ok: false, reason };
  }
  if (options.save) writeServerConfig(configFile(), origin);
  boundServer = origin;
  failedWindows.delete(window);
  loadedWindows.add(window);
  await finishSplash();
  window.show();
  connectWindow?.close();
  // The other windows that lost the server come back with it.
  for (const other of appWindows.filter((candidate) => failedWindows.has(candidate))) {
    void other.loadURL(`${origin}/studio`).then(
      () => {
        failedWindows.delete(other);
        other.show();
      },
      (err: unknown) => logger.error({ err, origin }, "server_load_failed"),
    );
  }
  return { ok: true };
}

/**
 * Open another app window on the server (menu, Dock menu, taskbar task). With
 * no server shown yet, bring the connect window forward instead.
 */
function openNewWindow(): void {
  if (connectWindow || !serverOrigin) {
    showSomeWindow();
    return;
  }
  const origin = serverOrigin;
  const window = createAppWindow();
  void window.loadURL(`${origin}/studio`).then(
    () => {
      loadedWindows.add(window);
      window.show();
    },
    (err: unknown) => {
      logger.error({ err, origin }, "server_load_failed");
      window.close();
      const reason = loadFailureReason((err as { errno?: number }).errno ?? 0);
      openConnect({ mode: "unreachable", url: origin, reason: reason === "cancelled" ? "unreachable" : reason });
    },
  );
}

/**
 * Create an app window, hidden until a server loads, a step down and right of
 * the window in use.
 * @returns The window.
 */
function createAppWindow(): BrowserWindow {
  const current = appWindows.at(-1);
  const window = new BrowserWindow({
    ...nextWindowBounds(current ? current.getBounds() : null, readWindowState()),
    show: false,
    title: BRAND.productName,
    webPreferences: APP_WEB_PREFERENCES,
  });
  track(window);
  return window;
}

/**
 * Keep an app window in the list: its place in the use order, its size on
 * close, and the can't-reach state when the server stops answering. Every app
 * window goes through here, the ones the page opens with window.open included.
 * @param window - The window.
 */
function track(window: BrowserWindow): void {
  window.on("close", () => saveWindowState(window));
  window.on("focus", () => {
    appWindows = [...appWindows.filter((other) => other !== window), window];
  });
  window.on("closed", () => {
    appWindows = appWindows.filter((other) => other !== window);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
    if (!loadedWindows.has(window) || !serverOrigin || !isServerLoadFailure({ url, serverOrigin, isMainFrame, errorCode })) return;
    logger.error({ errorCode, url }, "server_unreachable");
    failedWindows.add(window);
    window.hide();
    openConnect({ mode: "unreachable", url: serverOrigin, reason: isCertificateError(errorCode) ? "certificate" : "unreachable" });
  });
  appWindows = [...appWindows, window];
}

/**
 * Open (or refocus) the connect window in a state.
 * @param initial - What the window shows first.
 * @param initial.mode - Connect or cannot reach.
 * @param initial.url - The address to show.
 * @param initial.reason - Why the last attempt failed.
 */
function openConnect(initial: { mode: "connect" | "unreachable"; url: string; reason: ConnectReason | null }): void {
  const lang = app.getLocale();
  connectInitial = { ...initial, lang, product: BRAND.productName, text: desktopText(lang, BRAND.productName) };
  if (connectWindow) {
    void connectWindow.webContents.reload();
    connectWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 480,
    height: 420,
    resizable: false,
    show: false,
    title: BRAND.productName,
    webPreferences: {
      preload: join(here, "../connect/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.on("closed", () => {
    connectWindow = null;
    // Nothing else is on screen: on Windows and Linux closing it ends the app; macOS keeps the app in the Dock.
    if (quitsWhenConnectCloses({ platform: process.platform, visibleWindow: recentLoadedWindow() !== null })) app.quit();
  });
  void window.loadFile(join(here, "../connect/index.html"));
  connectWindow = window;
  void finishSplash().then(() => {
    if (!window.isDestroyed()) window.show();
  });
}

/** Show the splash at launch: the brand's logo and name, and on a partner's brand the attribution (design §5.2). */
function openSplash(): void {
  const window = new BrowserWindow({
    width: 420,
    height: 280,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    title: BRAND.productName,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splashShown = new Promise((resolve) => {
    window.once("ready-to-show", () => {
      window.show();
      resolve(Date.now());
    });
    window.once("closed", () => resolve(0));
  });
  window.on("closed", () => {
    if (splashWindow === window) splashWindow = null;
  });
  void window.loadFile(join(here, "../splash/index.html"), { query: splashQuery(BRAND) });
  splashWindow = window;
}

/** Close the splash once it has shown long enough; nothing to do when it is gone. */
async function finishSplash(): Promise<void> {
  const window = splashWindow;
  if (!window) return;
  // The minimum counts from when the splash is on screen, not from when it was created.
  const wait = splashCloseDelay(await splashShown, Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (!window.isDestroyed()) window.close();
}

/**
 * Close every window through its normal path, so each page's leave
 * confirmation runs (Restart now, design §9.1.2).
 * @returns True when all closed; false when a page's user chose Stay.
 */
async function closeAllWindows(): Promise<boolean> {
  // One at a time: once a page's user chooses Stay, the others stay open and are not asked.
  for (const window of BrowserWindow.getAllWindows()) {
    const closed = await new Promise<boolean>((resolve) => {
      const contents = window.webContents;
      window.once("closed", () => {
        stayListeners.delete(contents);
        resolve(true);
      });
      stayListeners.set(contents, () => {
        stayListeners.delete(contents);
        resolve(false);
      });
      window.close();
    });
    if (!closed) return false;
  }
  return true;
}

/**
 * Offer a downloaded version.
 * @param version - The version ready to install.
 * @returns Restart now or later.
 */
async function askToRestart(version: string): Promise<"restart" | "later"> {
  const text = desktopText(app.getLocale(), BRAND.productName);
  const owner = BrowserWindow.getFocusedWindow();
  const options = {
    type: "info" as const,
    buttons: [text["desktop.updates.restart"], text["desktop.updates.later"]],
    defaultId: 0,
    cancelId: 1,
    message: text["desktop.updates.ready"].replaceAll("{version}", version),
    detail: text["desktop.updates.readyDetail"],
  };
  const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return response === 0 ? "restart" : "later";
}

/**
 * Tell the user how a check they asked for ended.
 * @param outcome - Nothing new, or the check failed.
 */
function tellUpdateOutcome(outcome: "upToDate" | "failed"): void {
  const text = desktopText(app.getLocale(), BRAND.productName);
  const options = {
    type: outcome === "failed" ? ("error" as const) : ("info" as const),
    message: outcome === "failed" ? text["desktop.updates.failed"] : text["desktop.updates.upToDate"],
  };
  const owner = BrowserWindow.getFocusedWindow();
  void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
}

/**
 * Bring a window forward: the connect window while it is open, else the most
 * recently used app window, else a new app window on the server; with no
 * server yet, the connect window.
 */
function showSomeWindow(): void {
  const recent = recentLoadedWindow();
  const action = activateAction({
    connectOpen: connectWindow !== null,
    visibleWindow: recent !== null,
    loadingWindow: appWindows.some((window) => !loadedWindows.has(window) && !failedWindows.has(window)),
    server: serverOrigin,
    boundServer,
  });
  if (action === "focus-connect") connectWindow?.focus();
  else if (action === "focus-window" && recent) bringForward(recent);
  else if (action === "new-window") openNewWindow();
  else if (action === "unreachable") openConnect({ mode: "unreachable", url: boundServer, reason: null });
  else if (action === "connect") openConnect({ mode: "connect", url: DEFAULT_SERVER_URL, reason: null });
}

/**
 * The most recently used app window that shows the server.
 * @returns The window, or null when none is open.
 */
function recentLoadedWindow(): BrowserWindow | null {
  return appWindows.findLast((window) => loadedWindows.has(window) && !failedWindows.has(window)) ?? null;
}

/**
 * Restore, show and focus a window.
 * @param window - The window.
 */
function bringForward(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * Take a link on the build's scheme from the system.
 * @param link - The link.
 */
function handleLink(link: string): void {
  if (!app.isReady()) {
    queuedLink = link;
    return;
  }
  const received = signIn.receive(link);
  if (!received.accepted) {
    logger.warn({ link: link.split("?")[0] }, "deep_link_ignored");
    showSomeWindow();
    return;
  }
  const target = BrowserWindow.fromId(received.windowId) ?? recentLoadedWindow();
  if (!target) return;
  bringForward(target);
  target.webContents.send("sign-in:arrived");
}

/**
 * Apply the navigation, window, download and leave rules to a page.
 * @param contents - The page.
 */
function attachPolicies(contents: WebContents): void {
  contents.on("will-navigate", (details) => {
    if (contents === connectWindow?.webContents || contents === splashWindow?.webContents) {
      details.preventDefault();
      return;
    }
    applyNavigation(details.url, contents, () => details.preventDefault());
  });
  contents.on("will-redirect", (details) => {
    if (!details.isMainFrame) return;
    applyNavigation(details.url, contents, () => details.preventDefault());
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!serverOrigin || contents === connectWindow?.webContents) return { action: "deny" };
    const decision = decideWindowOpen({ url, serverOrigin });
    if (decision === "download") contents.downloadURL(url);
    if (decision === "external") void shell.openExternal(url);
    if (decision !== "window") return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: { webPreferences: APP_WEB_PREFERENCES },
    };
  });
  contents.on("did-create-window", (window) => {
    track(window);
    loadedWindows.add(window);
  });
  contents.on("will-prevent-unload", (event) => {
    const text = desktopText(app.getLocale(), BRAND.productName);
    const owner = BrowserWindow.fromWebContents(contents);
    const options = {
      type: "question" as const,
      buttons: [text["desktop.leave.leave"], text["desktop.leave.stay"]],
      defaultId: 1,
      cancelId: 1,
      message: text["desktop.leave.message"],
    };
    const choice = owner ? dialog.showMessageBoxSync(owner, options) : dialog.showMessageBoxSync(options);
    // preventDefault lets the page go, ignoring its beforeunload.
    if (choice === 0) event.preventDefault();
    else stayListeners.get(contents)?.();
  });
}

/**
 * Keep, hand off or drop a main-frame navigation.
 * @param url - Where it goes.
 * @param contents - The page navigating.
 * @param cancel - Stops the navigation.
 */
function applyNavigation(url: string, contents: WebContents, cancel: () => void): void {
  if (!serverOrigin) return;
  const decision = decideNavigation({ url, currentUrl: contents.getURL(), serverOrigin });
  if (decision === "allow") return;
  cancel();
  if (decision === "external") void shell.openExternal(url);
}

/**
 * The size and place the last closed app window had.
 * @returns Bounds for the window, or a default size.
 */
function readWindowState(): { width: number; height: number; x?: number; y?: number } {
  try {
    if (existsSync(windowStateFile())) {
      const saved = JSON.parse(readFileSync(windowStateFile(), "utf-8")) as { width?: unknown; height?: unknown; x?: unknown; y?: unknown };
      if (typeof saved.width === "number" && typeof saved.height === "number") {
        return {
          width: saved.width,
          height: saved.height,
          ...(typeof saved.x === "number" && typeof saved.y === "number" ? { x: saved.x, y: saved.y } : {}),
        };
      }
    }
  } catch (err) {
    logger.error({ err }, "window_state_read_failed");
  }
  return { width: 1440, height: 900 };
}

/**
 * Remember an app window's size and place as it closes.
 * @param window - The window closing.
 */
function saveWindowState(window: BrowserWindow): void {
  try {
    writeFileSync(windowStateFile(), JSON.stringify(window.getNormalBounds()));
  } catch (err) {
    logger.error({ err }, "window_state_write_failed");
  }
}
