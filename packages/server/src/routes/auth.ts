// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Auth routes - registration, login, and logout.
 *
 * All endpoints validate request bodies with Zod schemas and
 * delegate business logic to the auth service.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { OAuth2Client } from "google-auth-library";
import type { TokenPayload } from "google-auth-library";

import { registerSchema, loginSchema, setupStudioSchema } from "@server/routes/schemas.js";
import { z } from "zod";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { authService, studioService } from "@server/modules";
import { env } from "@breatic/core";
import { logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
} from "@server/middleware/session-cookie.js";
import { logMailResult } from "@server/utils/log-mail.js";

const auth = new Hono<{ Variables: AuthVariables }>();

/**
 * Lazily constructed Google OAuth2 client.
 *
 * Built on first use instead of module load so that self-hosted
 * installs without Google OAuth can boot without `GOOGLE_CLIENT_ID`.
 */
let _googleClient: OAuth2Client | null = null;
/**
 * Lazily build and cache the Google OAuth2 client from `GOOGLE_CLIENT_ID`.
 * @returns The cached {@link OAuth2Client}, constructed on first use.
 */
function getGoogleClient(): OAuth2Client {
  if (!_googleClient) {
    _googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);
  }
  return _googleClient;
}

/**
 * `POST /auth/register` - create a new user account (step 1 of 2).
 *
 * Creates the account only — NO personal studio. The user picks their
 * slug in the second step (`POST /auth/setup-studio`); until then
 * `/auth/me` reports `personalStudio: null` and the frontend gate forces
 * the slug-setup page (email-registration rewrite, 2026-06-06).
 *
 * Returns a one-time `recoveryCode` (XXXX-XXXX-XXXX-XXXX format) the
 * frontend MUST display to the user with a "save this now" modal -
 * it's the only way to reset password when EMAIL_BACKEND=disabled
 * (self-host default). The code is rotated on every successful
 * recovery-based reset; only the bcrypt hash is stored server-side.
 *
 * Session is delivered as an httpOnly `breatic_session` cookie (the
 * frontend never sees the raw token - XSS cannot exfiltrate it).
 * Response body returns the user plus the one-time `recoveryCode`.
 * @param c - Hono context with validated `registerSchema` body
 * @returns `201` with `{ user, recoveryCode }` on success + Set-Cookie
 * @throws {AppError} `409` if email is already registered
 */
auth.post("/register", rateLimitFor("register"), zValidator("json", registerSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const { user, recoveryCode } = await authService.register(email, password);
  const { token } = await authService.loginEmail(email, password);
  setSessionCookie(c, token);
  // Audit log moved here from auth.service.ts per CLAUDE.md
  // "core and shared must not log" mandate. The route handler is
  // the application boundary that owns request context.
  logger.info({ userId: user.id, email }, "user_registered");
  logger.info({ userId: user.id, method: "email" }, "user_logged_in");
  return c.json({ data: { user, recoveryCode } }, 201);
});

/**
 * `POST /auth/setup-studio` - create the user's personal studio (step 2).
 *
 * The authenticated-but-studio-less user picks their slug. The slug
 * format is validated by `setupStudioSchema` (lowercase handle, 6–39
 * chars); the service re-checks uniqueness against `studios.slug` and
 * creates `studios` (slug = name = chosen slug, type='personal') + the
 * creator's admin `studio_members` row atomically. A concurrent
 * duplicate slug that loses the pre-check race is caught by the
 * `studios_slug_idx` unique index → `ConflictError` → 409 (never 500).
 * @param c - Hono context with validated `setupStudioSchema` body + authed user
 * @returns `201` with `{ personalStudio: { name, slug } }`
 * @throws {AppError} `409` if the slug is already taken (or the user
 *   already has a personal studio)
 */
auth.post("/setup-studio", requireAuth, zValidator("json", setupStudioSchema), async (c) => {
  const user = c.get("user");
  const { slug } = c.req.valid("json");
  const studio = await studioService.createPersonalStudio(user.id, slug);
  logger.info({ userId: user.id, studioId: studio.id, slug }, "personal_studio_created");
  return c.json({ data: { personalStudio: { name: studio.name, slug: studio.slug } } }, 201);
});

/**
 * `POST /auth/login` - authenticate with email and password.
 *
 * Session is delivered as an httpOnly cookie (see `/register` for
 * rationale); response body returns only the user.
 * @param c - Hono context with validated `loginSchema` body
 * @returns `200` with `{ user }` on success + Set-Cookie
 * @throws {AppError} `401` if credentials are invalid
 */
auth.post("/login", rateLimitFor("login"), zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const { user, token } = await authService.loginEmail(email, password);
  setSessionCookie(c, token);
  // Audit log moved from auth.service.ts (17B mandate).
  logger.info({ userId: user.id, method: "email" }, "user_logged_in");
  return c.json({ data: { user } });
});

