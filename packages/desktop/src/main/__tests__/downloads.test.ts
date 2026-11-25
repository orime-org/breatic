// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Download feedback (inner#2041, design §7.3.1). The main process keeps this
 * run's download list and whether the panel is open; every server page shows
 * the same list, reading it after each notice. The app icon shows the running
 * total; on macOS the Dock progress belongs to the app, so a hidden window
 * carries it and it clears even after the last window closed.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

import { createDownloads, downloadIpcHandlers, folderName, type DownloadsDeps } from "@desktop/main/downloads.js";

const SERVER = "https://app.example.com";

/** A download item standing in for Electron's DownloadItem. */
class FakeItem extends EventEmitter {
  savePath = "";
  received = 0;
  total = 0;
  cancel = vi.fn();
  getSavePath = (): string => this.savePath;
  getReceivedBytes = (): number => this.received;
  getTotalBytes = (): number => this.total;

  /**
   * Report progress after the save dialog.
   * @param received - Bytes so far.
   * @param total - Total bytes, 0 when unknown.
   */
  progress(received: number, total: number): void {
    this.received = received;
    this.total = total;
    this.emit("updated", {}, "progressing");
  }
}

/**
 * An app window showing a page of some origin.
 * @param origin - The main frame's origin.
 * @returns The window double.
 */
function fakeWindow(origin = SERVER) {
  return { webContents: { send: vi.fn(), mainFrame: { origin } }, setProgressBar: vi.fn() };
}

/**
 * The downloads with test doubles.
 * @param over - Dependencies to replace.
 * @returns The downloads and their doubles.
 */
function setup(over: Partial<DownloadsDeps> = {}) {
  const windows = [fakeWindow()];
  const dock = { setProgressBar: vi.fn(), destroy: vi.fn() };
  const deps: DownloadsDeps = {
    platform: "win32",
    serverOrigin: SERVER,
    appWindows: () => windows,
    openDockWindow: vi.fn(() => dock),
    downloadFinished: vi.fn(),
    showItemInFolder: vi.fn(),
    ...over,
  };
  return { downloads: createDownloads(deps), deps, windows, dock };
}

/**
 * Start a download whose save dialog the user answered.
 * @param downloads - The downloads.
 * @param savePath - Where the user saved it.
 * @returns The item.
 */
function saved(downloads: ReturnType<typeof createDownloads>, savePath: string): FakeItem {
  const item = new FakeItem();
  downloads.track(item);
  item.savePath = savePath;
  return item;
}

