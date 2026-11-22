// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Opening another window (#1599, design §5.1). Windows' taskbar task and the
 * Debian launcher action start the client with `--new-window`; the
 * single-instance lock hands those arguments to the client already running.
 */

import type { Rectangle, Task } from "electron";

/** The argument that asks the running client for another window. */
export const NEW_WINDOW_ARG = "--new-window";
/** How far a new window sits down and right of the one in use. */
const CASCADE_STEP = 24;

/**
 * Whether a launch asks for another window.
 * @param argv - The launch's arguments.
 * @returns True when the flag is among them.
 */
export function wantsNewWindow(argv: readonly string[]): boolean {
  return argv.includes(NEW_WINDOW_ARG);
}

/**
 * The task the Windows taskbar icon offers.
 * @param execPath - `process.execPath`, the installed executable.
 * @param title - New Window in the user's language.
 * @returns The tasks for `app.setUserTasks`.
 */
export function windowsUserTasks(execPath: string, title: string): Task[] {
  return [{ program: execPath, arguments: NEW_WINDOW_ARG, title, description: title, iconPath: execPath, iconIndex: 0 }];
}

/**
 * Where a new window goes.
 * @param current - The window in use, or null when none is open.
 * @param saved - The size and place remembered from the last window closed.
 * @returns The new window's bounds.
 */
export function nextWindowBounds<T extends { width: number; height: number }>(current: Rectangle | null, saved: T): Rectangle | T {
  if (!current) return saved;
  return { x: current.x + CASCADE_STEP, y: current.y + CASCADE_STEP, width: current.width, height: current.height };
}
