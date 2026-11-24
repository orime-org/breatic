// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The desktop client's main process (inner#2041): windows on the server the build
 * carries, the "can't reach" page in the window that failed, Google sign-in
 * through the system browser, the navigation rules that keep each window on
 * the app, and the shell's error monitoring.
 */

import * as Sentry from "@sentry/electron/main";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent, type MessageBoxOptions, type MessageBoxReturnValue, type WebContents } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBrowserSignIn } from "@desktop/main/browser-sign-in.js";
import { BRAND } from "@desktop/main/brand.js";
import { BUILD } from "@desktop/main/build-info.js";
import { appImageDesktopEntry, findDeepLink } from "@desktop/main/deep-link.js";
import { desktopSentryOptions, keepsIntegration, scrubBreadcrumb, scrubEvent } from "@desktop/main/error-monitoring.js";
import { createLogger } from "@desktop/main/logger.js";
import { buildDockMenuTemplate, buildMenuTemplate } from "@desktop/main/menu.js";
import { appCommandDirection, decideNavigation, decideWindowOpen, stepHistory } from "@desktop/main/navigation.js";
import { nextWindowBounds, wantsNewWindow, windowsUserTasks } from "@desktop/main/new-window.js";
import { resolveServerUrl } from "@desktop/main/server-config.js";
import { SPLASH_MAX_MS, splashQuery, untilSplashMayClose } from "@desktop/main/splash.js";
import { desktopText, type DesktopText } from "@desktop/main/strings.js";
import { createLoadTracker, isErrorEntry, redirectAway, type LoadTracker, type ShownUnreachable } from "@desktop/main/unreachable.js";
import { createUpdates, isFeedUnreachable } from "@desktop/main/updates.js";
import { unreachableScript } from "@desktop/unreachable/render.js";

/** How long a code the browser handed back stays usable, counted from when it arrived; the server's handoff code lives as long (`config/auth.yaml`). */
const SIGN_IN_TTL_MS = 5 * 60_000;
/** Permissions the web app asks for; every other request is refused. */
const ALLOWED_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "notifications", "fullscreen", "media"]);
/** How long Restart now waits for pending reports, as the server's `FLUSH_TIMEOUT_MS`. */
const FLUSH_TIMEOUT_MS = 2_000;

const isDev = !app.isPackaged;

// First, before anything can fail: the shell's error monitoring (design 9.4).
const sentryOptions = desktopSentryOptions({ dsn: BUILD.sentryDsn, brandId: BRAND.id, packaged: app.isPackaged, commit: BUILD.commit });
if (sentryOptions) {
  const home = app.getPath("home");
  Sentry.init({
    ...sentryOptions,
    integrations: (defaults) => [
      ...defaults.filter((integration) => keepsIntegration(integration.name)),
      Sentry.pinoIntegration({ log: { levels: [] }, error: { levels: ["error", "fatal"] } }),
    ],
    beforeSend: (event) => scrubEvent(event, home),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb, home),
  });
}

const here = __dirname;
/**
 * Where the last closed window's size and place are kept.
 * @returns The path of `window-state.json` in the app's data directory.
 */
const windowStateFile = (): string => join(app.getPath("userData"), "window-state.json");

/** False in a second launch: it hands its arguments to the first instance (second-instance) and ends. */
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

const logger = createLogger(app.getPath("logs"), BRAND.id);
const signIn = createBrowserSignIn({ openExternal: (url) => shell.openExternal(url), now: () => Date.now(), ttlMs: SIGN_IN_TTL_MS, scheme: BRAND.scheme });

/** An app window and its loads. */
interface AppWindow {
  window: BrowserWindow;
  tracker: LoadTracker;
}