describe("createDownloads", () => {
  it("ignores a download until the save dialog is answered, and lists nothing when it was cancelled", () => {
    const { downloads, windows } = setup();
    const item = new FakeItem();
    downloads.track(item);
    item.progress(10, 100);
    item.emit("done", {}, "cancelled");
    expect(downloads.list()).toEqual({ open: false, items: [] });
    expect(windows[0]!.webContents.send).not.toHaveBeenCalled();
  });

  it("adds a saved download at the top, opens the panel and notifies server pages without data", () => {
    const stripe = fakeWindow("https://checkout.stripe.com");
    const { downloads, windows } = setup({ appWindows: () => [windows[0]!, stripe] });
    const first = saved(downloads, "/Users/a/Downloads/a.png");
    first.progress(10, 100);
    const second = saved(downloads, "/Users/a/Downloads/b.mp4");
    second.progress(5, 0);
    expect(downloads.list()).toEqual({
      open: true,
      items: [
        { id: expect.any(String), name: "b.mp4", state: "progressing", received: 5, total: 0 },
        { id: expect.any(String), name: "a.png", state: "progressing", received: 10, total: 100 },
      ],
    });
    expect(windows[0]!.webContents.send).toHaveBeenCalledWith("download:changed");
    for (const call of windows[0]!.webContents.send.mock.calls) expect(call).toEqual(["download:changed"]);
    expect(stripe.webContents.send).not.toHaveBeenCalled();
  });

  it("updates a row's progress in place", () => {
    const { downloads } = setup();
    const item = saved(downloads, "/tmp/a.zip");
    item.progress(10, 100);
    item.progress(60, 100);
    expect(downloads.list().items).toEqual([{ id: expect.any(String), name: "a.zip", state: "progressing", received: 60, total: 100 }]);
  });

  it("cancels an interrupted download, which then ends as failed", () => {
    const { downloads } = setup();
    const item = saved(downloads, "/tmp/a.zip");
    item.progress(10, 100);
    item.emit("updated", {}, "interrupted");
    expect(item.cancel).toHaveBeenCalled();
    item.emit("done", {}, "cancelled");
    expect(downloads.list().items).toEqual([{ id: expect.any(String), name: "a.zip", state: "failed" }]);
  });

  it("lists a download that fails before any progress, with the panel open", () => {
    const { downloads } = setup();
    const item = saved(downloads, "/tmp/a.zip");
    item.emit("done", {}, "interrupted");
    expect(downloads.list()).toEqual({ open: true, items: [{ id: expect.any(String), name: "a.zip", state: "failed" }] });
  });

  it("marks a finished download with its folder name and never puts the path in the list", () => {
    const { downloads, deps } = setup();
    const item = saved(downloads, "/Users/someone/Downloads/a.png");
    item.progress(100, 100);
    item.emit("done", {}, "completed");
    const list = downloads.list();
    expect(list.items).toEqual([{ id: expect.any(String), name: "a.png", state: "completed", folder: "Downloads" }]);
    expect(JSON.stringify(list)).not.toContain("/Users/someone");
    expect(deps.downloadFinished).not.toHaveBeenCalled();
  });

  it("bounces the Downloads stack on macOS when a download finishes", () => {
    const { downloads, deps } = setup({ platform: "darwin" });
    const item = saved(downloads, "/Users/a/Downloads/a.png");
    item.emit("done", {}, "completed");
    expect(deps.downloadFinished).toHaveBeenCalledWith("/Users/a/Downloads/a.png");
  });

  it("reveals a finished download by id, and nothing for an unknown id", () => {
    const { downloads, deps } = setup();
    const item = saved(downloads, "/Users/a/Downloads/a.png");
    item.emit("done", {}, "completed");
    downloads.reveal("nope");
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
    downloads.reveal(downloads.list().items[0]!.id);
    expect(deps.showItemInFolder).toHaveBeenCalledWith("/Users/a/Downloads/a.png");
  });

  it("closes the panel on dismiss, keeping running rows, and reopens it on the next event", () => {
    const { downloads, windows } = setup();
    const done = saved(downloads, "/tmp/a.zip");
    done.emit("done", {}, "completed");
    const failed = saved(downloads, "/tmp/b.zip");
    failed.emit("done", {}, "interrupted");
    const running = saved(downloads, "/tmp/c.zip");
    running.progress(1, 10);
    windows[0]!.webContents.send.mockClear();
    downloads.dismiss();
    expect(downloads.list()).toEqual({ open: false, items: [{ id: expect.any(String), name: "c.zip", state: "progressing", received: 1, total: 10 }] });
    expect(windows[0]!.webContents.send).toHaveBeenCalledWith("download:changed");
    running.progress(2, 10);
    expect(downloads.list().open).toBe(false);
    running.emit("done", {}, "completed");
    expect(downloads.list().open).toBe(true);
  });

  it("counts the downloads still running", () => {
    const { downloads } = setup();
    const a = saved(downloads, "/tmp/a.zip");
    a.progress(1, 10);
    const b = saved(downloads, "/tmp/b.zip");
    b.progress(1, 10);
    b.emit("done", {}, "completed");
    expect(downloads.running()).toBe(1);
  });
});

