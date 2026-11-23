// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Updating the shell (#1599, design §9.1.2). Only a build packaged with an
 * update feed (app-update.yml) runs this. It checks at launch and every four
 * hours, downloads in the background and offers Restart now or Later; Later
 * installs on the next quit. Restart now closes every window through the
 * normal path first, so the leave confirmation can keep the app running:
 * electron-updater's quitAndInstall starts the installer before quitting, and
 * on Windows the installer ends the app about a second later whatever the
 * windows say. VS Code's quitAndInstall likewise quits normally first.
 */

/** How often a running client looks for a new version. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** The part of electron-updater's autoUpdater the flow uses. */
export interface Updater {
  autoInstallOnAppQuit: boolean;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

/** What the flow needs from the outside. */
export interface UpdatesDeps {
  updater: Updater;
  /** Whether this build carries an update feed. */
  enabled: boolean;
  /** Run a task on an interval. */
  every: (task: () => void, ms: number) => void;
  /** Offer a downloaded version: restart now or later. */
  ask: (version: string) => Promise<"restart" | "later">;
  /** Tell the user how a manual check ended. */
  tell: (outcome: "upToDate" | "failed") => void;
  /** Close every window through the normal path; false when one refused. */
  closeAllWindows: () => Promise<boolean>;
  /** Record a failure. */
  log: (err: unknown) => void;
}

/** The flow's operations. */
export interface Updates {
  start(): void;
  checkNow(): Promise<void>;
  isRestarting(): boolean;
}

/**
 * Create the update flow.
 * @param deps - Updater, timer, dialogs and window control.
 * @returns The flow.
 */
export function createUpdates(deps: UpdatesDeps): Updates {
  const { updater } = deps;
  let restarting = false;
  let manual = false;
  /** The version last offered: a timed check finding the same download again stays quiet (Later means on the next quit). */
  let offered: string | null = null;

  /**
   * Look for a new version.
   * @param byUser - Whether the user asked, so the outcome is told.
   */
  async function check(byUser: boolean): Promise<void> {
    manual = byUser;
    // Asking means asking again, even about a version the user put off.
    if (byUser) offered = null;
    try {
      const result = (await updater.checkForUpdates()) as { downloadPromise?: Promise<unknown> | null } | null;
      // electron-updater starts the download without awaiting it.
      void result?.downloadPromise?.catch((err: unknown) => deps.log(err));
    } catch (err) {
      deps.log(err);
      if (byUser) deps.tell("failed");
    } finally {
      manual = false;
    }
  }

  /**
   * Offer a downloaded version and act on the answer.
   * @param version - The version ready to install.
   */
  async function offer(version: string): Promise<void> {
    if ((await deps.ask(version)) !== "restart") return;
    restarting = true;
    try {
      if (await deps.closeAllWindows()) updater.quitAndInstall(false, true);
    } finally {
      restarting = false;
    }
  }

  if (deps.enabled) {
    updater.autoInstallOnAppQuit = true;
    updater.on("update-downloaded", (info) => {
      if (info.version === offered) return;
      offered = info.version;
      void offer(info.version).catch((err: unknown) => deps.log(err));
    });
    updater.on("update-not-available", () => {
      if (manual) deps.tell("upToDate");
    });
  }

  return {
    start() {
      if (!deps.enabled) return;
      void check(false);
      deps.every(() => void check(false), UPDATE_CHECK_INTERVAL_MS);
    },
    checkNow() {
      return deps.enabled ? check(true) : Promise.resolve();
    },
    isRestarting() {
      return restarting;
    },
  };
}