/** The server this build opens; set first thing in start(). */
let serverOrigin = "";
/** The app windows, least recently used first. */
let appWindows: BrowserWindow[] = [];
/** Each app window's loads, by its web contents id. */
const loads = new Map<number, LoadTracker>();
/** The shell's text in the operating system's language; set first thing in start(). */
let text: DesktopText;
/** What every app window runs with, the ones the page opens included. */
const APP_WEB_PREFERENCES = { preload: join(here, "../preload/app.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false };
let queuedLink: string | null = null;
let splashWindow: BrowserWindow | null = null;
/** Resolves with the time the splash appeared. */
let splashShown: Promise<number> = new Promise(() => undefined);
/** After this time a splash that has not appeared is given up. */
let splashDeadline = 0;
/** Whether the first app window is on screen; until then Dock clicks and relaunches bring the splash forward. */
let firstShown = false;
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
  flushReports: async () => {
    await Sentry.flush(FLUSH_TIMEOUT_MS);
  },
  // The feed being unreachable is the user's network: a warning, not a report.
  log: (err) => logger[isFeedUnreachable(err) ? "warn" : "error"]({ err }, "update_failed"),
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

// The only way the app ends on Windows and Linux; Restart now quits through the updater instead.
app.on("window-all-closed", () => {
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
 * Start: register the scheme, build the menu, show the splash and open the
 * first window on the server, shown when the splash closes.
 * @throws {Error} if `BREATIC_SERVER_URL` is an address the client refuses.
 */
function start(): void {
  // A packaged build opens the server it carries; the override is for development.
  serverOrigin = resolveServerUrl({ envUrl: isDev ? process.env.BREATIC_SERVER_URL : undefined, builtInUrl: BRAND.serverUrl });
  text = desktopText(app.getLocale(), BRAND.productName);
  registerScheme();
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  cancelRedirectsAway();
  registerIpc();
  buildMenu();
  openSplash();
  updates.start();
  const first = openAppWindow({ show: false });
  let revealed = false;
  /** Close the splash and show the first window, once: its first load ended, or the splash reached its longest. */
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    void finishSplash().then(() => {
      firstShown = true;
      if (!first.window.isDestroyed()) first.window.show();
    });
  };
  first.tracker.onFirstLoad(reveal);
  setTimeout(reveal, SPLASH_MAX_MS);
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

/**
 * Cancel a main-issued server load that the server redirects out of the
 * window (another origin, or a page of the server outside the app): Chromium
 * then commits an error entry at the server address, and the window shows
 * "can't reach" with where it went (design 5.1). Only the server's
 * main-frame responses pass through the main process.
 */
function cancelRedirectsAway(): void {
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${serverOrigin}/*`], types: ["mainFrame"] }, (details, callback) => {
    const tracker = details.webContentsId === undefined ? undefined : loads.get(details.webContentsId);
    const location = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "location")?.[1]?.[0];
    const target = tracker ? redirectAway({ statusCode: details.statusCode, location, serverOrigin, mainLoadInFlight: tracker.mainLoadInFlight() }) : null;
    if (tracker && target) {
      tracker.redirectCancelled(target);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
}

/** Build the menu, the Dock menu and the taskbar task in the operating system's language. */
function buildMenu(): void {
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
    onBack: () => stepHistory(BrowserWindow.getFocusedWindow()?.webContents.navigationHistory, "back"),
    onForward: () => stepHistory(BrowserWindow.getFocusedWindow()?.webContents.navigationHistory, "forward"),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.dock?.setMenu(Menu.buildFromTemplate(buildDockMenuTemplate({ labels, onNewWindow: openNewWindow })));
  if (process.platform === "win32") app.setUserTasks(windowsUserTasks(process.execPath, labels.newWindow));
}

/**
 * Whether an IPC call came from a page of the server.
 * @param event - The call.
 * @returns True for the server's origin.
 */
function fromServer(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.origin === serverOrigin;
}

/** The calls the app preload makes. */
function registerIpc(): void {
  ipcMain.handle("sign-in:start", async (event, referralCode: unknown) => {
    if (!fromServer(event)) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    await signIn.start({ windowId: window?.id ?? -1, serverOrigin, referralCode: typeof referralCode === "string" && referralCode ? referralCode : null });
  });
  ipcMain.handle("sign-in:cancel", (event) => {
    if (fromServer(event)) signIn.cancel();
  });
  ipcMain.handle("sign-in:pending", (event) => fromServer(event) && signIn.isPending());
  ipcMain.handle("sign-in:take", (event) => (fromServer(event) ? signIn.take() : null));
  ipcMain.handle("unreachable:retry", (event, automatic: unknown) => {
    const frame = event.senderFrame;
    if (frame) loads.get(event.sender.id)?.retryAsked({ isMainFrame: frame.parent === null, origin: frame.origin, url: frame.url }, automatic === true);
  });
}

/** Open another app window on the server (menu, Dock menu, taskbar task, `--new-window`), on screen at once. */
function openNewWindow(): void {
  openAppWindow({ show: true });
}

/**
 * Create an app window a step down and right of the window in use, and load the server in it.
 * @param options - Whether it shows at once; the first window waits for the splash.
 * @param options.show - Show it now.
 * @returns The window and its loads.
 */
function openAppWindow(options: { show: boolean }): AppWindow {
  const current = appWindows.at(-1);
  const window = new BrowserWindow({
    ...nextWindowBounds(current ? current.getBounds() : null, readWindowState()),
    show: options.show,
    // What a browser's new tab shows while the page loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111113" : "#f4f4f5",
    title: BRAND.productName,
    webPreferences: APP_WEB_PREFERENCES,
  });
  const tracker = track(window);
  tracker.mainLoadStarted();
  // The outcome is read from the load events, which also see loads the page starts itself.
  window.loadURL(`${serverOrigin}/studio`).catch((err: unknown) => logger.debug({ err }, "server_load_rejected"));
  return { window, tracker };
}

/**
 * Keep an app window in the list and follow its loads: its place in the use
 * order, its size on close, and "can't reach" when a main-frame load of the
 * server fails. Every app window goes through here, the ones the page opens
 * with window.open included.
 * @param window - The window.
 * @returns The window's loads.
 */
function track(window: BrowserWindow): LoadTracker {
  const contents = window.webContents;
  const id = contents.id;
  const tracker = createLoadTracker({
    serverOrigin,
    reload: () => contents.reload(),
    render: (shown, busy) => renderUnreachable(contents, shown, busy),
    log: (level, entry) => logger[level](entry, "server_unreachable"),
  });
  loads.set(id, tracker);
  window.on("close", () => saveWindowState(window));
  window.on("focus", () => {
    appWindows = [...appWindows.filter((other) => other !== window), window];
  });
  window.on("closed", () => {
    tracker.closed();
    loads.delete(id);
    appWindows = appWindows.filter((other) => other !== window);
  });
  contents.on("did-start-navigation", (details) => tracker.navigationStarted(details));
  contents.on("did-fail-provisional-load", (_event, errorCode, _description, url, isMainFrame) => tracker.loadFailed({ url, errorCode, isMainFrame }));
  contents.on("did-navigate", () => tracker.pageCommitted());
  contents.on("did-finish-load", () => tracker.loadFinished());
  contents.on("did-stop-loading", () => tracker.loadStopped());
  if (process.platform === "win32") {
    window.on("app-command", (_event, command) => {
      const direction = appCommandDirection(command);
      if (direction) stepHistory(contents.navigationHistory, direction);
    });
  }
  appWindows = [...appWindows, window];
  return tracker;
}

/**
 * Write "can't reach" into a window's error entry, and only there: the main
 * frame runs it at once, and a frame that is no longer the error entry is left alone.
 * @param contents - The window's page.
 * @param shown - The address that failed and why.
 * @param busy - A retry is in flight.
 */
function renderUnreachable(contents: WebContents, shown: ShownUnreachable, busy: boolean): void {
  const frame = contents.mainFrame;
  if (!isErrorEntry(frame, shown.url)) return;
  const reason =
    shown.reason.kind === "redirected"
      ? text["desktop.unreachable.redirected"].replaceAll("{target}", shown.reason.target)
      : text[`desktop.unreachable.${shown.reason.kind}`];
  const script = unreachableScript({
    lang: app.getLocale(),
    title: text["desktop.unreachable.title"],
    address: shown.url,
    reason,
    retry: text["desktop.unreachable.retry"],
    retrying: text["desktop.unreachable.retrying"],
    busy,
  });
  // A navigation that commits first leaves the frame gone: nothing to draw.
  frame.executeJavaScript(script).catch((err: unknown) => logger.warn({ err }, "unreachable_render_failed"));
}

/** Show the splash at launch: the brand's logo and name, and on a partner's brand the attribution (design 5.2). */
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
  });
  window.on("closed", () => {
    if (splashWindow === window) splashWindow = null;
  });
  void window.loadFile(join(here, "../splash/index.html"), { query: splashQuery(BRAND) });
  splashWindow = window;
  splashDeadline = Date.now() + SPLASH_MAX_MS;
}

/** Close the splash once it has shown long enough, waiting for one not yet on screen up to its longest time. */
async function finishSplash(): Promise<void> {
  const window = splashWindow;
  if (!window) return;
  await untilSplashMayClose(
    { shown: splashShown, deadline: splashDeadline },
    { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  );
  if (!window.isDestroyed()) window.close();
}

/**
 * Close every window through its normal path, so each page's leave
 * confirmation runs (Restart now, design 9.1.2).
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
  const { response } = await showBox({
    type: "info",
    buttons: [text["desktop.updates.restart"], text["desktop.updates.later"]],
    defaultId: 0,
    cancelId: 1,
    message: text["desktop.updates.ready"].replaceAll("{version}", version),
    detail: text["desktop.updates.readyDetail"],
  });
  return response === 0 ? "restart" : "later";
}

/**
 * Tell the user how a check they asked for ended.
 * @param outcome - Nothing new, or the check failed.
 */
function tellUpdateOutcome(outcome: "upToDate" | "failed"): void {
  void showBox({
    type: outcome === "failed" ? "error" : "info",
    message: outcome === "failed" ? text["desktop.updates.failed"] : text["desktop.updates.upToDate"],
  });
}

/**
 * Show a message box on the focused window, or on its own when none is.
 * @param options - The box.
 * @returns The answer.
 */
function showBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const owner = BrowserWindow.getFocusedWindow();
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
}

/**
 * Bring the client forward (Dock click, relaunch): the splash while it shows,
 * else the most recently used app window, else a new one on the server.
 */
function showSomeWindow(): void {
  if (!firstShown) {
    splashWindow?.focus();
    return;
  }
  const recent = appWindows.at(-1);
  if (recent) bringForward(recent);
  else openNewWindow();
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
 * Take a link on the build's scheme from the system. A sign-in result goes to
 * the window that started it, else the most recently used one, else a new
 * window, whose sign-in page takes the result when it loads.
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
  const target = BrowserWindow.fromId(received.windowId) ?? appWindows.at(-1);
  if (!target) {
    openNewWindow();
    return;
  }
  bringForward(target);
  target.webContents.send("sign-in:arrived");
}

/**
 * Apply the navigation, window, download and leave rules to a page.
 * @param contents - The page.
 */
function attachPolicies(contents: WebContents): void {
  contents.on("will-navigate", (details) => {
    if (contents === splashWindow?.webContents) {
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
    if (contents === splashWindow?.webContents) return { action: "deny" };
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
  });
  contents.on("will-prevent-unload", (event) => {
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
