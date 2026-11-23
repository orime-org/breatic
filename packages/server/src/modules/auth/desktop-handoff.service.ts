// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Desktop client sign-in through the system browser (#1599).
 *
 * Google refuses sign-in inside an embedded web view, so the desktop client
 * opens `/desktop/sign-in` in the system browser with a challenge, the SHA-256
 * of a verifier only the client holds. The signed-in browser asks for a
 * one-time code bound to that challenge; the client page trades code and
 * verifier for a session of its own (RFC 8252 with RFC 7636).
 *
 * Redis holds the SHA-256 of the code, so a dump of the store hands out no
 * redeemable code. Redemption takes the record with GETDEL, so a code is spent
 * by its first use, whether that use succeeds or not.
 */

import crypto from "node:crypto";
import { env, getRedis, getSession } from "@breatic/core";
import type { UserEntity } from "@breatic/shared";
import { getDesktopHandoffTtlSeconds } from "@server/config/auth.js";
import { createSession, getUserById } from "@server/modules/auth/auth.service.js";

/** What Redis keeps for one code. */
interface HandoffRecord {
  userId: string;
  challenge: string;
  /** The browser session that asked; the code dies with it, so signing out or a password reset ends it too. */
  session: string;
}

/** Why a redemption was refused; logged, never shown. */
export type DesktopExchangeRefusal = "unknown_code" | "verifier_mismatch" | "session_gone" | "account_gone";

/** The outcome of redeeming a code. */
export type DesktopExchangeOutcome =
  | { ok: true; user: UserEntity; token: string }
  | { ok: false; reason: DesktopExchangeRefusal };

/**
 * The Redis key for a code.
 * @param code - The code as handed out.
 * @returns The key, built from the code's hash.
 */
function keyOf(code: string): string {
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  return `${env.REDIS_KEY_PREFIX}:server:desktop-handoff:${hash}`;
}

/**
 * Issue a one-time code for a signed-in account, bound to the client's challenge.
 * @param userId - The account signed in in the browser.
 * @param challenge - base64url SHA-256 of the client's verifier.
 * @param session - The token of the browser session asking.
 * @returns The code to hand to the desktop client.
 * @throws {Error} if Redis is unreachable.
 */
export async function issueDesktopHandoff(userId: string, challenge: string, session: string): Promise<string> {
  const code = crypto.randomBytes(32).toString("base64url");
  const record: HandoffRecord = { userId, challenge, session };
  await getRedis().set(keyOf(code), JSON.stringify(record), "EX", getDesktopHandoffTtlSeconds());
  return code;
}

/**
 * Redeem a code with the verifier behind its challenge, opening a session.
 * @param code - The code from the browser.
 * @param verifier - The verifier the desktop client made.
 * @returns The account and its new session token, or why it was refused.
 * @throws {Error} if Redis or the database is unreachable.
 */
export async function redeemDesktopHandoff(code: string, verifier: string): Promise<DesktopExchangeOutcome> {
  const raw = await getRedis().getdel(keyOf(code));
  if (raw === null) return { ok: false, reason: "unknown_code" };
  const record = JSON.parse(raw) as HandoffRecord;
  const derived = Buffer.from(crypto.createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(record.challenge);
  if (derived.length !== expected.length || !crypto.timingSafeEqual(derived, expected)) {
    return { ok: false, reason: "verifier_mismatch" };
  }
  if ((await getSession(getRedis(), record.session)) !== record.userId) return { ok: false, reason: "session_gone" };
  const user = await getUserById(record.userId);
  if (!user) return { ok: false, reason: "account_gone" };
  return { ok: true, user, token: await createSession(user.id) };
}
