// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The main window's preload: the few calls the web app may make into the
 * client (#1599). The main process checks every call comes from the server's
 * origin.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { BrowserSignInResult, DesktopBridge } from "@breatic/shared";

const bridge: DesktopBridge = {
  platform: process.platform,
  signInWithBrowser: (referralCode) => ipcRenderer.invoke("sign-in:start", referralCode) as Promise<void>,
  cancelBrowserSignIn: () => ipcRenderer.invoke("sign-in:cancel") as Promise<void>,
  isBrowserSignInPending: () => ipcRenderer.invoke("sign-in:pending") as Promise<boolean>,
  takeBrowserSignInResult: () => ipcRenderer.invoke("sign-in:take") as Promise<BrowserSignInResult | null>,
  onBrowserSignInResult: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on("sign-in:arrived", handler);
    return () => {
      ipcRenderer.removeListener("sign-in:arrived", handler);
    };
  },
};

contextBridge.exposeInMainWorld("breaticDesktop", bridge);
