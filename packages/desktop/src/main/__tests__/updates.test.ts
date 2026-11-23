// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Updating the shell (inner#2041, design §9.1.2). A build with an update feed
 * checks at launch and every four hours, downloads in the background and
 * offers Restart now or Later; Later installs on the next quit. Restart now
 * closes every window through the normal path first, so a window guarding
 * unsaved work can keep the app running; only when all closed does the
 * updater quit, install and start the app again. A manual check says when
 * there is nothing new or the check failed; a timed check stays quiet.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

import { UPDATE_CHECK_INTERVAL_MS, createUpdates, type UpdatesDeps } from "@desktop/main/updates.js";

/** An updater standing in for electron-updater's autoUpdater. */
class FakeUpdater extends EventEmitter {
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async (): Promise<unknown> => null);
  quitAndInstall = vi.fn();
}

/**
 * The flow with test doubles.
 * @param over - Dependencies to replace.
 * @returns The flow and its doubles.
 */
function setup(over: Partial<UpdatesDeps> = {}) {
  const updater = new FakeUpdater();
  const deps: UpdatesDeps = {
    updater,
    enabled: true,
    every: vi.fn(),
    ask: vi.fn(async () => "later" as const),
    tell: vi.fn(),
    closeAllWindows: vi.fn(async () => true),
    flushReports: vi.fn(async () => undefined),
    log: vi.fn(),
    ...over,
  };
  return { updates: createUpdates(deps), updater, deps };
}

describe("createUpdates", () => {
  it("does nothing in a build without an update feed", () => {
    const { updates, updater, deps } = setup({ enabled: false });
    updates.start();
    void updates.checkNow();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(deps.every).not.toHaveBeenCalled();
  });

  it("checks at launch and every four hours, and installs a downloaded update on quit", () => {
    const { updates, updater, deps } = setup();
    updates.start();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(deps.every).toHaveBeenCalledWith(expect.any(Function), UPDATE_CHECK_INTERVAL_MS);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1000);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("leaves a downloaded update for the next quit when the user picks Later", async () => {
    const { updates, updater, deps } = setup();
    updates.start();
    updater.emit("update-downloaded", { version: "1.2.0" });
    await vi.waitFor(() => expect(deps.ask).toHaveBeenCalledWith("1.2.0"));
    expect(deps.closeAllWindows).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("closes every window, sends pending reports, then installs and starts again, on Restart now", async () => {
    const order: string[] = [];
    const { updates, updater } = setup({
      ask: vi.fn(async () => "restart" as const),
      closeAllWindows: vi.fn(async () => {
        order.push(`closing:${String(updates.isRestarting())}`);
        return true;
      }),
      flushReports: vi.fn(async () => {
        order.push("flush");
      }),
    });
    updater.quitAndInstall.mockImplementation(() => order.push("install"));
    updates.start();
    updater.emit("update-downloaded", { version: "1.2.0" });
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true));
    expect(order).toEqual(["closing:true", "flush", "install"]);
  });

  it("keeps the app and the update for the next quit when a window refuses to close", async () => {
    const { updates, updater, deps } = setup({ ask: vi.fn(async () => "restart" as const), closeAllWindows: vi.fn(async () => false) });
    updates.start();
    updater.emit("update-downloaded", { version: "1.2.0" });
    await vi.waitFor(() => expect(deps.closeAllWindows).toHaveBeenCalled());
    await Promise.resolve();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.isRestarting()).toBe(false);
  });

  it("says so when a manual check finds nothing new", async () => {
    const { updates, updater, deps } = setup();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-not-available", {});
      return null;
    });
    await updates.checkNow();
    expect(deps.tell).toHaveBeenCalledWith("upToDate");
  });

  it("says so when a manual check fails, and stays quiet when a timed one does", async () => {
    const { updates, updater, deps } = setup();
    updater.checkForUpdates.mockRejectedValue(new Error("offline"));
    updates.start();
    await Promise.resolve();
    vi.mocked(deps.every).mock.calls[0]![0]();
    await Promise.resolve();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(deps.tell).not.toHaveBeenCalled();
    await updates.checkNow();
    expect(deps.tell).toHaveBeenCalledWith("failed");
    expect(deps.log).toHaveBeenCalled();
  });

  it("asks once per version: a timed check finding the same download stays quiet, a manual check asks again", async () => {
    const { updates, updater, deps } = setup();
    updates.start();
    updater.emit("update-downloaded", { version: "1.2.0" });
    await vi.waitFor(() => expect(deps.ask).toHaveBeenCalledTimes(1));
    const timed = vi.mocked(deps.every).mock.calls[0]![0];
    // As electron-updater does: the check resolves first, the cached download reports afterwards.
    updater.checkForUpdates.mockImplementation(async () => {
      setTimeout(() => updater.emit("update-downloaded", { version: "1.2.0" }), 0);
      return null;
    });
    timed();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deps.ask).toHaveBeenCalledTimes(1);
    await updates.checkNow();
    await vi.waitFor(() => expect(deps.ask).toHaveBeenCalledTimes(2));
  });

  it("records a background download that fails", async () => {
    const { updates, updater, deps } = setup();
    const failure = new Error("sha512 mismatch");
    updater.checkForUpdates.mockResolvedValue({ downloadPromise: Promise.reject(failure) });
    updates.start();
    await vi.waitFor(() => expect(deps.log).toHaveBeenCalledWith(failure));
  });
});
