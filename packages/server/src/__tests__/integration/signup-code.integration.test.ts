// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sign-up with a code sent by email (#287) — the pending sign-up state
 * machine against real Redis and PostgreSQL.
 *
 * A pending sign-up belongs to the browser that started it (its ticket); the
 * account row is written only after the code matches. The timings are
 * shortened through the config module so expiry and the resend wait can be
 * crossed in about a second.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

/** What the stubbed `sendMail` answers. */
interface StubMailResult {
  status: string;
  reason?: string;
  to?: string;
  subject?: string;
}

const sent = vi.hoisted(() => {
  const result: StubMailResult = { status: "sent" };
  return {
    mails: [] as { to: string; subject: string; text: string }[],
    result,
    /** Runs while the mail is being sent. */
    during: null as null | (() => Promise<void>),
  };
});

/** Runs while a password is being hashed. */
const hashing = vi.hoisted(() => ({ during: null as null | (() => Promise<void>) }));

vi.mock("bcryptjs", async (importOriginal: () => Promise<{ default: Record<string, unknown> }>) => {
  const actual = (await importOriginal()).default as { hash: (pw: string, rounds: number) => Promise<string> };
  const hash = async (pw: string, rounds: number): Promise<string> => {
    const hashed = await actual.hash(pw, rounds);
    await hashing.during?.();
    return hashed;
  };
  return { default: { ...actual, hash } };
});

vi.mock("@breatic/core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendMail: async (mail: { to: string; subject: string; text: string }) => {
      sent.mails.push(mail);
      await sent.during?.();
      return sent.result;
    },
  };
});

vi.mock("@server/config/auth.js", () => ({
  getSignupCodeConfig: () => ({ ttlSeconds: 3, maxAttemptsPerCode: 5, resendCooldownSeconds: 1 }),
}));

import crypto from "node:crypto";
import { getLegalConfig } from "@server/config/legal.js";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import { initCore, loadLocales, AppError, TooManyRequestsError, env, getRedis, runWithLocale } from "@breatic/core";
import { t } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const { startSignup, resendSignupCode, verifySignupCode } = await import(
  "@server/modules/auth/signup-code.service.js"
);

let sql: ReturnType<typeof postgres>;
const createdEmails: string[] = [];

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
});

