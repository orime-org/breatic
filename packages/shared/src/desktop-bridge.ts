// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the desktop client's preload exposes to the web app as
 * `window.breaticDesktop` (#1599). The preload implements it and the web app
 * calls it, so both sides read this one declaration.
 */

/** The code the browser handed back, with the verifier the client kept. */
export interface BrowserSignInResult {
  code: string;
  verifier: string;
}

/** The desktop client's bridge; absent in a browser. */
export interface DesktopBridge {
  /** `process.platform` of the machine the client runs on. */
  readonly platform: string;
  /** Open the system browser on `/desktop/sign-in`, carrying the referral code when there is one. */
  signInWithBrowser(referralCode: string | null): Promise<void>;
  /** Forget the sign-in waiting for the browser; a code that arrives later is ignored. */
  cancelBrowserSignIn(): Promise<void>;
  /** Whether a sign-in started in this client is still waiting for the browser. */
  isBrowserSignInPending(): Promise<boolean>;
  /** Take the result that has arrived, once; null when none has. */
  takeBrowserSignInResult(): Promise<BrowserSignInResult | null>;
  /** Hear that a result has arrived; returns the unsubscribe. */
  onBrowserSignInResult(listener: () => void): () => void;
}

/** The address the browser page opens to hand a code to the client. */
export const DESKTOP_SIGN_IN_LINK = "breatic://sign-in";
