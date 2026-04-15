/**
 * Auth routes — registration, login, and logout.
 *
 * All endpoints validate request bodies with Zod schemas and
 * delegate business logic to the auth service.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { OAuth2Client } from "google-auth-library";
import type { TokenPayload } from "google-auth-library";

import { registerSchema, loginSchema } from "./schemas.js";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import type { AuthVariables } from "../middleware/auth.js";
import { authService } from "@breatic/core";
import { env } from "@breatic/core";
import { logger } from "@breatic/core";
import { checkRateLimit, getRedis } from "@breatic/core";
import type { MiddlewareHandler } from "hono";

/** Rate limit middleware factory. */
function rateLimit(opts: { prefix: string; max: number; windowSeconds: number }): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const redis = getRedis();
    const allowed = await checkRateLimit(redis, `${opts.prefix}:${ip}`, opts.max, opts.windowSeconds);
    if (!allowed) {
      return c.json(
        { error: { code: 429, message: "Too many requests. Try again later." } },
        429,
        { "Retry-After": String(opts.windowSeconds) },
      );
    }
    await next();
  };
}

const auth = new Hono<{ Variables: AuthVariables }>();

/**
 * Lazily constructed Google OAuth2 client.
 *
 * Built on first use instead of module load so that self-hosted
 * installs without Google OAuth can boot without `GOOGLE_CLIENT_ID`.
 */
let _googleClient: OAuth2Client | null = null;
function getGoogleClient(): OAuth2Client {
  if (!_googleClient) {
    _googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);
  }
  return _googleClient;
}

/**
 * `POST /auth/register` — create a new user account.
 *
 * @param c - Hono context with validated `registerSchema` body
 * @returns `201` with `{ user, token }` on success
 * @throws `409` if email is already registered
 */
auth.post("/register", rateLimit({ prefix: "register", max: 3, windowSeconds: 3600 }), zValidator("json", registerSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const user = await authService.register(email, password);
  const { token } = await authService.loginEmail(email, password);
  return c.json({ data: { user, token } }, 201);
});

/**
 * `POST /auth/login` — authenticate with email and password.
 *
 * @param c - Hono context with validated `loginSchema` body
 * @returns `200` with `{ user, token }` on success
 * @throws `401` if credentials are invalid
 */
auth.post("/login", rateLimit({ prefix: "login", max: 5, windowSeconds: 60 }), zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const { user, token } = await authService.loginEmail(email, password);
  return c.json({ data: { user, token } });
});

/**
 * `POST /auth/logout` — invalidate the current session.
 *
 * Requires a valid Bearer token in the Authorization header.
 *
 * @param c - Hono context with authenticated user
 * @returns `200` with `{ message: "Logged out" }`
 */
const googleAuthSchema = z.object({
  credential: z.string().min(1),
});

/**
 * `POST /auth/google` — authenticate with a Google ID token.
 *
 * The ID token must be verified cryptographically — otherwise any
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
 *
 * @param c - Hono context with Google credential in body
 * @returns `200` with `{ data: { user, token } }`
 * @throws `401` if the credential is invalid, expired, or unverified
 * @throws `503` if Google OAuth is not configured on this server
 */
auth.post("/google", rateLimit({ prefix: "google", max: 10, windowSeconds: 60 }), zValidator("json", googleAuthSchema), async (c) => {
  if (!env.GOOGLE_CLIENT_ID) {
    logger.warn("google_oauth_unconfigured");
    return c.json({ error: "Google OAuth is not configured on this server" }, 503);
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
    return c.json({ error: "Invalid Google credential" }, 401);
  }

  if (!payload) {
    return c.json({ error: "Invalid Google credential: empty payload" }, 401);
  }

  // `verifyIdToken` already enforces aud/iss/exp, but double-check iss
  // in case the library ever changes defaults. Google emits both forms.
  const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
  if (!payload.iss || !VALID_ISSUERS.has(payload.iss)) {
    return c.json({ error: "Invalid Google credential: wrong issuer" }, 401);
  }

  if (!payload.sub || !payload.email) {
    return c.json({ error: "Invalid Google credential: missing sub or email" }, 401);
  }

  if (payload.email_verified !== true) {
    return c.json({ error: "Google account email is not verified" }, 401);
  }

  const { user, token } = await authService.loginOrCreateGoogle(
    payload.sub,
    payload.email,
    payload.name,
    payload.picture,
  );

  return c.json({ data: { user, token } });
});

/**
 * `GET /auth/me` — get the current authenticated user.
 *
 * @param c - Hono context with authenticated user
 * @returns `200` with `{ data: UserEntity }`
 */
auth.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  return c.json({ data: user });
});

auth.post("/logout", requireAuth, async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.slice(7);
  await authService.logout(token);
  return c.json({ message: "Logged out" });
});

export { auth as authRoute };