afterEach(async () => {
  sent.mails.length = 0;
  sent.result = { status: "sent" };
  sent.during = null;
  hashing.during = null;
  for (const email of createdEmails.splice(0)) {
    await sql`UPDATE users SET deleted_at = now() WHERE email = ${email} AND deleted_at IS NULL`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** A fresh address this suite owns. */
function freshEmail(): string {
  const email = `signup-code-${crypto.randomUUID()}@example.test`;
  createdEmails.push(email);
  return email;
}

/** The six-digit code in the most recent mail. */
function lastCode(): string {
  const text = sent.mails.at(-1)?.text ?? "";
  const match = /\b(\d{6})\b/.exec(text);
  if (!match) throw new Error(`no code in the last mail: ${text}`);
  return match[1]!;
}

/** A six-digit code different from the given one. */
function wrongCode(right: string): string {
  return right === "000000" ? "111111" : "000000";
}

/** The HTTP status an awaited call rejects with. */
async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err.statusCode;
    throw err;
  }
  throw new Error("expected a rejection");
}

/** The Redis key of a ticket's pending sign-up. */
function pendingKey(ticket: string): string {
  return `${env.ENV}:signup:${crypto.createHash("sha256").update(ticket).digest("hex")}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The stored password hash and verified flag for an address. */
async function stored(email: string): Promise<{ hashed_password: string; email_verified: boolean; locale: string } | undefined> {
  const rows = await sql<{ hashed_password: string; email_verified: boolean; locale: string }[]>`
    SELECT hashed_password, email_verified, locale FROM users WHERE email = ${email} AND deleted_at IS NULL
  `;
  return rows[0];
}

describe("starting a sign-up", () => {
  it("mails a six-digit code to the address and writes no account yet", async () => {
    const email = freshEmail();
    const started = await startSignup({ ticket: null, email, password: "password1", locale: "ja" });

    expect(started.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.expiresInSeconds).toBe(3);
    expect(started.resendAfterSeconds).toBe(1);
    expect(sent.mails).toHaveLength(1);
    expect(sent.mails[0]!.to).toBe(email);
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(await stored(email)).toBeUndefined();
  });

  it("refuses an address that already has an account", async () => {
    const email = freshEmail();
    await sql`INSERT INTO users (email, membership_tier) VALUES (${email}, 'base')`;
    expect(await statusOf(startSignup({ ticket: null, email, password: "password1", locale: "en" }))).toBe(409);
    expect(sent.mails).toHaveLength(0);
  });

  it("refuses an address that already has an account when it is typed in another case", async () => {
    const email = freshEmail();
    await sql`INSERT INTO users (email, membership_tier) VALUES (${email}, 'base')`;
    const typed = ` ${email.toUpperCase()} `;
    expect(await statusOf(startSignup({ ticket: null, email: typed, password: "password1", locale: "en" }))).toBe(409);
    expect(sent.mails).toHaveLength(0);
  });

  it("refuses a second browser inside the resend wait, saying how long to wait", async () => {
    const email = freshEmail();
    await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    const refusal = await startSignup({ ticket: null, email: email.toUpperCase(), password: "other-pw", locale: "en" }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(TooManyRequestsError);
    expect((refusal as TooManyRequestsError).retryAfterSeconds).toBe(1);
    expect(sent.mails).toHaveLength(1);
  });

  it("lets the same browser submit again inside the wait without replacing the code", async () => {
    const email = freshEmail();
    const first = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    const code = lastCode();
    const again = await startSignup({ ticket: first.ticket, email, password: "password2", locale: "en" });

    expect(again.ticket).toBe(first.ticket);
    expect(again.resendAfterSeconds).toBeGreaterThan(0);
    expect(sent.mails).toHaveLength(1);

    await verifySignupCode(first.ticket, code);
    const row = await stored(email);
    expect(await bcrypt.compare("password2", row!.hashed_password)).toBe(true);
  });

  it("rolls back when the mail was not sent, so the next try is not made to wait", async () => {
    const email = freshEmail();
    sent.result = { status: "skipped", reason: "smtp_not_configured", to: email, subject: "x" };
    expect(await statusOf(startSignup({ ticket: null, email, password: "password1", locale: "en" }))).toBe(503);

    sent.result = { status: "sent" };
    const retried = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    expect(retried.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("sending the code fails by throwing", () => {
  it("answers 503 and gives the wait back when the mail transport throws", async () => {
    const email = freshEmail();
    sent.during = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await statusOf(startSignup({ ticket: null, email, password: "password1", locale: "en" }))).toBe(503);

    sent.during = null;
    const retried = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    expect(retried.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("verifying the code", () => {
  it("writes a verified account with the sign-up's password and the language the code was entered in", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "ko" });
    const user = await runWithLocale("ja", () => verifySignupCode(ticket, lastCode()));

    expect(user.email).toBe(email);
    const row = await stored(email);
    expect(row!.email_verified).toBe(true);
    expect(row!.locale).toBe("ja");
    expect(await bcrypt.compare("password1", row!.hashed_password)).toBe(true);
    // The pending sign-up is gone once it became an account.
    expect(await statusOf(verifySignupCode(ticket, lastCode()))).toBe(410);
  });

  // #302: the account records the terms it was created under.
  it("records the terms version and the moment the account was made", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    const before = Date.now();
    await verifySignupCode(ticket, lastCode());

    const [row] = await sql<{ terms_accepted_at: Date | null; terms_version: string | null }[]>`
      SELECT terms_accepted_at, terms_version FROM users WHERE email = ${email} AND deleted_at IS NULL
    `;
    expect(row?.terms_version).toBe(getLegalConfig().terms_version);
    expect(row?.terms_accepted_at?.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("answers 400 to a wrong code and 422 once the code has taken its fifth wrong try", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    const code = lastCode();

    for (let i = 0; i < 4; i++) expect(await statusOf(verifySignupCode(ticket, wrongCode(code)))).toBe(400);
    expect(await statusOf(verifySignupCode(ticket, wrongCode(code)))).toBe(422);
    // The right code no longer helps; the account is not written.
    expect(await statusOf(verifySignupCode(ticket, code))).toBe(422);
    expect(await stored(email)).toBeUndefined();
  });

  it("never compares more than five times however many requests arrive at once", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    const code = lastCode();

    const statuses = await Promise.all(
      Array.from({ length: 20 }, () => statusOf(verifySignupCode(ticket, wrongCode(code)))),
    );
    expect(statuses.filter((s) => s === 400)).toHaveLength(4);
    expect(statuses.filter((s) => s === 422)).toHaveLength(16);
  });

  it("answers 410 to an unknown or missing ticket", async () => {
    expect(await statusOf(verifySignupCode(null, "123456"))).toBe(410);
    expect(await statusOf(verifySignupCode("no-such-ticket", "123456"))).toBe(410);
  });

  it("answers 410 once the sign-up has expired", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    const code = lastCode();
    await sleep(3200);
    expect(await statusOf(verifySignupCode(ticket, code))).toBe(410);
  });

  it("answers 409 when the address got an account while the code was pending", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    await sql`INSERT INTO users (email, membership_tier) VALUES (${email}, 'base')`;
    expect(await statusOf(verifySignupCode(ticket, lastCode()))).toBe(409);
    expect(await statusOf(verifySignupCode(ticket, lastCode()))).toBe(410);
  });
});

describe("two browsers on one address", () => {
  it("keeps each browser's password to its own sign-up", async () => {
    const email = freshEmail();
    const owner = await startSignup({ ticket: null, email, password: "owner-pw-1", locale: "en" });
    const ownerCode = lastCode();
    await sleep(1100);
    const other = await startSignup({ ticket: null, email, password: "other-pw-1", locale: "en" });
    const otherCode = lastCode();

    // The other browser's code does not complete the owner's sign-up.
    expect(await statusOf(verifySignupCode(owner.ticket, otherCode === ownerCode ? wrongCode(ownerCode) : otherCode))).toBe(400);
    await verifySignupCode(owner.ticket, ownerCode);

    const row = await stored(email);
    expect(await bcrypt.compare("owner-pw-1", row!.hashed_password)).toBe(true);
    expect(await statusOf(verifySignupCode(other.ticket, otherCode))).toBe(409);
  });
});

describe("resending the code", () => {
  it("writes the resent mail in the language the resend was asked in", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "ko" });
    await sleep(1100);
    await runWithLocale("ja", () => resendSignupCode(ticket));

    const japanese = runWithLocale("ja", () => t("server.mail.signup_code.subject"));
    const korean = runWithLocale("ko", () => t("server.mail.signup_code.subject"));
    expect(sent.mails[1]!.subject).toContain(japanese);
    expect(sent.mails[1]!.subject).not.toContain(korean);
  });

  it("refuses inside the wait and afterwards sends a new code that replaces the old one", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    const oldCode = lastCode();
    await verifySignupCode(ticket, wrongCode(oldCode)).catch(() => undefined);

    expect(await statusOf(resendSignupCode(ticket))).toBe(429);
    await sleep(1100);
    const resent = await resendSignupCode(ticket);
    expect(resent.ticket).toBe(ticket);
    expect(sent.mails).toHaveLength(2);
    const newCode = lastCode();

    if (newCode !== oldCode) {
      expect(await statusOf(verifySignupCode(ticket, oldCode))).toBe(400);
    }
    // Four wrong tries left again after the resend reset the count.
    for (let i = 0; i < 3; i++) await verifySignupCode(ticket, wrongCode(newCode)).catch(() => undefined);
    await verifySignupCode(ticket, newCode);
    expect((await stored(email))!.email_verified).toBe(true);
  });

  it("answers 410 to an unknown ticket", async () => {
    expect(await statusOf(resendSignupCode("no-such-ticket"))).toBe(410);
    expect(await statusOf(resendSignupCode(null))).toBe(410);
  });

  it("answers 410 when the sign-up expires while the new code is being mailed", async () => {
    const email = freshEmail();
    const { ticket } = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    await sleep(1100);
    sent.during = async () => {
      await getRedis().del(pendingKey(ticket));
    };
    expect(await statusOf(resendSignupCode(ticket))).toBe(410);
    expect(await getRedis().exists(pendingKey(ticket))).toBe(0);
  });
});

describe("submitting the form again as the sign-up expires", () => {
  it("never leaves a pending sign-up without a lifetime", async () => {
    const email = freshEmail();
    const first = await startSignup({ ticket: null, email, password: "password1", locale: "en" });
    hashing.during = async () => {
      await getRedis().del(pendingKey(first.ticket));
    };
    await startSignup({ ticket: first.ticket, email, password: "password2", locale: "en" }).catch(() => undefined);
    expect(await getRedis().pttl(pendingKey(first.ticket))).not.toBe(-1);
  });
});
