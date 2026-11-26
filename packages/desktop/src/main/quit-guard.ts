// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Asking before quitting with downloads running (inner#2041, design §7.3.1).
 * Closing the last window on Windows and Linux, quitting and Restart now each
 * ask, and one quit passes through several of them (the last window's close
 * leads to `window-all-closed` and `before-quit`; `app.quit()` closes every
 * window), so a single "confirmed" state answers for all of them, as Chrome's
 * `browser_shutdown::IsTryingToQuit()` does. A leave confirmation that keeps
 * the app running clears it.
 *
 * A window is gone from the app's list only at its `closed`, after the page
 * unloads, so several windows closed at once (the taskbar's "Close all
 * windows") all still see each other at `close`. The guard keeps the windows
 * whose close went ahead and counts the last window without them.
 */

import type { DesktopText } from "@desktop/main/strings.js";

/** What the guard needs from the outside. */
export interface QuitGuardDeps {
  platform: NodeJS.Platform;
  /** How many downloads are running. */
  running: () => number;
  /**
   * Ask whether to quit and cancel the downloads.
   * @returns True for Quit.
   */
  ask: (count: number, owner?: object) => Promise<boolean>;
}

/** An event whose default can be prevented. */
interface Preventable {
  preventDefault(): void;
}

/** The guard's hooks. */
export interface QuitGuard {
  /** A window's `close`: the user closing the last app window on Windows or Linux is asked. */
  windowClosing(event: Preventable, window: { owner: object; appWindows: readonly object[]; close: () => void }): void;
  /** `app`'s `before-quit`. */
  beforeQuit(event: Preventable, quit: () => void): void;
  /** Before Restart now closes the windows; false keeps the app running. */
  confirmRestart(): Promise<boolean>;
  /** A leave confirmation kept the app running, and `window` open: the next quit asks again. */
  stayed(window: object | null): void;
}

/**
 * Create the guard.
 * @param deps - Platform, running count and the dialog.
 * @returns The guard.
 */
export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let confirmed = false;
  let asking = false;
  const closing = new WeakSet<object>();

  /**
   * Whether this quit goes ahead without asking.
   * @returns True when already confirmed or nothing is running.
   */
  const mayGo = (): boolean => confirmed || deps.running() === 0;

  /**
   * Ask once; a second request while the dialog is open waits for nothing.
   * @param owner - The window the dialog belongs to.
   * @returns True for Quit.
   */
  async function confirm(owner?: object): Promise<boolean> {
    asking = true;
    try {
      confirmed = await deps.ask(deps.running(), owner);
      return confirmed;
    } finally {
      asking = false;
    }
  }

  return {
    windowClosing(event, window) {
      const last = window.appWindows.every((other) => other === window.owner || closing.has(other));
      // macOS keeps running with no window, and the downloads with it.
      if (deps.platform === "darwin" || !last || mayGo()) {
        closing.add(window.owner);
        return;
      }
      event.preventDefault();
      if (asking) return;
      void confirm(window.owner).then((quit) => {
        if (quit) window.close();
      });
    },
    beforeQuit(event, quit) {
      if (mayGo()) return;
      event.preventDefault();
      if (asking) return;
      void confirm().then((go) => {
        if (go) quit();
      });
    },
    async confirmRestart() {
      if (mayGo()) return true;
      if (asking) return false;
      return confirm();
    },
    stayed(window) {
      confirmed = false;
      if (window) closing.delete(window);
    },
  };
}

/**
 * The quit dialog's words.
 * @param text - The client's words.
 * @param count - Downloads running.
 * @returns Message, detail and the Quit and Stay buttons.
 */
export function quitDialogText(text: DesktopText, count: number): { message: string; detail: string; buttons: [string, string] } {
  const title = count === 1 ? text["desktop.downloads.quitTitleOne"] : text["desktop.downloads.quitTitleOther"];
  return {
    message: title.replaceAll("{count}", String(count)),
    detail: text["desktop.downloads.quitDetail"],
    buttons: [text["desktop.downloads.quit"], text["desktop.downloads.stay"]],
  };
}
