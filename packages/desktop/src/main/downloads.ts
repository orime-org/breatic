// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Download feedback (inner#2041, design §7.3.1). The main process keeps this
 * run's download list and whether the Downloads panel is open, so a reload, a
 * trip to Stripe and back or a new window shows the same rows; every server
 * page hears a bare notice and reads the list again, because a notice sent
 * with `webContents.send` and the reply to `ipcRenderer.invoke` travel on
 * different pipes and may arrive in either order. Save paths stay here: a page
 * gets the folder name and asks to reveal a download by its id.
 */

import { posix, win32 } from "node:path";
import type { DesktopDownload, DesktopDownloadList } from "@breatic/shared";

/** The part of Electron's DownloadItem the feedback reads. */
export interface DownloadItemLike {
  getSavePath(): string;
  getReceivedBytes(): number;
  getTotalBytes(): number;
  cancel(): void;
  on(event: "updated", listener: (event: unknown, state: "progressing" | "interrupted") => void): unknown;
  on(event: "done", listener: (event: unknown, state: "completed" | "cancelled" | "interrupted") => void): unknown;
}

/** An app window as the feedback sees it. */
export interface DownloadWindow {
  webContents: { send(channel: string): void; mainFrame: { origin: string } };
  setProgressBar(value: number): void;
}

/** The never-shown window that carries the Dock progress on macOS. */
export interface DockWindow {
  setProgressBar(value: number): void;
  destroy(): void;
}

/** What the feedback needs from the outside. */
export interface DownloadsDeps {
  platform: NodeJS.Platform;
  serverOrigin: string;
  /** The app windows open now. */
  appWindows: () => DownloadWindow[];
  /** Create the hidden window that carries the Dock progress (macOS). */
  openDockWindow: () => DockWindow;
  /** `app.dock.downloadFinished`: bounces the Downloads stack when the file is in it. */
  downloadFinished: (path: string) => void;
  /** `shell.showItemInFolder`. */
  showItemInFolder: (path: string) => void;
}

/** The feedback's operations. */
export interface Downloads {
  /** Follow a download from `will-download`. */
  track(item: DownloadItemLike): void;
  /** This run's downloads, newest first, and whether the panel is open. */
  list(): DesktopDownloadList;
  /** Close the panel: finished rows go, running ones stay. */
  dismiss(): void;
  /** Show a finished download's file in its folder; an unknown id does nothing. */
  reveal(id: string): void;
  /** How many downloads are still running. */
  running(): number;
}

/** A row and where its file went. */
interface Entry {
  row: DesktopDownload;
  savePath: string;
}

/** The value Electron reads as "no progress bar". */
const NO_PROGRESS = -1;
/** The value Windows shows as indeterminate progress. */
const INDETERMINATE = 2;

/**
 * The path rules of a platform.
 * @param platform - The platform.
 * @returns Node's path functions for it.
 */
function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * The folder a saved file sits in: its parent's name, or the root itself.
 * @param path - The save path.
 * @param platform - The platform whose path rules apply.
 * @returns The folder's name, e.g. `Downloads` or `D:\`.
 */
export function folderName(path: string, platform: NodeJS.Platform): string {
  const paths = pathsFor(platform);
  const dir = paths.dirname(path);
  return paths.basename(dir) || dir;
}

/**
 * Create the download feedback.
 * @param deps - Electron APIs.
 * @returns The feedback.
 */
