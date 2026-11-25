// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The client's side of Google sign-in through the system browser (inner#2041,
 * design §8.2).
 *
 * Google refuses sign-in in an embedded page (RFC 8252), so the client opens
 * the server's `/desktop/sign-in` in the system browser with a challenge, the
 * SHA-256 of a verifier it keeps. The page hands a one-time code back through
 * `{scheme}://sign-in` on this build's scheme; only a link carrying the challenge of the sign-in
 * waiting here counts. The result waits until a page takes it, so a reload
 * between the click and the link loses nothing.
 */

import crypto from "node:crypto";
import { parseDesktopSignInReturn, type BrowserSignInResult } from "@breatic/shared";

/** A sign-in waiting for the browser, and the result once it arrived. */
interface Pending {
  windowId: number;
  challenge: string;
  verifier: string;
  /** When the browser's link arrived; the code expires on the server this long after it was issued. */
  receivedAt: number;
  result: BrowserSignInResult | null;
}

/** What the flow needs from the outside. */
export interface BrowserSignInDeps {
  /** Opens a URL in the system browser (`shell.openExternal`). */
  openExternal: (url: string) => Promise<void>;
  /** The clock, in milliseconds. */
  now: () => number;
  /** How long a code the browser handed back stays usable, counted from when it arrived; the server's code lives as long. */
  ttlMs: number;
  /** This build's scheme, a reverse domain name. */
  scheme: string;
}

/** The flow's operations. */
export interface BrowserSignIn {
  start(request: { windowId: number; serverOrigin: string; referralCode: string | null }): Promise<void>;
  cancel(): void;
  isPending(): boolean;
  receive(link: string): { accepted: true; windowId: number } | { accepted: false };
  take(): BrowserSignInResult | null;
}

/**
 * Create the sign-in flow. One sign-in waits at a time; starting another replaces it.
 * @param deps - Browser opener, clock and lifetime.
 * @returns The flow.
 */
export function createBrowserSignIn(deps: BrowserSignInDeps): BrowserSignIn {
  let pending: Pending | null = null;

  /**
   * The waiting sign-in, dropped once it outlived the code.
   * @returns The sign-in still waiting, or null.
   */
  function current(): Pending | null {
    // Only a received code expires: the wait before it may last as long as the user takes in the browser.
    if (pending?.result && deps.now() - pending.receivedAt > deps.ttlMs) pending = null;
    return pending;
  }

  return {
    async start({ windowId, serverOrigin, referralCode }) {
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      pending = { windowId, challenge, verifier, receivedAt: 0, result: null };
      const url = new URL("/desktop/sign-in", serverOrigin);
      url.searchParams.set("challenge", challenge);
      if (referralCode) url.searchParams.set("ref", referralCode);
      await deps.openExternal(url.toString());
    },
    cancel() {
      pending = null;
    },
    isPending() {
      return current() !== null;
    },
    receive(link) {
      const parsed = parseDesktopSignInReturn(link, deps.scheme);
      const waiting = current();
      if (!parsed || !waiting || waiting.result || parsed.challenge !== waiting.challenge) return { accepted: false };
      waiting.result = { code: parsed.code, verifier: waiting.verifier };
      waiting.receivedAt = deps.now();
      return { accepted: true, windowId: waiting.windowId };
    },
    take() {
      const waiting = current();
      if (!waiting?.result) return null;
      pending = null;
      return waiting.result;
    },
  };
}
