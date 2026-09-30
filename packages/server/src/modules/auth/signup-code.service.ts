// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Email sign-up with a code (#287), used while an email backend is enabled.
 *
 * A pending sign-up lives in Redis under the browser's ticket — a random
 * value held only in an httpOnly cookie — so another browser submitting the
 * same address starts its own pending sign-up and can never change this
 * one's password. The account row is written only after the code matches.
 *
 * The resend wait is per address (normalized), so an address receives at
 * most one new code per wait whoever asks. A code allows a fixed number of
 * comparisons; each comparison takes one before it is made, inside one Lua
 * script, so concurrent requests cannot compare more times than that.
 */

import crypto from "node:crypto";

import * as userRepo from "@server/modules/auth/user.repo.js";
import { hashPassword } from "@server/modules/auth/auth.service.js";
import { buildSignupCodeMail } from "@server/modules/auth/auth-mail.js";
import { getSignupCodeConfig } from "@server/config/auth.js";
import { logMailResult } from "@server/utils/log-mail.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import {
  AppError,
  ConflictError,
  TooManyRequestsError,
  env,
  getRedis,
  logger,
  sendMail,
} from "@breatic/core";
import { t } from "@breatic/shared";
import type { UserEntity } from "@breatic/shared";

const CODE_SPACE = 1_000_000;
const CODE_DIGITS = 6;
const TICKET_BYTES = 32;
const MS_PER_SECOND = 1000;
const HTTP_BAD_REQUEST = 400;
const HTTP_GONE = 410;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;

/** What the page needs after a code went out (or is still valid). */
export interface SignupCodeSent {
  /** The browser's ticket; the route puts it in the cookie. */
  ticket: string;
  /** How long the current code and the pending sign-up live. */
  expiresInSeconds: number;
  /** How long until this address can be sent another code. */
  resendAfterSeconds: number;
}

/**
 * Whether an email sign-up must prove the address with a code. True for the
 * backends that deliver (smtp) or show (console) the mail.
 * @returns `true` unless `EMAIL_BACKEND` is `disabled`.
 */
export function emailVerificationEnabled(): boolean {
  return env.EMAIL_BACKEND !== "disabled";
}

/**
 * The form of an address two sign-ups are compared in: casing and
 * surrounding space do not change which mailbox receives the code.
 * @param email - The address as typed.
 * @returns The trimmed, lower-cased address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A uniformly random six-digit code, zero-padded.
 * @returns Six decimal digits.
 */
export function generateSignupCode(): string {
  return crypto.randomInt(0, CODE_SPACE).toString().padStart(CODE_DIGITS, "0");
}

/**
 * SHA-256 hex of a value, the form tickets, addresses and codes are stored in.
 * @param value - The value to hash.
 * @returns 64 hex characters.
 */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Redis key of a pending sign-up.
 * @param ticket - The browser's ticket.
 * @returns The key.
 */
function signupKey(ticket: string): string {
  return `${env.ENV}:signup:${sha256(ticket)}`;
}

/**
 * Redis key of an address's resend wait.
 * @param email - The address as typed.
 * @returns The key.
 */
function cooldownKey(email: string): string {
  return `${env.ENV}:signup-cooldown:${sha256(normalizeEmail(email))}`;
}

/**
 * Refuse with the wait that is left.
 * @param ms - Milliseconds left on the wait.
 * @throws {TooManyRequestsError} always.
 */
function refuseUntil(ms: number): never {
  const seconds = Math.max(1, Math.ceil(ms / MS_PER_SECOND));
  throw new TooManyRequestsError(t("server.auth.signup_resend_cooldown", { seconds }), seconds);
}

/**
 * Take the address's resend wait, or refuse with what is left of it.
 * @param email - The address as typed.
 * @throws {TooManyRequestsError} when the address is still waiting.
 */
async function takeCooldown(email: string): Promise<void> {
  const { resendCooldownSeconds } = getSignupCodeConfig();
  const key = cooldownKey(email);
  const taken = await getRedis().set(key, "1", "EX", resendCooldownSeconds, "NX");
  if (taken === "OK") return;
  refuseUntil(await getRedis().pttl(key));
}

/**
 * Put a new code on a pending sign-up that still exists, with a fresh count
 * and lifetime. A sign-up that expired meanwhile is left gone.
 *
 * KEYS[1] pending sign-up · ARGV[1] sha256 of the code · ARGV[2] lifetime in seconds.
 * Returns 1 stored · 0 no such sign-up.
 */