export function createDownloads(deps: DownloadsDeps): Downloads {
  const paths = pathsFor(deps.platform);
  /** Newest first. */
  let entries: Entry[] = [];
  let open = false;
  let seq = 0;
  let dock: DockWindow | null = null;

  /** Tell every server page to read the list again. */
  function notify(): void {
    for (const window of deps.appWindows()) {
      if (window.webContents.mainFrame.origin === deps.serverOrigin) window.webContents.send("download:changed");
    }
  }

  /** Show the running total on the app icon, or clear it. */
  function showProgress(): void {
    const running = entries.flatMap(({ row }) => (row.state === "progressing" ? [row] : []));
    let value = NO_PROGRESS;
    if (running.some((row) => row.total === 0)) value = deps.platform === "win32" ? INDETERMINATE : NO_PROGRESS;
    else if (running.length > 0) value = running.reduce((sum, row) => sum + row.received, 0) / running.reduce((sum, row) => sum + row.total, 0);
    if (deps.platform !== "darwin") {
      for (const window of deps.appWindows()) window.setProgressBar(value);
      return;
    }
    // The Dock progress belongs to the app; downloads go on after the last window closes.
    if (running.length > 0) {
      dock ??= deps.openDockWindow();
      dock.setProgressBar(value);
    } else if (dock) {
      dock.setProgressBar(NO_PROGRESS);
      dock.destroy();
      dock = null;
    }
  }

  /**
   * Put a download's new row in the list, adding it at the top (and opening the panel) the first time.
   * @param id - The download's id.
   * @param savePath - Where it is saved.
   * @param row - Its row now.
   * @param reopen - Open the panel even when the row is already listed.
   */
  function update(id: string, savePath: string, row: DesktopDownload, reopen: boolean): void {
    const entry = entries.find((candidate) => candidate.row.id === id);
    if (entry) entry.row = row;
    else entries = [{ row, savePath }, ...entries];
    if (!entry || reopen) open = true;
    notify();
    showProgress();
  }

  return {
    track(item) {
      const id = String(++seq);
      item.on("updated", (_event, state) => {
        const savePath = item.getSavePath();
        // An empty save path: the save dialog is still open.
        if (!savePath) return;
        // Chromium resumes only a few interruptions and leaves the rest waiting with no `done`; end them as failed.
        if (state === "interrupted") {
          item.cancel();
          return;
        }
        update(id, savePath, { id, name: paths.basename(savePath), state: "progressing", received: item.getReceivedBytes(), total: item.getTotalBytes() }, false);
      });
      item.on("done", (_event, state) => {
        const savePath = item.getSavePath();
        // An empty save path: the user cancelled the save dialog.
        if (!savePath) {
          showProgress();
          return;
        }
        const name = paths.basename(savePath);
        if (state === "completed") {
          if (deps.platform === "darwin") deps.downloadFinished(savePath);
          update(id, savePath, { id, name, state: "completed", folder: folderName(savePath, deps.platform) }, true);
        } else {
          update(id, savePath, { id, name, state: "failed" }, true);
        }
      });
    },
    list() {
      return { open, items: entries.map(({ row }) => ({ ...row })) };
    },
    dismiss() {
      entries = entries.filter(({ row }) => row.state === "progressing");
      open = false;
      notify();
    },
    reveal(id) {
      const entry = entries.find(({ row }) => row.id === id && row.state === "completed");
      if (entry) deps.showItemInFolder(entry.savePath);
    },
    running() {
      return entries.filter(({ row }) => row.state === "progressing").length;
    },
  };
}

/** The download calls a page makes, by channel. */
export interface DownloadIpcHandlers {
  "download:list": (event: unknown) => DesktopDownloadList | undefined;
  "download:dismiss": (event: unknown) => void;
  "download:reveal": (event: unknown, id: unknown) => void;
}

/**
 * The download calls a page makes; each answers only the server's pages.
 * @param downloads - The feedback.
 * @param fromServer - Whether a call came from the server's origin.
 * @returns The handlers, for `ipcMain.handle`.
 */
export function downloadIpcHandlers(downloads: Downloads, fromServer: (event: unknown) => boolean): DownloadIpcHandlers {
  return {
    "download:list": (event) => (fromServer(event) ? downloads.list() : undefined),
    "download:dismiss": (event) => {
      if (fromServer(event)) downloads.dismiss();
    },
    "download:reveal": (event, id) => {
      if (fromServer(event) && typeof id === "string") downloads.reveal(id);
    },
  };
}
