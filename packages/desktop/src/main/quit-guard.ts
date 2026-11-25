// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** Asking before quitting with downloads running (inner#2041, design §7.3.1). */

import type { DesktopText } from "@desktop/main/strings.js";

/** What the guard needs from the outside. */
export interface QuitGuardDeps {
  platform: NodeJS.Platform;
  running: () => number;
  ask: (count: number, owner?: unknown) => Promise<boolean>;
}

/** An event whose default can be prevented. */
interface Preventable {
  preventDefault(): void;
}

/** The guard's hooks. */
export interface QuitGuard {
  windowClosing(event: Preventable, window: { isLastAppWindow: boolean; owner: unknown; close: () => void }): void;
  beforeQuit(event: Preventable, quit: () => void): void;
  confirmRestart(): Promise<boolean>;
  stayed(): void;
}

/**
 * Create the guard.
 * @param _deps - Platform, running count and the dialog.
 * @returns The guard.
 */
export function createQuitGuard(_deps: QuitGuardDeps): QuitGuard {
  return { windowClosing: () => undefined, beforeQuit: () => undefined, confirmRestart: async () => true, stayed: () => undefined };
}

/**
 * The quit dialog's words.
 * @param _text - The client's words.
 * @param _count - Downloads running.
 * @returns Message, detail and buttons.
 */
export function quitDialogText(_text: DesktopText, _count: number): { message: string; detail: string; buttons: [string, string] } {
  return { message: "", detail: "", buttons: ["", ""] };
}
