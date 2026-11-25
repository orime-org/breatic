// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The client's menu (inner#2041, design §6.3).
 *
 * On macOS a custom menu without the Edit roles leaves Cmd+C, V and Z dead in
 * every field of the page, so the standard role menus stay. The client has no
 * address bar, so Back and Forward are here, with the browsers' shortcuts.
 * New Window is in File on every platform and in the macOS Dock menu (§5.1).
 */

import type { MenuItemConstructorOptions } from "electron";

/** The menu's own words, in the user's language. */
export interface MenuLabels {
  back: string;
  forward: string;
  file: string;
  newWindow: string;
  checkForUpdates?: string;
  help?: string;
}

/** What the menu is built from. */
export interface MenuOptions {
  platform: string;
  isDev: boolean;
  labels: MenuLabels;
  onBack: () => void;
  onForward: () => void;
  onNewWindow: () => void;
  /** Present only in a build with an update feed (design §9.1.2). */
  onCheckForUpdates?: () => void;
}

/**
 * Build the menu template.
 * @param options - Platform, labels and actions.
 * @returns The template for `Menu.buildFromTemplate`.
 */
export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const { platform, isDev, labels } = options;
  const mac = platform === "darwin";
  const newWindow: MenuItemConstructorOptions = { label: labels.newWindow, accelerator: "CmdOrCtrl+Shift+N", click: () => options.onNewWindow() };
  const onCheck = options.onCheckForUpdates;
  const checkForUpdates: MenuItemConstructorOptions[] = onCheck ? [{ label: labels.checkForUpdates, click: () => onCheck() }] : [];
  const view: MenuItemConstructorOptions = {
    role: "viewMenu",
    submenu: [
      { label: labels.back, accelerator: mac ? "CmdOrCtrl+[" : "Alt+Left", click: () => options.onBack() },
      { label: labels.forward, accelerator: mac ? "CmdOrCtrl+]" : "Alt+Right", click: () => options.onForward() },
      { type: "separator" },
      { role: "reload" },
      ...(isDev ? ([{ role: "toggleDevTools" }] satisfies MenuItemConstructorOptions[]) : []),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const edit: MenuItemConstructorOptions = { role: "editMenu" , submenu: [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  ] };
  if (mac) {
    return [
      {
        role: "appMenu",
        submenu: [
          { role: "about" },
          ...checkForUpdates,
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { label: labels.file, submenu: [newWindow] },
      edit,
      view,
      { role: "windowMenu" },
    ];
  }
  return [
    { label: labels.file, submenu: [newWindow, { type: "separator" }, { role: "quit" }] },
    edit,
    view,
    { role: "windowMenu" },
    ...(checkForUpdates.length > 0 ? [{ label: labels.help, submenu: checkForUpdates }] : []),
  ];
}

/**
 * The macOS Dock icon's menu.
 * @param options - Labels and the New Window action.
 * @param options.labels - The menu's words.
 * @param options.onNewWindow - Opens a window.
 * @returns The template for `app.dock.setMenu`.
 */
export function buildDockMenuTemplate(options: Pick<MenuOptions, "labels" | "onNewWindow">): MenuItemConstructorOptions[] {
  return [{ label: options.labels.newWindow, click: () => options.onNewWindow() }];
}
