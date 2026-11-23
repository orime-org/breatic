// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The desktop client's main process (#1599): windows on the server the build
 * carries, the "can't reach" page in the window that failed, Google sign-in
 * through the system browser, the navigation rules that keep each window on
 * the app, and the shell's error monitoring.
 */

import * as Sentry from "@sentry/electron/main";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addressWithoutQuery } from "@breatic/shared";
import { createBrowserSignIn } from "@desktop/main/browser-sign-in.js";
import { BRAND } from "@desktop/main/brand.js";
import { BUILD } from "@desktop/main/build-info.js";
import { appImageDesktopEntry, findDeepLink } from "@desktop/main/deep-link.js";
import { desktopSentryOptions, keepsIntegration, scrubBreadcrumb, scrubEvent } from "@desktop/main/error-monitoring.js";
import { createLogger } from "@desktop/main/logger.js";
import { buildDockMenuTemplate, buildMenuTemplate } from "@desktop/main/menu.js";
import { decideNavigation, decideWindowOpen, isCertificateError, isServerLoadFailure } from "@desktop/main/navigation.js";
import { nextWindowBounds, wantsNewWindow, windowsUserTasks } from "@desktop/main/new-window.js";
import { resolveServerUrl } from "@desktop/main/server-config.js";
import { SPLASH_MAX_MS, splashCloseDelay, splashQuery } from "@desktop/main/splash.js";
import { desktopText } from "@desktop/main/strings.js";
import { acceptsRetry, blocksRedirect, createRetryScheduler, isEnvironmentFailure, type RetryScheduler } from "@desktop/main/unreachable.js";
import { createUpdates } from "@desktop/main/updates.js";
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

/** Why a window shows "can't reach" (design 6.2). */
type UnreachableReason = { kind: "unreachable" } | { kind: "certificate" } | { kind: "redirected"; target: string };

/** One app window's loads and its "can't reach" state (design 5.3). */
interface WindowLoad {
  window: BrowserWindow;
  scheduler: RetryScheduler;
  /** The address that failed and why, while the window shows "can't reach". */
  shown: { url: string; reason: UnreachableReason } | null;
  /** A main-frame failure of the current navigation, waiting for its error entry to finish loading. */
  failure: { url: string; reason: UnreachableReason } | null;
  /** The main process is loading the server here: start, new window, reopen, retry, or Reload on the error entry. */
  mainLoad: boolean;
  /** The current navigation has ended in success or failure. */
  settled: boolean;
  /** Where the current main load was redirected when that redirect was cancelled. */
  redirectTarget: string | null;
  /** Runs once when the window's first load ends; the first window waits on it to close the splash. */
  onFirstLoad: (() => void) | null;
}

