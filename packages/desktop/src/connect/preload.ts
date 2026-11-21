// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The connect window's preload (#1599). Only this local page can ask the
 * client to connect to a server; the main window's page cannot.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("breaticConnect", {
  initial: () => ipcRenderer.invoke("connect:initial") as Promise<unknown>,
  connect: (url: string) => ipcRenderer.invoke("connect:connect", url) as Promise<unknown>,
});
