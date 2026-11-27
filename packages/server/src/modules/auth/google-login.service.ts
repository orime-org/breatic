// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Full-page Google sign-in (inner#2157 design 7.9): begin stores the
 * sign-in under a random part of the OAuth `state` and sends the browser to
 * Google; the callback takes it back once, checks the browser's bind value,
 * exchanges the code with the PKCE verifier and checks the ID token.
 *
 * Every site uses one callback while `COOKIE_DOMAIN` is set (site-wide
 * sign-in), so the state also carries the site and page the sign-in started
 * from; that is where the browser goes back to.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { cookieDomainHost, env, frontendOrigin, getRedis } from "@breatic/core";
import { ConsentSnapshotSchema, SIGNUP_REFERRAL_SOURCES, normalizeEmail, type ConsentSnapshot } from "@breatic/shared";
import { getGoogleLoginConfig } from "@server/config/auth.js";
import type { SignupReferral } from "@server/modules/auth/auth.service.js";

/** The page a sign-in starts from and returns to. */
export type GooglePage = "login" | "register";

/** Why a sign-in comes back without a session. */
export type GoogleFailure =
  | "cancelled"
  | "expired"
  | "rate_limited"
  | "unavailable"
  | "invalid_credential"
  | "email_unverified"
  | "link_requires_email_login"
  | "referral_invalid";

const storedSchema = z.object({
  origin: z.string(),
  page: z.enum(["login", "register"]),
  next: z.string().optional(),
  locale: z.string(),
  consent: ConsentSnapshotSchema,
  attribution: z.unknown().optional(),
  referral: z.object({ code: z.string(), source: z.enum(SIGNUP_REFERRAL_SOURCES) }).optional(),
  codeVerifier: z.string(),
  nonce: z.string(),
  bindHash: z.string(),
});

/** A started sign-in, as begin stored it. */
export type StoredGoogleLogin = z.infer<typeof storedSchema>;

/** What begin hands the route. */
export interface BegunGoogleLogin {
  authUrl: string;
  bind: string;
  ttlSeconds: number;
}

/**
 * Whether Google sign-in is offered: both the client id and its secret are set.
 * @returns True when configured.
 */
export function googleSignInAvailable(): boolean {
  return env.GOOGLE_CLIENT_ID !== "" && env.GOOGLE_CLIENT_SECRET !== "";
}

/**
 * Where Google sends the browser back: one official callback while sign-in
 * is site-wide, otherwise the starting site's own; under `API_PUBLIC_URL`
 * when the API is on its own host.
 * @param origin - The site the sign-in starts from.
 * @returns The redirect URI.
 * @throws {Error} If no valid HTTP frontend origin is configured.
 */
export function callbackUrl(origin: string): string {
  const site = cookieDomainHost() === "" ? origin : frontendOrigin();
  const api = env.API_PUBLIC_URL === "" ? `${site}/api/v1` : env.API_PUBLIC_URL.replace(/\/+$/, "");
  return `${api}/auth/google/callback`;
}

/**
 * The OAuth client for this deployment's current settings.
 * @returns A fresh client.
 */
function client(): OAuth2Client {
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
}

/**
 * The Redis key of one started sign-in.
 * @param random - The state's random part.
 * @returns The key.
 */
function loginKey(random: string): string {
  return `${env.ENV}:google-login:${random}`;
}

/**
 * A url-safe random value.
 * @returns 32 random bytes, base64url.
 */
