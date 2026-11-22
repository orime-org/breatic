// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Opening another window (#1599, design §5.1). Windows' taskbar and Linux's
 * launcher start the client with `--new-window`; the single-instance lock
 * hands that to the running client. A new window sits a step down and right
 * of the one the user was in.
 */

import { describe, it, expect } from "vitest";

import { NEW_WINDOW_ARG, nextWindowBounds, wantsNewWindow, windowsUserTasks } from "@desktop/main/new-window.js";

describe("wantsNewWindow", () => {
  it("finds the flag among a launch's arguments", () => {
    expect(wantsNewWindow(["C:\\breatic\\breatic.exe", NEW_WINDOW_ARG])).toBe(true);
  });

  it.each([[["/opt/breatic/breatic"]], [["/opt/breatic/breatic", "breatic://sign-in?code=x"]], [["breatic.exe", "--new-window-x"]]])(
    "ignores a launch without it: %j",
    (argv) => {
      expect(wantsNewWindow(argv)).toBe(false);
    },
  );
});

describe("windowsUserTasks", () => {
  it("starts this executable with the flag, under the given name and its own icon", () => {
    expect(windowsUserTasks("C:\\breatic\\breatic.exe", "New Window")).toEqual([
      {
        program: "C:\\breatic\\breatic.exe",
        arguments: NEW_WINDOW_ARG,
        title: "New Window",
        description: "New Window",
        iconPath: "C:\\breatic\\breatic.exe",
        iconIndex: 0,
      },
    ]);
  });
});

describe("nextWindowBounds", () => {
  const saved = { width: 1440, height: 900 };

  it("places the window a step down and right of the one in use, at its size", () => {
    expect(nextWindowBounds({ x: 100, y: 80, width: 1200, height: 800 }, saved)).toEqual({ x: 124, y: 104, width: 1200, height: 800 });
  });

  it("uses the remembered size and place when no window is open", () => {
    expect(nextWindowBounds(null, saved)).toEqual(saved);
  });
});
