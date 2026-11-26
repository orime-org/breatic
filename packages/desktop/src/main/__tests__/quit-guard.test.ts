// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Asking before quitting with downloads running (inner#2041, design §7.3.1):
 * closing the last window on Windows and Linux, quitting, and Restart now ask
 * once. One "confirmed" state serves all three, so one quit is asked about
 * once however many of them it passes through; a leave confirmation that
 * keeps the app running clears it.
 */

import { describe, it, expect, vi } from "vitest";

import { createQuitGuard, quitDialogText, type QuitGuardDeps } from "@desktop/main/quit-guard.js";
import { desktopText } from "@desktop/main/strings.js";

/** An event whose default can be prevented. */
function event() {
  return { preventDefault: vi.fn() };
}

/**
 * The guard with test doubles.
 * @param over - Dependencies to replace.
 * @returns The guard and its doubles.
 */
function setup(over: Partial<QuitGuardDeps> = {}) {
  const deps: QuitGuardDeps = { platform: "win32", running: () => 2, ask: vi.fn(async () => true), ...over };
  return { guard: createQuitGuard(deps), deps };
}

/** Two app windows. */
const w = { name: "w" };
const other = { name: "other" };

/** Let the answer to a dialog arrive. */
const answered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createQuitGuard", () => {
  it("asks nothing when no download is running", async () => {
    const { guard, deps } = setup({ running: () => 0 });
    const close = event();
    guard.windowClosing(close, { owner: w, appWindows: () => [w], close: vi.fn() });
    const quit = event();
    guard.beforeQuit(quit, vi.fn());
    expect(await guard.confirmRestart()).toBe(true);
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(quit.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("asks when the last window closes on Windows, closes it on Quit, and asks no more during that quit", async () => {
    const { guard, deps } = setup();
    const close = vi.fn();
    const first = event();
    guard.windowClosing(first, { owner: w, appWindows: () => [w], close });
    expect(first.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledWith(2, w);
    await answered();
    expect(close).toHaveBeenCalled();
    const again = event();
    guard.windowClosing(again, { owner: w, appWindows: () => [w], close });
    const quit = event();
    guard.beforeQuit(quit, vi.fn());
    expect(again.preventDefault).not.toHaveBeenCalled();
    expect(quit.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("keeps the window on Stay and asks again next time", async () => {
    const { guard, deps } = setup({ ask: vi.fn(async () => false) });
    const close = vi.fn();
    guard.windowClosing(event(), { owner: w, appWindows: () => [w], close });
    await answered();
    expect(close).not.toHaveBeenCalled();
    const next = event();
    guard.windowClosing(next, { owner: w, appWindows: () => [w], close });
    expect(next.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it("lets a window that is not the last one close", () => {
    const { guard, deps } = setup();
    const close = event();
    guard.windowClosing(close, { owner: w, appWindows: () => [w, other], close: vi.fn() });
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("asks for the window that closes after another already closing, as when the taskbar closes them all", () => {
    const { guard, deps } = setup();
    const first = event();
    guard.windowClosing(first, { owner: w, appWindows: () => [w, other], close: vi.fn() });
    const second = event();
    guard.windowClosing(second, { owner: other, appWindows: () => [w, other], close: vi.fn() });
    expect(first.preventDefault).not.toHaveBeenCalled();
    expect(second.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledWith(2, other);
  });

  it("counts a window again once a leave confirmation kept it open", () => {
    const { guard, deps } = setup();
    guard.windowClosing(event(), { owner: w, appWindows: () => [w, other], close: vi.fn() });
    guard.stayed(w);
    const next = event();
    guard.windowClosing(next, { owner: other, appWindows: () => [w, other], close: vi.fn() });
    expect(next.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("keeps no confirmation from a window that stopped being the last one while its dialog was open", async () => {
    let answer!: (quit: boolean) => void;
    const { guard, deps } = setup({ ask: vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve))) });
    guard.windowClosing(event(), { owner: w, appWindows: () => [w, other], close: vi.fn() });
    const close = vi.fn();
    guard.windowClosing(event(), { owner: other, appWindows: () => [w, other], close });
    // The first window's page kept it open while the dialog was up.
    guard.stayed(w);
    answer(true);
    await answered();
    expect(close).toHaveBeenCalled();
    const later = event();
    guard.windowClosing(later, { owner: w, appWindows: () => [w], close: vi.fn() });
    expect(later.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it("judges the last window by the windows open when the answer comes, as one opened meanwhile keeps the app running", async () => {
    let answer!: (quit: boolean) => void;
    const { guard, deps } = setup({ ask: vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve))) });
    let open: object[] = [w];
    const close = vi.fn();
    guard.windowClosing(event(), { owner: w, appWindows: () => open, close });
    // The user opens another window from the taskbar while the dialog is up.
    open = [w, other];
    answer(true);
    await answered();
    expect(close).toHaveBeenCalled();
    const later = event();
    guard.windowClosing(later, { owner: other, appWindows: () => [other], close: vi.fn() });
    expect(later.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it("counts a window again after the quit dialog's Stay kept it open", async () => {
    const { guard, deps } = setup({ ask: vi.fn(async () => false) });
    guard.windowClosing(event(), { owner: w, appWindows: () => [w], close: vi.fn() });
    await answered();
    const next = event();
    guard.windowClosing(next, { owner: other, appWindows: () => [w, other], close: vi.fn() });
    expect(next.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("asks once while its dialog is open", async () => {
    let answer!: (quit: boolean) => void;
    const { guard, deps } = setup({ ask: vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve))) });
    guard.beforeQuit(event(), vi.fn());
    const again = event();
    guard.beforeQuit(again, vi.fn());
    const closing = event();
    guard.windowClosing(closing, { owner: w, appWindows: () => [w], close: vi.fn() });
    expect(await guard.confirmRestart()).toBe(false);
    expect(again.preventDefault).toHaveBeenCalled();
    expect(closing.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(1);
    answer(false);
    await answered();
  });

  it("lets the last window close on macOS, where the app keeps running", () => {
    const { guard, deps } = setup({ platform: "darwin" });
    const close = event();
    guard.windowClosing(close, { owner: w, appWindows: () => [w], close: vi.fn() });
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("asks on quit, quits on Quit, and asks no more as the quit closes the windows", async () => {
    const { guard, deps } = setup();
    const quit = vi.fn();
    const first = event();
    guard.beforeQuit(first, quit);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledWith(2, undefined);
    await answered();
    expect(quit).toHaveBeenCalled();
    const second = event();
    guard.beforeQuit(second, quit);
    const close = event();
    guard.windowClosing(close, { owner: w, appWindows: () => [w], close: vi.fn() });
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("stays running on Stay at quit and asks the next time", async () => {
    const { guard, deps } = setup({ ask: vi.fn(async () => false) });
    const quit = vi.fn();
    guard.beforeQuit(event(), quit);
    await answered();
    expect(quit).not.toHaveBeenCalled();
    const next = event();
    guard.beforeQuit(next, quit);
    expect(next.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });

  it("asks once before Restart now, then not as the windows close or the updater quits", async () => {
    const { guard, deps } = setup();
    expect(await guard.confirmRestart()).toBe(true);
    const close = event();
    guard.windowClosing(close, { owner: w, appWindows: () => [w], close: vi.fn() });
    const quit = event();
    guard.beforeQuit(quit, vi.fn());
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(quit.preventDefault).not.toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(1);
  });

  it("cancels Restart now on Stay", async () => {
    const { guard } = setup({ ask: vi.fn(async () => false) });
    expect(await guard.confirmRestart()).toBe(false);
  });

  it("asks again after a leave confirmation kept the app running", async () => {
    const { guard, deps } = setup();
    guard.beforeQuit(event(), vi.fn());
    await answered();
    guard.stayed(w);
    const next = event();
    guard.beforeQuit(next, vi.fn());
    expect(next.preventDefault).toHaveBeenCalled();
    expect(deps.ask).toHaveBeenCalledTimes(2);
  });
});

describe("quitDialogText", () => {
  it.each([
    ["en", 1, "1 download is in progress"],
    ["en", 3, "3 downloads are in progress"],
    ["zh-CN", 1, "有 1 个下载正在进行"],
    ["zh-CN", 2, "有 2 个下载正在进行"],
  ] as const)("in %s with %i running", (locale, count, message) => {
    const text = quitDialogText(desktopText(locale, "breatic"), count);
    expect(text.message).toBe(message);
  });

  it("says quitting cancels them, with Quit and Stay", () => {
    const text = quitDialogText(desktopText("en", "breatic"), 2);
    expect(text.detail).toBe("Quitting cancels downloads in progress.");
    expect(text.buttons).toEqual(["Quit", "Stay"]);
  });
});