/**
 * `POST /auth/logout` - invalidate the current session.
 *
 * Requires a valid Bearer token in the Authorization header.
 * @param c - Hono context with authenticated user
 * @returns `200` with `{ message: "Logged out" }`
 */
const googleAuthSchema = z.object({
  credential: z.string().min(1),
});

/**
 * `POST /auth/google` - authenticate with a Google ID token.
 *
 * The ID token must be verified cryptographically - otherwise any
 * attacker can craft a fake JWT with a victim's email and take over
 * their account. Delegation to `OAuth2Client.verifyIdToken` gives us:
 *
 *   - RS256 signature verified against Google's rotating JWKS
 *   - `iss` pinned to https://accounts.google.com (or accounts.google.com)
 *   - `aud` pinned to our `GOOGLE_CLIENT_ID`
 *   - `exp` / `iat` enforced
 *
 * We additionally require `email_verified === true` so that an attacker
 * who registers `victim@gmail.com` at an identity provider that
 * federates to Google (and doesn't verify ownership) cannot claim
 * someone else's email.
 * @param c - Hono context with Google credential in body
 * @returns `200` with `{ data: { user, token } }`
 * @throws {AppError} `401` if the credential is invalid, expired, or unverified
 * @throws {AppError} `503` if Google OAuth is not configured on this server
 */
auth.post("/google", rateLimitFor("google"), zValidator("json", googleAuthSchema), async (c) => {
  if (!env.GOOGLE_CLIENT_ID) {
    logger.warn("google_oauth_unconfigured");
    return c.json({ error: { code: 503, message: t("server.auth.google_oauth_unconfigured") } }, 503);
  }

  const { credential } = c.req.valid("json");

  let payload: TokenPayload | undefined;

  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "google_id_token_verification_failed");
    return c.json({ error: { code: 401, message: t("server.auth.invalid_google_credential") } }, 401);
  }

  if (!payload) {
    return c.json({ error: { code: 401, message: t("server.auth.invalid_google_credential") } }, 401);
  }

  // `verifyIdToken` already enforces aud/iss/exp, but double-check iss
  // in case the library ever changes defaults. Google emits both forms.
  const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
  if (!payload.iss || !VALID_ISSUERS.has(payload.iss)) {
    return c.json({ error: { code: 401, message: t("server.auth.invalid_google_credential") } }, 401);
  }

  if (!payload.sub || !payload.email) {
    return c.json({ error: { code: 401, message: t("server.auth.invalid_google_credential") } }, 401);
  }

  if (payload.email_verified !== true) {
    return c.json({ error: { code: 401, message: t("server.auth.google_email_unverified") } }, 401);
  }

  const { user, token } = await authService.loginOrCreateGoogle(
    payload.sub,
    payload.email,
    payload.name,
    payload.picture,
  );

  setSessionCookie(c, token);
  // Audit log moved from auth.service.ts (17B mandate).
  logger.info({ userId: user.id, method: "google" }, "user_logged_in");
  return c.json({ data: { user } });
});

/**
 * `GET /auth/me` - get the current authenticated user + onboarding state.
 *
 * `personalStudio` is the onboarding-gate data source: `null` means the
 * user registered (step 1) but has not yet picked a slug (step 2), so the
 * frontend gate routes them to the slug-setup page. Once set it carries
 * the studio `name` (the user's display name) + `slug` (their URL handle).
 * @param c - Hono context with authenticated user
 * @returns `200` with `{ data: { ...user, personalStudio: { name, slug } | null } }`
 */
auth.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const studio = await studioService.getPersonalStudio(user.id);
  const personalStudio = studio
    ? { name: studio.name, slug: studio.slug }
    : null;
  return c.json({ data: { ...user, personalStudio } });
});

auth.post("/logout", requireAuth, async (c) => {
  const token = readSessionCookie(c);
  if (token) {
    await authService.logout(token);
  }
  clearSessionCookie(c);
  return c.json({ message: t("server.auth.logout_success") });
});

// ── Password Reset ───────────────────────────────────────────────

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

auth.post(
  "/forgot-password",
  rateLimitFor("forgot"),
  zValidator("json", forgotPasswordSchema),
  async (c) => {
    const { email } = c.req.valid("json");
    const resetBaseUrl = c.req.header("Origin")
      ? `${c.req.header("Origin")}/reset-password`
      : "http://localhost:8000/reset-password";

    const result = await authService.forgotPassword(email, resetBaseUrl);
    // Audit log moved from auth.service.ts (17B mandate). The
    // discriminant tells us internally which branch ran without
    // ever leaking it to the client - anti-enumeration preserved
    // because the response body below is the same in both cases.
    if (result.status === "unknown_email") {
      logger.info({ email }, "password_reset_unknown_email");
    } else {
      logger.info(
        { userId: result.userId, email, mailStatus: result.mailResult.status },
        "password_reset_email_sent",
      );
      logMailResult(result.mailResult, { userId: result.userId, subject: "password_reset" });
    }

    // Always return success (don't reveal if email exists)
    return c.json({ message: t("server.auth.reset_link_sent") });
  },
);

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

