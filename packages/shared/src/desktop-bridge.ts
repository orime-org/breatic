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

/**
 * A reverse domain name (RFC 8252 §7.1): lower case, at least one dot. A
 * website can register a protocol handler only for `web+…` schemes and the
 * browsers' safelists, and none of those has a dot.
 */
const REVERSE_DOMAIN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Whether a scheme may carry a desktop sign-in code: one no website can claim.
 * The server's deployment setting and the brand a client is built for both
 * pass through this rule (#1599, design §8.3).
 * @param scheme - The scheme, without `://`.
 * @returns True for a reverse domain name.
 */
export function isDesktopAppScheme(scheme: string): boolean {
  return REVERSE_DOMAIN.test(scheme);
}

/**
 * The address the browser page opens to hand a code to a desktop build.
 * @param scheme - The build's scheme, a reverse domain name.
 * @returns `{scheme}://sign-in`.
 */
function desktopSignInLink(scheme: string): string {
  return `${scheme}://sign-in`;
}

/** 32 bytes in base64url without padding (43 characters): a SHA-256 challenge or a one-time handoff code. */
export const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/**
 * The link the browser page opens to hand a code back to a desktop build.
 * @param scheme - The build's scheme.
 * @param code - The one-time code.
 * @param challenge - The challenge the build sent, so it can match its own sign-in.
 * @returns The link.
 */
export function desktopSignInReturn(scheme: string, code: string, challenge: string): string {
  return `${desktopSignInLink(scheme)}?${new URLSearchParams({ code, challenge }).toString()}`;
}

/**
 * Read a sign-in return link on a build's scheme.
 * @param link - The link as the system delivered it.
 * @param scheme - The build's scheme.
 * @returns The code and challenge, or null when it is not a well-formed return link on that scheme.
 */
export function parseDesktopSignInReturn(link: string, scheme: string): { code: string; challenge: string } | null {
  const base = desktopSignInLink(scheme);
  if (!link.startsWith(`${base}?`)) return null;
  const params = new URLSearchParams(link.slice(base.length + 1));
  const code = params.get("code");
  const challenge = params.get("challenge");
  if (!code || !challenge || !BASE64URL_32_BYTES.test(code) || !BASE64URL_32_BYTES.test(challenge)) return null;
  return { code, challenge };
}
