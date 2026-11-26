// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The browser's side of the full-page Google sign-in (inner#2157 design
 * §7.9), for the suites that need a Google account to sign up or sign in.
 * Not a test file.
 *
 * Each suite mocks `google-auth-library` itself (the mock is hoisted per
 * file): `OAuth2Client` keeps the real `generateAuthUrl`, so the redirect
 * carries the real `state`, `nonce` and `redirect_uri`, while `getToken` and
 * `verifyIdToken` answer from the suite's `GoogleDouble`. A suite builds its
 * mock with `googleClientDouble` below.
 */

import { expect, type Mock } from "vitest";

/** The test client id every suite configures as `GOOGLE_CLIENT_ID`. */
export const GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
/** The test client secret every suite configures as `GOOGLE_CLIENT_SECRET`. */
export const GOOGLE_CLIENT_SECRET = "test-client-secret";

/** Google's two calls the server makes after the user comes back. */
export interface GoogleDouble {
  getToken: Mock;
  verifyIdToken: Mock;
}

/**
 * The `google-auth-library` module a suite's `vi.mock` returns: the real
 * module with `OAuth2Client`'s token exchange and token check answered by the
 * double.
 * @param actual - The real module.
 * @param double - The suite's double.
 * @returns The module to hand to vitest.
 */
export function googleClientDouble<M extends { OAuth2Client: new (...args: never[]) => object }>(
  actual: M,
  double: GoogleDouble,
): M {
  const Real = actual.OAuth2Client;
  /** The real client whose two network calls are answered by the double. */
  class OAuth2Client extends Real {
    /**
     * Build the client and swap in the double.
     * @param args - Whatever the server passes the real constructor.
     */
    constructor(...args: never[]) {
      super(...args);
      Object.assign(this, { getToken: double.getToken, verifyIdToken: double.verifyIdToken });
    }
  }
  return { ...actual, OAuth2Client };
}

/** Anything with Hono's `request`. */
interface Requestable {
  request: (input: string | Request | URL, init?: RequestInit) => Response | Promise<Response>;
}

/** One Google account and how the sign-in starts. */
export interface GoogleLogin {
  /** The site the user starts from: the begin request's `Origin`. */
  origin: string;
  page: "login" | "register";
  sub: string;
  email: string;
  next?: string;
  locale?: string;
  /** Extra Cookie header on the callback (the bind cookie is always sent). */
  callbackCookie?: string;
}

/** What the flow saw. */
export interface GoogleLoginResult {
  begin: Response;
  callback: Response;
  /** Where the callback sent the browser. */
  location: URL;
}

/**
 * The `name=value` pair of the first cookie whose name starts with `prefix`.
 * @param res - The response.
 * @param prefix - The name prefix.
 * @returns The pair, or undefined.
 */
export function cookiePair(res: Response, prefix: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(prefix))?.split(";")[0];
}

/**
 * The whole `Set-Cookie` line of the first cookie whose name is exactly `name`.
 * @param res - The response.
 * @param name - The cookie name.
 * @returns The line, or undefined.
 */
export function setCookieLine(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

/**
 * Run begin → Google → callback for one Google account, as a browser would.
 * @param app - The public app.
 * @param double - The suite's Google double.
 * @param login - The account and where the sign-in starts.
 * @returns Both responses and where the callback redirected.
 */
export async function googleRedirectLogin(
  app: Requestable,
  double: GoogleDouble,
  login: GoogleLogin,
): Promise<GoogleLoginResult> {
  const begin = await app.request("/api/v1/auth/google/begin", {
    method: "POST",
    headers: { Origin: login.origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ page: login.page, next: login.next ?? "/studio", locale: login.locale ?? "en" }).toString(),
  });
  expect(begin.status).toBe(303);
  const toGoogle = new URL(begin.headers.get("location")!);
  expect(toGoogle.hostname).toBe("accounts.google.com");
  const state = toGoogle.searchParams.get("state")!;
  const nonce = toGoogle.searchParams.get("nonce")!;
  const bind = cookiePair(begin, "breatic_google_bind");
  expect(bind).toMatch(/^breatic_google_bind[^=]*=.+/);

  double.getToken.mockResolvedValueOnce({ tokens: { id_token: "header.payload.signature" }, res: null });
  double.verifyIdToken.mockResolvedValueOnce({
    getPayload: () => ({
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      sub: login.sub,
      email: login.email,
      email_verified: true,
      nonce,
    }),
  });
  const cookie = [bind!, login.callbackCookie].filter(Boolean).join("; ");
  const callback = await app.request(
    `/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: cookie } },
  );
  expect(callback.status).toBe(303);
  return { begin, callback, location: new URL(callback.headers.get("location")!) };
}
