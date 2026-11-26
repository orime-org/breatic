// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The full-page Google sign-in (inner#2157 design §7.9) taken one step at a
 * time, for the suites that check what each step answers: the begin form post,
 * Google's answer, and the callback. Not a test file.
 *
 * The suite mocks `google-auth-library` with `googleClientDouble` from
 * `google-redirect-harness.ts`; `answerGoogleFrom` then makes the double
 * answer every exchanged code with the ID token payload the case registered
 * for it, so a callback that never reaches Google leaves nothing queued.
 */

import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { GOOGLE_CLIENT_ID, type GoogleDouble } from "./google-redirect-harness.js";

/** Anything with Hono's `request`. */
interface Requestable {
  request: (input: string | Request | URL, init?: RequestInit) => Response | Promise<Response>;
}

/** The begin form's fields, as the sign-in page posts them. */
export interface BeginFields {
  page?: "login" | "register";
  next?: string;
  locale?: string;
  /** The campaign source, posted as JSON text. */
  attribution?: unknown;
  referralCode?: string;
  referralSource?: string;
}

/** The begin request's headers. */
export interface BeginRequest {
  /** The site the user starts from; absent sends no `Origin`. */
  origin?: string;
  /** The page site's cookies (consent). */
  cookie?: string;
  acceptLanguage?: string;
  /** The client address our proxy wrote, for a suite that counts the limiter. */
  realIp?: string;
}

/** A begin that sent the browser to Google. */
export interface Begun {
  res: Response;
  toGoogle: URL;
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  /** The bind cookie as the browser sends it back: `name=value`. */
  bind: string;
}

/** What Google says about the account, or how it fails. */
export interface GoogleAnswer {
  sub: string;
  email: string;
  emailVerified?: boolean;
  hd?: string;
  iss?: string;
  /** The ID token's nonce; the begin's own nonce when absent. */
  nonce?: string;
  /** Google's signature check throws. */
  reject?: boolean;
}

/** The callback request's cookies and headers. */
export interface CallbackRequest {
  /** The bind cookie the browser sends instead of the begin's own; "" sends none. */
  bind?: string;
  /** More cookies on the callback host (consent). */
  cookie?: string;
  acceptLanguage?: string;
  /** Google's `error` instead of a code. */
  error?: string;
  /** The state to send instead of the begin's own. */
  state?: string;
}

/** ID token payloads by the token string the double hands out. */
const payloads = new Map<string, Record<string, unknown> | null>();

/**
 * Make the double answer as Google would: `getToken` hands out an ID token per
 * code, `verifyIdToken` answers the payload registered for that token.
 * @param double - The suite's double.
 */
export function answerGoogleFrom(double: GoogleDouble): void {
  double.getToken.mockImplementation(async (opts: { code: string }) => ({
    tokens: { id_token: `id-token:${opts.code}` },
    res: null,
  }));
  double.verifyIdToken.mockImplementation(async (opts: { idToken: string }) => {
    const payload = payloads.get(opts.idToken);
    if (!payload) throw new Error("Invalid token signature");
    return { getPayload: () => payload };
  });
}

/**
 * POST the begin form as the sign-in page does.
 * @param app - The public app.
 * @param req - The begin request's headers.
 * @param fields - The form fields.
 * @returns The response.
 */