function random32(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The hash a bind value is stored as.
 * @param bind - The browser's bind value.
 * @returns Its sha256, hex.
 */
function hashBind(bind: string): string {
  return createHash("sha256").update(bind).digest("hex");
}

/**
 * Store a sign-in and build the Google authorization URL.
 * @param input - What the page posted and what begin read.
 * @param input.origin - The trusted site the sign-in starts from.
 * @param input.page - Its page.
 * @param input.next - Where the page goes after signing in.
 * @param input.locale - The account language a new account gets.
 * @param input.consent - The consent the starting site's browser gave.
 * @param input.attribution - The campaign source the page posted.
 * @param input.referral - The referral code the page posted.
 * @returns The authorization URL and the bind value for the browser.
 * @throws {Error} When Redis cannot store the sign-in.
 */
export async function beginGoogleLogin(input: {
  origin: string;
  page: GooglePage;
  next?: string;
  locale: string;
  consent: ConsentSnapshot;
  attribution?: unknown;
  referral?: SignupReferral;
}): Promise<BegunGoogleLogin> {
  const random = random32();
  const codeVerifier = random32();
  const nonce = random32();
  const bind = random32();
  const ttlSeconds = getGoogleLoginConfig().stateTtlSeconds;
  const stored: StoredGoogleLogin = {
    origin: input.origin,
    page: input.page,
    ...(input.next === undefined ? {} : { next: input.next }),
    locale: input.locale,
    consent: { analytics: input.consent.analytics, ads: input.consent.ads },
    ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    ...(input.referral === undefined ? {} : { referral: input.referral }),
    codeVerifier,
    nonce,
    bindHash: hashBind(bind),
  };
  await getRedis().set(loginKey(random), JSON.stringify(stored), "EX", ttlSeconds);
  const state = `${random}.${Buffer.from(JSON.stringify([input.origin, input.page])).toString("base64url")}`;
  const authUrl = client().generateAuthUrl({
    redirect_uri: callbackUrl(input.origin),
    response_type: "code",
    scope: ["openid", "email", "profile"],
    state,
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    code_challenge_method: CodeChallengeMethod.S256,
    nonce,
    prompt: "select_account",
  });
  return { authUrl, bind, ttlSeconds };
}

/**
 * Split a state into its random part and the site and page it names.
 * @param state - The callback's `state`.
 * @returns The parts, or null when the state is not ours.
 */
export function parseState(state: string | undefined): { random: string; origin: string; page: GooglePage } | null {
  const [random, site, ...rest] = (state ?? "").split(".");
  if (!random || !site || rest.length > 0) return null;
  try {
    const parsed = z.tuple([z.string(), z.enum(["login", "register"])])
      .safeParse(JSON.parse(Buffer.from(site, "base64url").toString("utf8")));
    return parsed.success ? { random, origin: parsed.data[0], page: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

/**
 * Take a started sign-in back, once.
 * @param random - The state's random part.
 * @returns The sign-in, or null when it expired, was used or never existed.
 * @throws {Error} When Redis cannot be read.
 */
export async function takeGoogleLogin(random: string): Promise<StoredGoogleLogin | null> {
  const raw = await getRedis().getdel(loginKey(random));
  if (raw === null) return null;
  const parsed = storedSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the callback's browser is the one that started the sign-in.
 * @param stored - The started sign-in.
 * @param bind - The bind cookie the callback carried.
 * @returns True when the bind value matches.
 */
export function bindMatches(stored: StoredGoogleLogin, bind: string | undefined): boolean {
  if (!bind) return false;
  const a = Buffer.from(hashBind(bind));
  const b = Buffer.from(stored.bindHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The verified Google identity, or why there is none. */
export type GoogleIdentity =
  | { ok: true; sub: string; email: string; authoritativeEmail: boolean }
  | { ok: false; reason: "invalid_credential" | "email_unverified"; err?: unknown };

const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

/**
 * Exchange the code and check the ID token: signature, audience, issuer,
 * expiry, the begin's nonce and a verified address.
 * @param stored - The started sign-in.
 * @param code - The authorization code Google returned.
 * @returns The identity, or why it was refused.
 */
export async function verifyGoogleCode(stored: StoredGoogleLogin, code: string): Promise<GoogleIdentity> {
  const oauth = client();
  let payload: Record<string, unknown> | undefined;
  try {
    const { tokens } = await oauth.getToken({ code, codeVerifier: stored.codeVerifier, redirect_uri: callbackUrl(stored.origin) });
    if (!tokens.id_token) return { ok: false, reason: "invalid_credential" };
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload() as Record<string, unknown> | undefined;
  } catch (err) {
    return { ok: false, reason: "invalid_credential", err };
  }
  if (!payload) return { ok: false, reason: "invalid_credential" };
  const { iss, sub, email, nonce, hd } = payload;
  if (typeof iss !== "string" || !VALID_ISSUERS.has(iss)) return { ok: false, reason: "invalid_credential" };
  if (nonce !== stored.nonce) return { ok: false, reason: "invalid_credential" };
  if (typeof sub !== "string" || sub === "" || typeof email !== "string" || email === "") {
    return { ok: false, reason: "invalid_credential" };
  }
  if (payload["email_verified"] !== true) return { ok: false, reason: "email_unverified" };
  const normalized = normalizeEmail(email);
  return { ok: true, sub, email: normalized, authoritativeEmail: normalized.endsWith("@gmail.com") || Boolean(hd) };
}
