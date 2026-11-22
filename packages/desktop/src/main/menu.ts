// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client's menu (#1599, design §6.1).
 *
 * On macOS a custom menu without the Edit roles leaves Cmd+C, V and Z dead in
 * every field of the page, so the standard role menus stay. The client has no
 * address bar, so Back and Forward are here, with the browsers' shortcuts.
 */

import type { MenuItemConstructorOptions } from "electron";

/** The menu's own words, in the user's language. */
export interface MenuLabels {
  back: string;
  forward: string;
  file: string;
}

/** What the menu is built from. */
export interface MenuOptions {
  platform: string;
  isDev: boolean;
  labels: MenuLabels;
  onBack: () => void;
  onForward: () => void;
}

/**
 * Build the menu template.
 * @param options - Platform, labels and actions.
 * @returns The template for `Menu.buildFromTemplate`.
 */
export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const { platform, isDev, labels } = options;
  const mac = platform === "darwin";
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
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      edit,
      view,
      { role: "windowMenu" },
    ];
  }
  return [
    { label: labels.file, submenu: [{ role: "quit" }] },
    edit,
    view,
    { role: "windowMenu" },
  ];
}
