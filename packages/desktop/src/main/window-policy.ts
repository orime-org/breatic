// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the client does when it is asked to show itself, and when closing the
 * connect window ends it (#1599, design §5, §5.1). A client bound to a server
 * never falls back to the address form. Kept apart from Electron
 * so the rules can be tested.
 */

/** What is on screen and what the build knows when a Dock click, relaunch or stray link arrives. */
export interface ActivateState {
  connectOpen: boolean;
  /** An app window that is shown (minimized counts). */
  visibleWindow: boolean;
  /** An app window still loading the server for the first time. */
  loadingWindow: boolean;
  /** The server the client has shown this session, if any. */
  server: string | null;
  /** The server this client opens: the one in the environment, the saved one or the one the build carries; empty when the first launch asks. */
  boundServer: string;
}

/** The answer: bring something forward, wait, open a window, or open the connect window in one of its states. */
export type ActivateAction = "focus-connect" | "focus-window" | "wait" | "new-window" | "unreachable" | "connect";

/**
 * Decide what showing the client does.
 * @param state - What is on screen and what the build knows.
 * @returns The action.
 */
export function activateAction(state: ActivateState): ActivateAction {
  if (state.connectOpen) return "focus-connect";
  if (state.visibleWindow) return "focus-window";
  if (state.loadingWindow) return "wait";
  if (state.server) return "new-window";
  return state.boundServer ? "unreachable" : "connect";
}

/**
 * Whether closing the connect window ends the app.
 * @param state - The platform and whether an app window is on screen.
 * @param state.platform - `process.platform`.
 * @param state.visibleWindow - An app window is shown.
 * @returns True on Windows and Linux with nothing else on screen; macOS keeps the app in the Dock.
 */
export function quitsWhenConnectCloses(state: { platform: string; visibleWindow: boolean }): boolean {
  return state.platform !== "darwin" && !state.visibleWindow;
}
