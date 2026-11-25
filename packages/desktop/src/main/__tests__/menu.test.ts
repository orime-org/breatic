// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The client's menu (inner#2041, design §6.1). The standard roles keep copy, paste
 * and undo working in the page's fields on macOS; Back and Forward let a user
 * return from a page with no way back, such as a Stripe invoice. There is
 * no way to switch servers: a build opens the server it carries. New Window
 * sits in the File menu on every platform and in the macOS Dock menu.
 */

import { describe, it, expect, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

import { buildDockMenuTemplate, buildMenuTemplate, type MenuLabels } from "@desktop/main/menu.js";

const labels: MenuLabels = { back: "Back", forward: "Forward", file: "File", newWindow: "New Window" };
/** Actions the tests do not watch. */
const quiet = { onBack: vi.fn(), onForward: vi.fn(), onNewWindow: vi.fn() };

/**
 * Every item of a template, submenus included.
 * @param items - The template.
 */
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

describe("buildMenuTemplate", () => {
  it("gives macOS an app menu and the standard Edit roles", () => {
    const template = buildMenuTemplate({ platform: "darwin", isDev: false, labels, ...quiet });
    expect(template[0]?.role).toBe("appMenu");
    const items = flatten(template);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(items.some((item) => item.role === role), role).toBe(true);
    }
  });

  it("offers no way to switch servers: a build opens the server it carries", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const items = flatten(buildMenuTemplate({ platform, isDev: false, labels, ...quiet }));
      const ownItems = items.filter((item) => item.click).map((item) => item.label);
      expect(ownItems, platform).toEqual(["New Window", "Back", "Forward"]);
    }
  });

  it.each([
    ["darwin", "CmdOrCtrl+[", "CmdOrCtrl+]"],
    ["win32", "Alt+Left", "Alt+Right"],
    ["linux", "Alt+Left", "Alt+Right"],
  ])("binds Back and Forward on %s", (platform, back, forward) => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const items = flatten(buildMenuTemplate({ platform, isDev: false, labels, ...quiet, onBack, onForward }));
    expect(items.find((item) => item.label === "Back")?.accelerator).toBe(back);
    expect(items.find((item) => item.label === "Forward")?.accelerator).toBe(forward);
    items.find((item) => item.label === "Back")?.click?.({} as never, undefined, {});
    expect(onBack).toHaveBeenCalledOnce();
    expect(onForward).not.toHaveBeenCalled();
    items.find((item) => item.label === "Forward")?.click?.({} as never, undefined, {});
    expect(onForward).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32", "linux"])("offers New Window in the File menu on %s", (platform) => {
    const onNewWindow = vi.fn();
    const template = buildMenuTemplate({ platform, isDev: false, labels, ...quiet, onNewWindow });
    const file = template.find((menu) => menu.label === "File");
    const item = (file?.submenu as MenuItemConstructorOptions[] | undefined)?.find((entry) => entry.label === "New Window");
    expect(item?.accelerator).toBe("CmdOrCtrl+Shift+N");
    item?.click?.({} as never, undefined, {});
    expect(onNewWindow).toHaveBeenCalledOnce();
  });

  it("keeps Quit in the File menu on Windows and Linux and in the app menu on macOS", () => {
    const fileItems = (platform: string) =>
      (buildMenuTemplate({ platform, isDev: false, labels, ...quiet }).find((menu) => menu.label === "File")?.submenu ?? []) as MenuItemConstructorOptions[];
    expect(fileItems("win32").some((item) => item.role === "quit")).toBe(true);
    expect(fileItems("darwin").some((item) => item.role === "quit")).toBe(false);
    expect(flatten(buildMenuTemplate({ platform: "darwin", isDev: false, labels, ...quiet }).slice(0, 1)).some((item) => item.role === "quit")).toBe(true);
  });

  it("offers developer tools only in development", () => {
    const shipped = flatten(buildMenuTemplate({ platform: "darwin", isDev: false, labels, ...quiet }));
    const dev = flatten(buildMenuTemplate({ platform: "darwin", isDev: true, labels, ...quiet }));
    expect(shipped.some((item) => item.role === "toggleDevTools")).toBe(false);
    expect(dev.some((item) => item.role === "toggleDevTools")).toBe(true);
  });
});

describe("buildDockMenuTemplate", () => {
  it("offers New Window from the macOS Dock icon", () => {
    const onNewWindow = vi.fn();
    const template = buildDockMenuTemplate({ labels, onNewWindow });
    expect(template.map((item) => item.label)).toEqual(["New Window"]);
    template[0]?.click?.({} as never, undefined, {});
    expect(onNewWindow).toHaveBeenCalledOnce();
  });
});

describe("Check for Updates", () => {
  const withUpdates = { ...labels, checkForUpdates: "Check for Updates…", help: "Help" };

  it("is absent from a build without an update feed", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const items = flatten(buildMenuTemplate({ platform, isDev: false, labels: withUpdates, ...quiet }));
      expect(items.some((item) => item.label === "Check for Updates…"), platform).toBe(false);
      expect(items.some((item) => item.label === "Help"), platform).toBe(false);
    }
  });

  it("sits in the app menu on macOS", () => {
    const onCheckForUpdates = vi.fn();
    const template = buildMenuTemplate({ platform: "darwin", isDev: false, labels: withUpdates, ...quiet, onCheckForUpdates });
    const item = flatten(template.slice(0, 1)).find((entry) => entry.label === "Check for Updates…");
    item?.click?.({} as never, undefined, {});
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
  });

  it.each(["win32", "linux"])("sits in a Help menu on %s", (platform) => {
    const onCheckForUpdates = vi.fn();
    const template = buildMenuTemplate({ platform, isDev: false, labels: withUpdates, ...quiet, onCheckForUpdates });
    const help = template.find((menu) => menu.label === "Help");
    const item = (help?.submenu as MenuItemConstructorOptions[] | undefined)?.find((entry) => entry.label === "Check for Updates…");
    item?.click?.({} as never, undefined, {});
    expect(onCheckForUpdates).toHaveBeenCalledOnce();
  });
});
