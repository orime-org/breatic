// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The desktop client's main process (#1599): one window on the chosen
 * server's web app, a local connect window to choose that server, Google
 * sign-in through the system browser and the navigation rules that keep the
 * window on the app.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBrowserSignIn } from "@desktop/main/browser-sign-in.js";
import type { ConnectAnswer, ConnectInitial, ConnectReason } from "@desktop/main/connect-protocol.js";
import { appImageDesktopEntry, DEEP_LINK_SCHEME, findDeepLink } from "@desktop/main/deep-link.js";
import { createLogger } from "@desktop/main/logger.js";
import { buildMenuTemplate } from "@desktop/main/menu.js";
import { decideNavigation, decideWindowOpen, isCertificateError, isServerLoadFailure } from "@desktop/main/navigation.js";
import { checkServer, normalizeServerUrl, readServerConfig, resolveServerUrl, writeServerConfig } from "@desktop/main/server-config.js";
import { desktopText } from "@desktop/main/strings.js";

/**
 * The server a build opens on first launch, with no question asked. Which host
 * a build talks to is a deployment decision, so it is injected at build time
 * from `BREATIC_DEFAULT_SERVER_URL`; a build without one asks the user.
 */
declare const __DEFAULT_SERVER_URL__: string;
const DEFAULT_SERVER_URL = __DEFAULT_SERVER_URL__;
/** How long a browser sign-in waits; the server's handoff code lives as long (`config/auth.yaml`). */
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
 * Where the main window's size and place are kept.
 * @returns The path of `window-state.json` in the app's data directory.
 */
const windowStateFile = (): string => join(app.getPath("userData"), "window-state.json");
const isDev = !app.isPackaged;

if (!app.requestSingleInstanceLock()) app.quit();

const logger = createLogger(app.getPath("logs"));
const signIn = createBrowserSignIn({ openExternal: (url) => shell.openExternal(url), now: () => Date.now(), ttlMs: SIGN_IN_TTL_MS });

let serverOrigin: string | null = null;
let mainWindow: BrowserWindow | null = null;
let mainLoaded = false;
let connectWindow: BrowserWindow | null = null;
let connectInitial: ConnectInitial | null = null;
let queuedLink: string | null = null;

// macOS hands a link that launched the app to `open-url` before `ready`.
app.on("will-finish-launching", () => {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleLink(url);
  });
});

app.on("second-instance", (_event, argv) => {
  const link = findDeepLink(argv);
  if (link) handleLink(link);
  else showSomeWindow();
});

app.on("activate", () => showSomeWindow());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("web-contents-created", (_event, contents) => attachPolicies(contents));

void app.whenReady().then(start).catch((err: unknown) => {
  logger.error({ err }, "desktop_start_failed");
  dialog.showErrorBox("breatic", err instanceof Error ? err.message : String(err));
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
  session.defaultSession.on("will-download", () => {
    // No save path: Electron shows the system save dialog.
  });
  registerIpc();
  buildMenu();
  const resolved = resolveServerUrl({
    envUrl: process.env.BREATIC_SERVER_URL,
    savedUrl: readServerConfig(configFile()),
    builtInUrl: DEFAULT_SERVER_URL,
  });
  if (resolved) {
    const answer = await openServer(resolved.origin, { save: false });
    if (!answer.ok) openConnect({ mode: "unreachable", url: resolved.origin, reason: answer.reason });
  } else {
    openConnect({ mode: "connect", url: DEFAULT_SERVER_URL, reason: null });
  }
  const link = queuedLink ?? findDeepLink(process.argv);
  queuedLink = null;
  if (link) handleLink(link);
}

/** Register `breatic://` for this executable; an AppImage also writes its own desktop entry. */
function registerScheme(): void {
  if (process.platform === "linux" && process.env.APPIMAGE) {
    try {
      const dir = join(homedir(), ".local", "share", "applications");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "breatic-appimage.desktop"), appImageDesktopEntry(process.env.APPIMAGE));
      execFile("xdg-mime", ["default", "breatic-appimage.desktop", `x-scheme-handler/${DEEP_LINK_SCHEME}`], (err) => {
        if (err) logger.error({ err }, "appimage_scheme_registration_failed");
      });
    } catch (err) {
      logger.error({ err }, "appimage_scheme_registration_failed");
    }
    return;
  }
  if (isDev && process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}