auth.post(
  "/reset-password",
  rateLimitFor("reset"),
  zValidator("json", resetPasswordSchema),
  async (c) => {
    const { token, password } = c.req.valid("json");
    await authService.resetPassword(token, password);
    // Audit log moved from auth.service.ts (17B mandate). The
    // service deliberately does not return userId here (token is
    // single-use + already consumed at this point), so we log
    // the token prefix to keep correlation across logs without
    // re-exposing the full reset token.
    logger.info(
      { tokenPrefix: token.slice(0, 8) },
      "password_reset_completed",
    );
    return c.json({ message: t("server.auth.reset_success") });
  },
);

// ── Recovery code reset (self-host, no SMTP needed) ──────────────

const resetWithRecoveryCodeSchema = z.object({
  email: z.string().email(),
  recoveryCode: z.string().min(1),
  newPassword: z.string().min(8),
});

/**
 * `POST /auth/reset-password-with-recovery-code` - reset password
 * using the one-time recovery code from registration.
 *
 * Returns a fresh recovery code on success - frontend (PR-b) MUST
 * re-display it with the same "save this now" modal as registration.
 * Rate limited 5/hour per IP to slow online code-guessing attacks
 * (80 bits of entropy makes offline infeasible already, but rate
 * limit hardens the online surface).
 * @returns `200` with `{ data: { newRecoveryCode } }`
 * @throws {AppError} `401` on any failure (uniform: email-not-found / code-used /
 *   code-mismatch all surface as "Invalid email or recovery code"
 *   to avoid leaking which condition matched)
 */
auth.post(
  "/reset-password-with-recovery-code",
  rateLimitFor("reset-recovery"),
  zValidator("json", resetWithRecoveryCodeSchema),
  async (c) => {
    const { email, recoveryCode, newPassword } = c.req.valid("json");
    const { newRecoveryCode, userId } = await authService.resetPasswordWithRecoveryCode(
      email,
      recoveryCode,
      newPassword,
    );
    // Audit log moved from auth.service.ts (17B mandate).
    logger.info({ userId }, "password_reset_via_recovery_code");
    return c.json({
      data: { newRecoveryCode },
      message: t("server.auth.reset_recovery_success"),
    });
  },
);

// ── Email verification (PR-a task 9) ─────────────────────────────

const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

/**
 * `POST /auth/verify-email` - consume one-time verify token.
 *
 * Token is generated by `resendVerificationEmail` and delivered via
 * email; user clicks the link, frontend POSTs the token here. On
 * success the user's `email_verified` flips true and the Redis key
 * is deleted (single-use).
 * @returns `200` on success
 * @throws {AppError} `401` if the token is invalid / expired / already consumed
 */
auth.post(
  "/verify-email",
  rateLimitFor("verify-email"),
  zValidator("json", verifyEmailSchema),
  async (c) => {
    const { token } = c.req.valid("json");
    const { userId } = await authService.verifyEmail(token);
    // Audit log moved from auth.service.ts (17B mandate).
    logger.info({ userId }, "email_verified");
    return c.json({ message: t("server.auth.email_verified") });
  },
);

/**
 * `POST /auth/resend-verification-email` - request a fresh verification
 * email for the currently authenticated user.
 *
 * Rate-limited 1/min per user (prevents flooding inboxes). No-op for
 * already-verified users - returns success without sending.
 * @returns `200` on success (even if user already verified, to keep
 *   the UX simple - frontend can just say "check your inbox").
 */
auth.post(
  "/resend-verification-email",
  requireAuth,
  rateLimitFor("resend-verify"),
  async (c) => {
    const user = c.get("user");
    const verifyBaseUrl = c.req.header("Origin")
      ? `${c.req.header("Origin")}/verify-email`
      : "http://localhost:8000/verify-email";
    const { mailResult } = await authService.resendVerificationEmail(
      user.id,
      user.email,
      verifyBaseUrl,
    );
    // Audit log moved from auth.service.ts (17B mandate).
    logger.info(
      { userId: user.id, mailStatus: mailResult.status },
      "verification_email_sent",
    );
    logMailResult(mailResult, { userId: user.id, subject: "email_verification" });
    return c.json({ message: t("server.auth.verify_email_sent") });
  },
);

export { auth as authRoute };