const STORE_CODE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'codeHash', ARGV[1], 'attempts', '0')
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * Replace the password and language of a pending sign-up for the same
 * address, keeping its lifetime. A pending sign-up for another address is
 * deleted.
 *
 * KEYS[1] pending sign-up · ARGV[1] normalized address · ARGV[2] address as
 * typed · ARGV[3] password hash · ARGV[4] language.
 * Returns the milliseconds the sign-up has left · 0 no such sign-up or another address.
 */
const UPDATE_PENDING_SCRIPT = `
local held = redis.call('HGET', KEYS[1], 'emailKey')
if held ~= ARGV[1] then
  if held then redis.call('DEL', KEYS[1]) end
  return 0
end
local left = redis.call('PTTL', KEYS[1])
if left <= 0 then return 0 end
redis.call('HSET', KEYS[1], 'email', ARGV[2], 'passwordHash', ARGV[3], 'locale', ARGV[4])
return left
`;

/**
 * Mail a fresh code and, once it is out, store its hash on the pending
 * sign-up with a fresh count and lifetime. The caller already holds the
 * address's wait; a mail that did not go out gives the wait back.
 * @param ticket - The browser's ticket.
 * @param email - The address as typed.
 * @param locale - The language the mail is written in.
 * @returns What the page needs.
 * @throws {AppError} 503 when the mail was not sent.
 */
async function sendCode(ticket: string, email: string, locale: string): Promise<SignupCodeSent> {
  const { ttlSeconds, resendCooldownSeconds } = getSignupCodeConfig();
  const code = generateSignupCode();
  const result = await sendMail(
    await buildSignupCodeMail({ locale, to: email, code, expiresInSeconds: ttlSeconds }),
  ).catch(async (err: unknown) => {
    await getRedis().del(cooldownKey(email));
    logger.error({ err, subject: "signup_code" }, "signup_code_send_threw");
    throw new AppError(HTTP_UNAVAILABLE, t("server.auth.signup_code_send_failed"));
  });
  logMailResult(result, { subject: "signup_code" });
  if (result.status !== "sent" && result.status !== "backend_console") {
    await getRedis().del(cooldownKey(email));
    throw new AppError(HTTP_UNAVAILABLE, t("server.auth.signup_code_send_failed"));
  }
  const stored = await getRedis().eval(
    STORE_CODE_SCRIPT,
    1,
    signupKey(ticket),
    sha256(code),
    String(ttlSeconds),
  );
  if (stored === 0) throw new AppError(HTTP_GONE, t("server.auth.signup_expired"));
  return { ticket, expiresInSeconds: ttlSeconds, resendAfterSeconds: resendCooldownSeconds };
}

/**
 * Start (or continue) an email sign-up: mail a code to the address.
 *
 * The same browser submitting the same address again keeps its ticket and,
 * inside the resend wait, its code; the password is replaced by the latest
 * one typed. Anything else starts a new pending sign-up under a new ticket.
 * @param input - What the sign-up form sent, plus the browser's ticket.
 * @param input.ticket - The browser's ticket, or `null` when it has none.
 * @param input.email - The address as typed.
 * @param input.password - The password as typed.
 * @param input.locale - The language the request was made in; the mail is written in it.
 * @returns The ticket and the two timings the page shows.
 * @throws {ConflictError} when the address already has an account.
 * @throws {TooManyRequestsError} when the address is inside its resend wait.
 * @throws {AppError} 503 when the mail was not sent.
 */
export async function startSignup(input: {
  ticket: string | null;
  email: string;
  password: string;
  locale: string;
}): Promise<SignupCodeSent> {
  const email = input.email.trim();
  if (await userRepo.getUserByEmail(email)) {
    throw new ConflictError(t("server.auth.email_taken"));
  }
  const redis = getRedis();
  const passwordHash = await hashPassword(input.password);

  if (input.ticket !== null) {
    const leftMs = Number(
      await redis.eval(
        UPDATE_PENDING_SCRIPT,
        1,
        signupKey(input.ticket),
        normalizeEmail(email),
        email,
        passwordHash,
        input.locale,
      ),
    );
    if (leftMs > 0) {
      const waitMs = await redis.pttl(cooldownKey(email));
      if (waitMs > 0) {
        return {
          ticket: input.ticket,
          expiresInSeconds: Math.ceil(leftMs / MS_PER_SECOND),
          resendAfterSeconds: Math.ceil(waitMs / MS_PER_SECOND),
        };
      }
      await takeCooldown(email);
      return sendCode(input.ticket, email, input.locale);
    }
  }

  await takeCooldown(email);
  const ticket = crypto.randomBytes(TICKET_BYTES).toString("base64url");
  const key = signupKey(ticket);
  const { ttlSeconds } = getSignupCodeConfig();
  await redis
    .multi()
    .hset(key, { email, emailKey: normalizeEmail(email), passwordHash, locale: input.locale })
    .expire(key, ttlSeconds)
    .exec();
  try {
    return await sendCode(ticket, email, input.locale);
  } catch (err) {
    await redis.del(key);
    throw err;
  }
}