describe("icon progress", () => {
  it("sets the running total on every app window on Windows, indeterminate while a size is unknown, and clears it at the end", () => {
    const other = fakeWindow("https://checkout.stripe.com");
    const { downloads, windows } = setup({ appWindows: () => [windows[0]!, other] });
    const a = saved(downloads, "/tmp/a.zip");
    a.progress(30, 100);
    const b = saved(downloads, "/tmp/b.zip");
    b.progress(20, 100);
    expect(windows[0]!.setProgressBar).toHaveBeenLastCalledWith(0.25);
    expect(other.setProgressBar).toHaveBeenLastCalledWith(0.25);
    const c = saved(downloads, "/tmp/c.zip");
    c.progress(5, 0);
    expect(windows[0]!.setProgressBar).toHaveBeenLastCalledWith(2);
    for (const item of [a, b, c]) item.emit("done", {}, "completed");
    expect(windows[0]!.setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it("shows no progress for an unknown size on Linux", () => {
    const { downloads, windows } = setup({ platform: "linux" });
    saved(downloads, "/tmp/a.zip").progress(5, 0);
    expect(windows[0]!.setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it("sets the Dock progress through one hidden window on macOS, with or without app windows, and removes it when nothing runs", () => {
    const windows: ReturnType<typeof fakeWindow>[] = [fakeWindow()];
    const { downloads, deps, dock } = setup({ platform: "darwin", appWindows: () => windows });
    const a = saved(downloads, "/tmp/a.zip");
    a.progress(50, 100);
    const b = saved(downloads, "/tmp/b.zip");
    b.progress(0, 100);
    expect(deps.openDockWindow).toHaveBeenCalledTimes(1);
    expect(dock.setProgressBar).toHaveBeenLastCalledWith(0.25);
    expect(windows[0]!.setProgressBar).not.toHaveBeenCalled();
    windows.length = 0;
    a.progress(100, 100);
    expect(dock.setProgressBar).toHaveBeenLastCalledWith(0.5);
    b.progress(5, 0);
    expect(dock.setProgressBar).toHaveBeenLastCalledWith(-1);
    a.emit("done", {}, "completed");
    b.emit("done", {}, "completed");
    expect(dock.setProgressBar).toHaveBeenLastCalledWith(-1);
    expect(dock.destroy).toHaveBeenCalledTimes(1);
    saved(downloads, "/tmp/c.zip").progress(1, 10);
    expect(deps.openDockWindow).toHaveBeenCalledTimes(2);
  });
});

describe("folderName", () => {
  it.each([
    ["darwin", "/Users/a/Downloads/a.png", "Downloads"],
    ["linux", "/a.png", "/"],
    ["win32", "C:\\Users\\a\\Desktop\\a.png", "Desktop"],
    ["win32", "D:\\a.png", "D:\\"],
  ] as const)("on %s names the folder of %s", (platform, path, name) => {
    expect(folderName(path, platform)).toBe(name);
  });
});

describe("downloadIpcHandlers", () => {
  /**
   * The handlers over a list with one finished download.
   * @param fromServer - Whether a call counts as coming from the server.
   * @returns The handlers and doubles.
   */
  function handlers(fromServer: boolean) {
    const ctx = setup();
    const item = saved(ctx.downloads, "/tmp/a.zip");
    item.emit("done", {}, "completed");
    const id = ctx.downloads.list().items[0]!.id;
    return { ...ctx, id, calls: downloadIpcHandlers(ctx.downloads, () => fromServer) };
  }

  it("answers the server's pages", () => {
    const { calls, id, downloads, deps } = handlers(true);
    expect(calls["download:list"]({})).toEqual(downloads.list());
    calls["download:reveal"]({}, id);
    expect(deps.showItemInFolder).toHaveBeenCalledWith("/tmp/a.zip");
    calls["download:dismiss"]({});
    expect(downloads.list()).toEqual({ open: false, items: [] });
  });

  it("refuses every call from another origin", () => {
    const { calls, id, downloads, deps } = handlers(false);
    expect(calls["download:list"]({})).toBeUndefined();
    calls["download:reveal"]({}, id);
    calls["download:dismiss"]({});
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
    expect(downloads.list().items).toHaveLength(1);
  });

  it("refuses an id that is not a string", () => {
    const { calls, deps } = handlers(true);
    calls["download:reveal"]({}, { toString: () => "1" });
    calls["download:reveal"]({}, 1);
    expect(deps.showItemInFolder).not.toHaveBeenCalled();
  });
});
