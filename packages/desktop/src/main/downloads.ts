// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** Download feedback (inner#2041, design §7.3.1). */

import type { DesktopDownloadList } from "@breatic/shared";

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

/** The window that carries the Dock progress on macOS. */
export interface DockWindow {
  setProgressBar(value: number): void;
  destroy(): void;
}

/** What the feedback needs from the outside. */
export interface DownloadsDeps {
  platform: NodeJS.Platform;
  serverOrigin: string;
  appWindows: () => DownloadWindow[];
  openDockWindow: () => DockWindow;
  downloadFinished: (path: string) => void;
  showItemInFolder: (path: string) => void;
}

/** The feedback's operations. */
export interface Downloads {
  track(item: DownloadItemLike): void;
  list(): DesktopDownloadList;
  dismiss(): void;
  reveal(id: string): void;
  running(): number;
}

/**
 * Create the download feedback.
 * @param _deps - Electron APIs.
 * @returns The feedback.
 */
export function createDownloads(_deps: DownloadsDeps): Downloads {
  return { track: () => undefined, list: () => ({ open: false, items: [] }), dismiss: () => undefined, reveal: () => undefined, running: () => 0 };
}

/**
 * The folder a saved file sits in.
 * @param _path - The save path.
 * @param _platform - The platform whose path rules apply.
 * @returns The folder's name.
 */
export function folderName(_path: string, _platform: NodeJS.Platform): string {
  return "";
}

/** The download calls a page makes, by channel. */
export interface DownloadIpcHandlers {
  "download:list": (event: unknown) => DesktopDownloadList | undefined;
  "download:dismiss": (event: unknown) => void;
  "download:reveal": (event: unknown, id: unknown) => void;
}

/**
 * The download calls a page makes.
 * @param _downloads - The feedback.
 * @param _fromServer - Whether a call came from the server's origin.
 * @returns The handlers.
 */
export function downloadIpcHandlers(_downloads: Downloads, _fromServer: (event: unknown) => boolean): DownloadIpcHandlers {
  return { "download:list": () => undefined, "download:dismiss": () => undefined, "download:reveal": () => undefined };
}