/**
 * Mail a new code for the browser's pending sign-up; the old code stops
 * working and the count starts again.
 * @param ticket - The browser's ticket, or `null` when it has none.
 * @returns The ticket and the two timings the page shows.
 * @throws {AppError} 410 when there is no such pending sign-up.
 * @throws {TooManyRequestsError} when the address is inside its resend wait.
 * @throws {AppError} 503 when the mail was not sent.
 */
export async function resendSignupCode(ticket: string | null): Promise<SignupCodeSent> {
  const pending =
    ticket === null ? null : await getRedis().hmget(signupKey(ticket), "email", "locale");
  const [email, locale] = pending ?? [null, null];
  if (ticket === null || email == null || locale == null) {
    throw new AppError(HTTP_GONE, t("server.auth.signup_expired"));
  }
  await takeCooldown(email);
  return sendCode(ticket, email, locale);
}

/**
 * Takes one comparison, then compares. On a match the pending sign-up is
 * claimed (read and deleted) in the same step so a code creates at most one
 * account.
 *
 * KEYS[1] pending sign-up · ARGV[1] sha256 of the submitted code · ARGV[2] comparisons allowed.
 * Returns {-1} missing · {-2} code used up · {0} wrong · {1, email, passwordHash, locale} match.
 */
const COMPARE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local limit = tonumber(ARGV[2])
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if n > limit then return {-2} end
if redis.call('HGET', KEYS[1], 'codeHash') == ARGV[1] then
  local fields = redis.call('HMGET', KEYS[1], 'email', 'passwordHash', 'locale')
  redis.call('DEL', KEYS[1])
  return {1, fields[1], fields[2], fields[3]}
end
if n == limit then return {-2} end
return {0}
`;

/**
 * Compare a code with the browser's pending sign-up and, on a match, write
 * the account with the address marked verified.
 * @param ticket - The browser's ticket, or `null` when it has none.
 * @param code - The code the reader typed.
 * @returns The new account.
 * @throws {AppError} 410 when there is no such pending sign-up.
 * @throws {AppError} 422 when this code has used up its comparisons.
 * @throws {AppError} 400 when the code does not match.
 * @throws {ConflictError} when the address got an account in the meantime.
 */
export async function verifySignupCode(ticket: string | null, code: string): Promise<UserEntity> {
  if (ticket === null) throw new AppError(HTTP_GONE, t("server.auth.signup_expired"));
  const { maxAttemptsPerCode } = getSignupCodeConfig();
  const reply = (await getRedis().eval(
    COMPARE_SCRIPT,
    1,
    signupKey(ticket),
    sha256(code),
    String(maxAttemptsPerCode),
  )) as [number, string?, string?, string?];

  switch (reply[0]) {
    case -1:
      throw new AppError(HTTP_GONE, t("server.auth.signup_expired"));
    case -2:
      throw new AppError(HTTP_UNPROCESSABLE, t("server.auth.signup_code_exhausted"));
    case 0:
      throw new AppError(HTTP_BAD_REQUEST, t("server.auth.signup_code_invalid"));
  }

  const [, email, hashedPassword, locale] = reply;
  if (email === undefined || hashedPassword === undefined || locale === undefined) {
    throw new AppError(HTTP_GONE, t("server.auth.signup_expired"));
  }
  if (await userRepo.getUserByEmail(email)) {
    throw new ConflictError(t("server.auth.email_taken"));
  }
  try {
    return await userRepo.createUser({ email, hashedPassword, locale, emailVerified: true });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(t("server.auth.email_taken"));
    throw err;
  }
}
