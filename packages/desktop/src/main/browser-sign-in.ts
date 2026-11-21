// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client's side of Google sign-in through the system browser (#1599,
 * design §8.2).
 *
 * Google refuses sign-in in an embedded page (RFC 8252), so the client opens
 * the server's `/desktop/sign-in` in the system browser with a challenge, the
 * SHA-256 of a verifier it keeps. The page hands a one-time code back through
 * `breatic://sign-in`; only a link carrying the challenge of the sign-in
 * waiting here counts. The result waits until a page takes it, so a reload
 * between the click and the link loses nothing.
 */

import crypto from "node:crypto";
import { DESKTOP_SIGN_IN_LINK, type BrowserSignInResult } from "@breatic/shared";

/** A sign-in waiting for the browser, and the result once it arrived. */
interface Pending {
  windowId: number;
  challenge: string;
  verifier: string;
  startedAt: number;
  result: BrowserSignInResult | null;
}

/** What the flow needs from the outside. */
export interface BrowserSignInDeps {
  /** Opens a URL in the system browser (`shell.openExternal`). */
  openExternal: (url: string) => Promise<void>;
  /** The clock, in milliseconds. */
  now: () => number;
  /** How long a sign-in waits; the server's code lives as long. */
  ttlMs: number;
}

/** The flow's operations. */
export interface BrowserSignIn {
  start(request: { windowId: number; serverOrigin: string; referralCode: string | null }): Promise<void>;
  cancel(): void;
  isPending(): boolean;
  receive(link: string): { accepted: true; windowId: number } | { accepted: false };
  take(): BrowserSignInResult | null;
}

/** A base64url SHA-256 digest. */
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/**
 * Read a `breatic://sign-in` link.
 * @param link - The link as the system delivered it.
 * @returns The code and challenge, or null when it is not a well-formed sign-in link.
 */
export function parseSignInLink(link: string): { code: string; challenge: string } | null {
  if (!link.startsWith(`${DESKTOP_SIGN_IN_LINK}?`)) return null;
  const params = new URLSearchParams(link.slice(DESKTOP_SIGN_IN_LINK.length + 1));
  const code = params.get("code");
  const challenge = params.get("challenge");
  if (!code || !challenge || !DIGEST.test(code) || !DIGEST.test(challenge)) return null;
  return { code, challenge };
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
    if (pending && deps.now() - pending.startedAt > deps.ttlMs) pending = null;
    return pending;
  }

  return {
    async start({ windowId, serverOrigin, referralCode }) {
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      pending = { windowId, challenge, verifier, startedAt: deps.now(), result: null };
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
      const parsed = parseSignInLink(link);
      const waiting = current();
      if (!parsed || !waiting || waiting.result || parsed.challenge !== waiting.challenge) return { accepted: false };
      waiting.result = { code: parsed.code, verifier: waiting.verifier };
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