/** Build the menu in the operating system's language. */
function buildMenu(): void {
  const text = desktopText(app.getLocale());
  const template = buildMenuTemplate({
    platform: process.platform,
    isDev,
    labels: {
      file: text["desktop.menu.file"],
      switchServer: text["desktop.menu.switchServer"],
      back: text["desktop.menu.back"],
      forward: text["desktop.menu.forward"],
    },
    onSwitchServer: () => openConnect({ mode: "connect", url: serverOrigin ?? DEFAULT_SERVER_URL, reason: null }),
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
 * Load a server's app in the main window. The address is saved only once the
 * window is really on it: a load the user cancels from the leave dialog keeps
 * the old server.
 * @param origin - The server.
 * @param options - Whether to save it as the server to open next time.
 * @param options.save - Save on success.
 * @returns Whether the window now shows the server, or why not.
 */
async function openServer(origin: string, options: { save: boolean }): Promise<ConnectAnswer> {
  const window = mainWindow ?? createMainWindow();
  const previous = serverOrigin;
  serverOrigin = origin;
  try {
    await window.loadURL(`${origin}/studio`);
  } catch (err) {
    serverOrigin = previous;
    const code = (err as { errno?: number }).errno ?? 0;
    if (code === -3) return { ok: false, reason: "cancelled" };
    logger.error({ err, origin }, "server_load_failed");
    return { ok: false, reason: isCertificateError(code) ? "certificate" : "unreachable" };
  }
  if (options.save) writeServerConfig(configFile(), origin);
  mainLoaded = true;
  window.show();
  connectWindow?.close();
  return { ok: true };
}

/**
 * Create the main window, hidden until a server loads.
 * @returns The window.
 */
function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...readWindowState(),
    show: false,
    title: "breatic",
    webPreferences: {
      preload: join(here, "../preload/app.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.on("close", () => saveWindowState(window));
  window.on("closed", () => {
    mainWindow = null;
    mainLoaded = false;
  });
  window.webContents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
    if (!mainLoaded || !serverOrigin || !isServerLoadFailure({ url, serverOrigin, isMainFrame, errorCode })) return;
    logger.error({ errorCode, url }, "server_unreachable");
    window.hide();
    openConnect({ mode: "unreachable", url: serverOrigin, reason: isCertificateError(errorCode) ? "certificate" : "unreachable" });
  });
  mainWindow = window;
  return window;
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
  connectInitial = { ...initial, lang, text: desktopText(lang) };
  if (connectWindow) {
    void connectWindow.webContents.reload();
    connectWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 480,
    height: 420,
    resizable: false,
    title: "breatic",
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
    if (!mainLoaded && process.platform !== "darwin") app.quit();
  });
  void window.loadFile(join(here, "../connect/index.html"));
  connectWindow = window;
}

/** Bring a visible window forward: the main window once a server loaded, otherwise the connect window. */
function showSomeWindow(): void {
  if (mainWindow && mainLoaded) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (connectWindow) {
    connectWindow.focus();
    return;
  }
  openConnect({ mode: "connect", url: serverOrigin ?? DEFAULT_SERVER_URL, reason: null });
}

/**
 * Take a `breatic://` link from the system.
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
  const target = BrowserWindow.fromId(received.windowId) ?? mainWindow;
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  target.webContents.send("sign-in:arrived");
}

/**
 * Apply the navigation, window, download and leave rules to a page.
 * @param contents - The page.
 */
function attachPolicies(contents: WebContents): void {
  contents.on("will-navigate", (details) => {
    if (contents === connectWindow?.webContents) {
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
      overrideBrowserWindowOptions: {
        webPreferences: { preload: join(here, "../preload/app.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
      },
    };
  });
  contents.on("will-prevent-unload", (event) => {
    const text = desktopText(app.getLocale());
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
 * The size and place the main window had when it last closed.
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
 * Remember the main window's size and place.
 * @param window - The window closing.
 */
function saveWindowState(window: BrowserWindow): void {
  try {
    writeFileSync(windowStateFile(), JSON.stringify(window.getNormalBounds()));
  } catch (err) {
    logger.error({ err }, "window_state_write_failed");
  }
}
