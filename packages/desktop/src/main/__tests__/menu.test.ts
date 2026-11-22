// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client's menu (#1599, design §6.1). The standard roles keep copy, paste
 * and undo working in the page's fields on macOS; Back and Forward let a user
 * return from a page with no way back, such as a Stripe invoice. There is
 * no way to switch servers: a build opens the server it carries. Switch
 * server reopens the connect window.
 */

import { describe, it, expect, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

import { buildMenuTemplate, type MenuLabels } from "@desktop/main/menu.js";

const labels: MenuLabels = { back: "Back", forward: "Forward", file: "File" };

/**
 * Every item of a template, submenus included.
 * @param items - The template.
 */
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

describe("buildMenuTemplate", () => {
  it("gives macOS an app menu and the standard Edit roles", () => {
    const template = buildMenuTemplate({ platform: "darwin", isDev: false, labels, onBack: vi.fn(), onForward: vi.fn() });
    expect(template[0]?.role).toBe("appMenu");
    const items = flatten(template);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      expect(items.some((item) => item.role === role), role).toBe(true);
    }
  });

  it("offers no way to switch servers: a build opens the server it carries", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      const items = flatten(buildMenuTemplate({ platform, isDev: false, labels, onBack: vi.fn(), onForward: vi.fn() }));
      const ownItems = items.filter((item) => item.click).map((item) => item.label);
      expect(ownItems, platform).toEqual(["Back", "Forward"]);
    }
  });

  it.each([
    ["darwin", "CmdOrCtrl+[", "CmdOrCtrl+]"],
    ["win32", "Alt+Left", "Alt+Right"],
    ["linux", "Alt+Left", "Alt+Right"],
  ])("binds Back and Forward on %s", (platform, back, forward) => {
    const onBack = vi.fn();
    const items = flatten(buildMenuTemplate({ platform, isDev: false, labels, onBack, onForward: vi.fn() }));
    expect(items.find((item) => item.label === "Back")?.accelerator).toBe(back);
    expect(items.find((item) => item.label === "Forward")?.accelerator).toBe(forward);
    items.find((item) => item.label === "Back")?.click?.({} as never, undefined, {});
    expect(onBack).toHaveBeenCalled();
  });

  it("offers developer tools only in development", () => {
    const shipped = flatten(buildMenuTemplate({ platform: "darwin", isDev: false, labels, onBack: vi.fn(), onForward: vi.fn() }));
    const dev = flatten(buildMenuTemplate({ platform: "darwin", isDev: true, labels, onBack: vi.fn(), onForward: vi.fn() }));
    expect(shipped.some((item) => item.role === "toggleDevTools")).toBe(false);
    expect(dev.some((item) => item.role === "toggleDevTools")).toBe(true);
  });
});
