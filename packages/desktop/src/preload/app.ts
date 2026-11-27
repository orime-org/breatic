// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The app window's preload: the few calls the web app may make into the
 * client (inner#2041: sign-in and the download list), and `retry` for the
 * "can't reach" page the client writes into Chromium's error entry (design
 * 5.3). The main process checks every sign-in and download call comes from
 * the server's origin and every retry from that window's error entry.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { BrowserSignInResult, DesktopBridge, DesktopDownloadList } from "@breatic/shared";

const bridge: DesktopBridge & { retry(automatic?: boolean): Promise<void> } = {
  platform: process.platform,
  retry: (automatic) => ipcRenderer.invoke("unreachable:retry", automatic) as Promise<void>,
  signInWithBrowser: (referralCode) => ipcRenderer.invoke("sign-in:start", referralCode) as Promise<void>,
  cancelBrowserSignIn: () => ipcRenderer.invoke("sign-in:cancel") as Promise<void>,
  isBrowserSignInPending: () => ipcRenderer.invoke("sign-in:pending") as Promise<boolean>,
  takeBrowserSignInResult: () => ipcRenderer.invoke("sign-in:take") as Promise<BrowserSignInResult | null>,
  onBrowserSignInResult: (listener) => {
    /**
     * Forward the client's notice to the page's listener.
     * @returns Nothing.
     */
    const handler = (): void => listener();
    ipcRenderer.on("sign-in:arrived", handler);
    return () => {
      ipcRenderer.removeListener("sign-in:arrived", handler);
    };
  },
  listDownloads: () => ipcRenderer.invoke("download:list") as Promise<DesktopDownloadList>,
  onDownloadsChanged: (listener) => {
    /**
     * Forward the client's notice to the page's listener.
     * @returns Nothing.
     */
    const handler = (): void => listener();
    ipcRenderer.on("download:changed", handler);
    return () => {
      ipcRenderer.removeListener("download:changed", handler);
    };
  },
  dismissDownloads: () => ipcRenderer.invoke("download:dismiss") as Promise<void>,
  revealDownload: (id) => ipcRenderer.invoke("download:reveal", id) as Promise<void>,
};

contextBridge.exposeInMainWorld("breaticDesktop", bridge);