export async function postBegin(app: Requestable, req: BeginRequest, fields: BeginFields = {}): Promise<Response> {
  const form = new URLSearchParams({
    page: fields.page ?? "register",
    next: fields.next ?? "/studio",
    locale: fields.locale ?? "en",
  });
  if (fields.attribution !== undefined) form.set("attribution", JSON.stringify(fields.attribution));
  if (fields.referralCode !== undefined) form.set("referralCode", fields.referralCode);
  if (fields.referralSource !== undefined) form.set("referralSource", fields.referralSource);
  return await app.request(`${req.origin ?? "http://localhost:8000"}/api/v1/auth/google/begin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(req.origin ? { Origin: req.origin } : {}),
      ...(req.cookie ? { Cookie: req.cookie } : {}),
      ...(req.acceptLanguage ? { "Accept-Language": req.acceptLanguage } : {}),
      ...(req.realIp ? { "x-real-ip": req.realIp } : {}),
    },
    body: form.toString(),
  });
}

/**
 * Read a begin that sent the browser to Google.
 * @param res - The begin response.
 * @returns The parts the browser carries on.
 */
export function begun(res: Response): Begun {
  expect(res.status).toBe(303);
  const toGoogle = new URL(res.headers.get("location") ?? "");
  expect(toGoogle.hostname).toBe("accounts.google.com");
  const bind = res.headers.getSetCookie().find((c) => c.startsWith("breatic_google_bind="))?.split(";")[0] ?? "";
  expect(bind).toMatch(/^breatic_google_bind=.+/);
  return {
    res,
    toGoogle,
    state: toGoogle.searchParams.get("state") ?? "",
    nonce: toGoogle.searchParams.get("nonce") ?? "",
    codeChallenge: toGoogle.searchParams.get("code_challenge") ?? "",
    redirectUri: toGoogle.searchParams.get("redirect_uri") ?? "",
    bind,
  };
}

/**
 * Begin a sign-in and read where it sent the browser.
 * @param app - The public app.
 * @param req - The begin request's headers.
 * @param fields - The form fields.
 * @returns The begun sign-in.
 */
export async function begin(app: Requestable, req: BeginRequest, fields: BeginFields = {}): Promise<Begun> {
  return begun(await postBegin(app, req, fields));
}

/**
 * Come back from Google to the callback the begin named.
 * @param app - The public app.
 * @param b - The begun sign-in.
 * @param answer - What Google says about the account.
 * @param req - The callback request's cookies and headers.
 * @returns The callback response.
 */
export async function callback(app: Requestable, b: Begun, answer: GoogleAnswer, req: CallbackRequest = {}): Promise<Response> {
  const url = new URL(b.redirectUri);
  url.searchParams.set("state", req.state ?? b.state);
  if (req.error) {
    url.searchParams.set("error", req.error);
  } else {
    const code = `code-${randomUUID()}`;
    payloads.set(
      `id-token:${code}`,
      answer.reject
        ? null
        : {
          iss: answer.iss ?? "https://accounts.google.com",
          aud: GOOGLE_CLIENT_ID,
          sub: answer.sub,
          email: answer.email,
          email_verified: answer.emailVerified ?? true,
          nonce: answer.nonce ?? b.nonce,
          ...(answer.hd ? { hd: answer.hd } : {}),
        },
    );
    url.searchParams.set("code", code);
  }
  const cookie = [req.bind ?? b.bind, req.cookie].filter(Boolean).join("; ");
  return await app.request(url.toString(), {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(req.acceptLanguage ? { "Accept-Language": req.acceptLanguage } : {}),
    },
  });
}

/**
 * Begin, then come back from Google, as one browser.
 * @param app - The public app.
 * @param req - The begin request's headers.
 * @param answer - What Google says about the account.
 * @param fields - The form fields.
 * @param back - The callback request's cookies and headers.
 * @returns The begun sign-in, the callback response and where it sent the browser.
 */
export async function signInWithGoogle(
  app: Requestable,
  req: BeginRequest,
  answer: GoogleAnswer,
  fields: BeginFields = {},
  back: CallbackRequest = {},
): Promise<{ begun: Begun; res: Response; location: URL }> {
  const b = await begin(app, req, fields);
  const res = await callback(app, b, answer, back);
  return { begun: b, res, location: redirectOf(res) };
}

/**
 * Where a 303 sends the browser.
 * @param res - The response.
 * @returns The Location as a URL.
 */
export function redirectOf(res: Response): URL {
  expect(res.status).toBe(303);
  return new URL(res.headers.get("location") ?? "");
}

/**
 * The whole `Set-Cookie` line whose name is exactly `name`.
 * @param res - The response.
 * @param name - The cookie name.
 * @returns The line, or undefined.
 */
export function cookieLine(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

/**
 * The PKCE S256 challenge of a verifier.
 * @param verifier - The code verifier.
 * @returns base64url(sha256(verifier)).
 */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