/** The server this build opens; set first thing in start(). */
let serverOrigin = "";
/** The app windows, least recently used first. */
let appWindows: BrowserWindow[] = [];
/** Each app window's loads, by its web contents id. */
const loads = new Map<number, WindowLoad>();
/** What every app window runs with, the ones the page opens included. */
const APP_WEB_PREFERENCES = { preload: join(here, "../preload/app.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false };
let queuedLink: string | null = null;
let splashWindow: BrowserWindow | null = null;
/** When the splash appeared, or null while it has not. */
let splashShownAt: number | null = null;
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
  log: (err) => logger.warn({ err }, "update_failed"),
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
  first.onFirstLoad = reveal;
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
 * Cancel a main-issued server load that the server redirects to another
 * origin (Stripe aside): Chromium then commits an error entry at the server
 * address, and the window shows "can't reach" with where it went (design 5.1).
 */
function cancelRedirectsAway(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const load = details.webContentsId === undefined ? undefined : loads.get(details.webContentsId);
    const location = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === "location")?.[1]?.[0];
    if (load && location && blocksRedirect({ resourceType: details.resourceType, statusCode: details.statusCode, location, serverOrigin, mainLoadInFlight: load.mainLoad })) {
      load.redirectTarget = addressWithoutQuery(new URL(location, serverOrigin).href);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
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
  ipcMain.handle("unreachable:retry", (event) => {
    const load = loads.get(event.sender.id);
    const frame = event.senderFrame;
    if (!load || !frame) return;
    if (acceptsRetry({ isMainFrame: frame.parent === null, origin: frame.origin, url: frame.url, recordedUrl: load.shown?.url ?? null })) load.scheduler.now();
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
 * @returns The window's loads.
 */
function openAppWindow(options: { show: boolean }): WindowLoad {
  const current = appWindows.at(-1);
  const window = new BrowserWindow({
    ...nextWindowBounds(current ? current.getBounds() : null, readWindowState()),
    show: options.show,
    // What a browser's new tab shows while the page loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111113" : "#f4f4f5",
    title: BRAND.productName,
    webPreferences: APP_WEB_PREFERENCES,
  });
  const load = track(window);
  loadServer(load, `${serverOrigin}/studio`);
  return load;
}

/**
 * Load an address of the server as the main process: a redirect of it to another origin is cancelled.
 * @param load - The window.
 * @param url - The address.
 */
function loadServer(load: WindowLoad, url: string): void {
  load.mainLoad = true;
  load.redirectTarget = null;
  // The outcome is read from the load events, which also see loads the page starts itself.
  load.window.loadURL(url).catch((err: unknown) => logger.debug({ err }, "server_load_rejected"));
}

/**
 * Keep an app window in the list and follow its loads: its place in the use
 * order, its size on close, and "can't reach" when a main-frame load of the
 * server fails. Every app window goes through here, the ones the page opens
 * with window.open included.
 * @param window - The window.
 * @returns The window's loads.
 */
function track(window: BrowserWindow): WindowLoad {
  const contents = window.webContents;
  const id = contents.id;
  const load: WindowLoad = {
    window,
    scheduler: createRetryScheduler(() => retry(load)),
    shown: null,
    failure: null,
    mainLoad: false,
    settled: true,
    redirectTarget: null,
    onFirstLoad: null,
  };
  loads.set(id, load);
  window.on("close", () => saveWindowState(window));
  window.on("focus", () => {
    appWindows = [...appWindows.filter((other) => other !== window), window];
  });
  window.on("closed", () => {
    load.scheduler.clear();
    loads.delete(id);
    appWindows = appWindows.filter((other) => other !== window);
  });
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    load.settled = false;
    if (!load.shown || load.mainLoad) return;
    if (details.url === load.shown.url) {
      // Reload on the error entry (the menu, Cmd+R) is a retry.
      load.scheduler.started();
      load.mainLoad = true;
      load.redirectTarget = null;
      renderUnreachable(load, true);
    } else {
      // Back, Forward or a link: the window leaves the error entry.
      load.shown = null;
      load.scheduler.clear();
    }
  });
  contents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
    if (!isServerLoadFailure({ url, serverOrigin, isMainFrame, errorCode })) return;
    const reason: UnreachableReason = load.redirectTarget
      ? { kind: "redirected", target: load.redirectTarget }
      : isCertificateError(errorCode)
        ? { kind: "certificate" }
        : { kind: "unreachable" };
    load.failure = { url, reason };
    const entry = { errorCode, url: addressWithoutQuery(url) };
    // The user's network and certificates are logged only; anything else is reported.
    if (isEnvironmentFailure(errorCode)) logger.warn(entry, "server_unreachable");
    else logger.error(entry, "server_unreachable");
  });
  contents.on("did-finish-load", () => {
    if (load.failure) {
      // Chromium's error entry for the failure: write "can't reach" into it and schedule the next retry.
      load.shown = load.failure;
      load.failure = null;
      renderUnreachable(load, false);
      load.scheduler.failed();
    } else if (load.shown) {
      load.shown = null;
      if (isServerPage(contents.getURL())) load.scheduler.succeeded();
      else load.scheduler.clear();
    }
    endNavigation(load);
  });
  contents.on("did-stop-loading", () => {
    if (!load.mainLoad || load.settled) return;
    // A retry that neither failed nor showed the server (a 204, a download) counts as failed, so the next one can run.
    if (load.shown) {
      renderUnreachable(load, false);
      load.scheduler.failed();
    }
    endNavigation(load);
  });
  appWindows = [...appWindows, window];
  return load;
}

/**
 * The current navigation has ended.
 * @param load - The window.
 */
function endNavigation(load: WindowLoad): void {
  load.settled = true;
  load.mainLoad = false;
  load.redirectTarget = null;
  const first = load.onFirstLoad;
  load.onFirstLoad = null;
  first?.();
}

/**
 * Whether an address is on the server.
 * @param url - The address.
 * @returns True for the server's origin.
 */
function isServerPage(url: string): boolean {
  try {
    return new URL(url).origin === serverOrigin;
  } catch {
    return false;
  }
}

/**
 * Retry a window's failed address: reload its error entry in place.
 * @param load - The window.
 */
function retry(load: WindowLoad): void {
  load.mainLoad = true;
  load.redirectTarget = null;
  renderUnreachable(load, true);
  load.window.webContents.reload();
}

/**
 * Write "can't reach" into a window's error entry.
 * @param load - The window.
 * @param busy - A retry is in flight.
 */
function renderUnreachable(load: WindowLoad, busy: boolean): void {
  const shown = load.shown;
  if (!shown) return;
  const lang = app.getLocale();
  const text = desktopText(lang, BRAND.productName);
  const reason =
    shown.reason.kind === "redirected"
      ? text["desktop.unreachable.redirected"].replaceAll("{target}", shown.reason.target)
      : text[`desktop.unreachable.${shown.reason.kind}`];
  const script = unreachableScript({
    lang,
    title: text["desktop.unreachable.title"],
    address: shown.url,
    reason,
    retry: text["desktop.unreachable.retry"],
    retrying: text["desktop.unreachable.retrying"],
    busy,
  });
  load.window.webContents.executeJavaScript(script).catch((err: unknown) => logger.error({ err }, "unreachable_render_failed"));
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
  window.once("ready-to-show", () => {
    window.show();
    splashShownAt = Date.now();
  });
  window.on("closed", () => {
    if (splashWindow === window) splashWindow = null;
  });
  void window.loadFile(join(here, "../splash/index.html"), { query: splashQuery(BRAND) });
  splashWindow = window;
}

/** Close the splash once it has shown long enough; at once when it never appeared. */
async function finishSplash(): Promise<void> {
  const window = splashWindow;
  if (!window) return;
  // The minimum counts from when the splash is on screen, not from when it was created.
  const wait = splashShownAt === null ? 0 : splashCloseDelay(splashShownAt, Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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
