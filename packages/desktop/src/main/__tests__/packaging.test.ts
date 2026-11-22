// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Debian package's launcher entry offers New Window (#1599, design §5.1):
 * a right-click on the launcher icon starts the installed executable with
 * `--new-window`, named in each language the product ships.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { Configuration } from "electron-builder";

import { NEW_WINDOW_ARG } from "@desktop/main/new-window.js";
import { desktopText } from "@desktop/main/strings.js";

const CONFIG = join(import.meta.dirname, "..", "..", "..", "electron-builder.config.mjs");

describe("electron-builder configuration", () => {
  it("gives the Debian launcher entry a New Window action in every language", async () => {
    const { default: config } = (await import(CONFIG)) as { default: Configuration };
    const desktop = config.deb?.desktop;
    expect(desktop?.entry?.Actions).toBe("NewWindow;");
    expect(desktop?.desktopActions?.NewWindow).toEqual({
      Name: desktopText("en")["desktop.menu.newWindow"],
      "Name[zh_CN]": desktopText("zh-CN")["desktop.menu.newWindow"],
      "Name[zh_TW]": desktopText("zh-TW")["desktop.menu.newWindow"],
      "Name[ja]": desktopText("ja")["desktop.menu.newWindow"],
      "Name[ko]": desktopText("ko")["desktop.menu.newWindow"],
      Exec: `/opt/breatic/breatic ${NEW_WINDOW_ARG}`,
    });
  });
});
