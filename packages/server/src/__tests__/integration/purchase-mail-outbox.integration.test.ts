// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The outbox row that decides whether a confirmation may be sent (task #13
 * §4.5) — against real PG.
 *
 * One rule governs it, and the whole point of stating it as a condition on the
 * row rather than a list of states is that both halves stay together: anything
 * but `sent` may be sent, and a row already `sending` only once that send has
 * been in flight too long to still be one. A claim that took `sending`
 * unconditionally would succeed every time and gate nothing.
 *
 * The second half is what needs a real database. `claimSend` and `recordSend`
 * are two statements a send makes minutes apart, and in between the row can be
 * taken over by somebody else. The send that lost it must not be able to write
 * its answer afterwards — otherwise the letter that did go out gets recorded
 * as failed and the screen offers to send a third.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  inject,
  vi,
} from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import * as outbox from "@server/modules/payment/purchase-mail.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "purchase-mail-outbox-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/** An account with one completed payment and one outbox row. */
async function seedRow(status: string): Promise<{
  userId: string;
  paymentId: string;
}> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`outbox-${stamp}@example.test`}, true) RETURNING id
  `;
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, stripe_session_id, amount_cents, credits_granted, currency, status)
    VALUES (${user!.id}, ${`cs_outbox_${stamp}`}, 2000, 1700, 'usd', 'completed')
    RETURNING id
  `;
  await sql`
    INSERT INTO purchase_mail_outbox (payment_id, status)
    VALUES (${payment!.id}, ${status})
  `;
  return { userId: user!.id, paymentId: payment!.id };
}

/** Removes an account and everything hanging off it. */
async function dropUser(userId: string): Promise<void> {
  await sql`DELETE FROM purchase_mail_outbox WHERE payment_id IN (SELECT id FROM payments WHERE user_id = ${userId})`;
  await sql`DELETE FROM payments WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

/** Where one purchase's outbox row stands. */
async function rowOf(
  paymentId: string,
): Promise<{ status: string; attempts: number; last_error: string | null }> {
  const [row] = await sql<
    { status: string; attempts: number; last_error: string | null }[]
  >`
    SELECT status, attempts, last_error FROM purchase_mail_outbox
    WHERE payment_id = ${paymentId}
  `;
  return row!;
}

/** An instant far enough back that nothing in this suite is older. */
function longAgo(): Date {
  return new Date(Date.now() - 60 * 60 * 1000);
}

/** Now, so that a row touched a moment ago does not count as stale. */
function justNow(): Date {
  return new Date();
}

describe("which states a send may be claimed from", () => {
  it.each([
    ["pending", true],
    ["failed", true],
    ["skipped", true],
    ["sent", false],
  ])("a %s row: %s", async (status, allowed) => {
    const { userId, paymentId } = await seedRow(status);
    try {
      const claim = await outbox.claimSend(paymentId, longAgo());
      expect(claim !== null).toBe(allowed);
    } finally {
      await dropUser(userId);
    }
  });

  it("refuses a send that is still in flight", async () => {
    const { userId, paymentId } = await seedRow("sending");
    try {
      // The row was touched on insert, so it is younger than this cutoff.
      expect(await outbox.claimSend(paymentId, longAgo())).toBeNull();
    } finally {
      await dropUser(userId);
    }
  });

  it("takes over a send that has been in flight too long", async () => {
    const { userId, paymentId } = await seedRow("sending");
    try {
      await sql`
        UPDATE purchase_mail_outbox SET updated_at = now() - interval '30 minutes'
        WHERE payment_id = ${paymentId}
      `;
      expect(await outbox.claimSend(paymentId, justNow())).not.toBeNull();
    } finally {
      await dropUser(userId);
    }
  });

  it("claims nothing for a purchase with no row at all", async () => {
    expect(
      await outbox.claimSend("9f1c7c2e-0000-4000-8000-0000000000ff", longAgo()),
    ).toBeNull();
  });

  it("lets exactly one of two callers racing for the same row through", async () => {
    const { userId, paymentId } = await seedRow("pending");
    try {
      const [a, b] = await Promise.all([
        outbox.claimSend(paymentId, longAgo()),
        outbox.claimSend(paymentId, longAgo()),
      ]);
      expect([a, b].filter((claim) => claim !== null)).toHaveLength(1);
    } finally {
      await dropUser(userId);
    }
  });

  it("counts every claim, so a row says how many sends have started", async () => {
    const { userId, paymentId } = await seedRow("pending");
    try {
      await outbox.claimSend(paymentId, longAgo());
      expect((await rowOf(paymentId)).attempts).toBe(1);
      await outbox.claimSend(paymentId, justNow());
      expect((await rowOf(paymentId)).attempts).toBe(2);
    } finally {
      await dropUser(userId);
    }
  });
});

describe("who may write back where a send landed", () => {
  it("records the outcome of the send that holds the row", async () => {
    const { userId, paymentId } = await seedRow("pending");
    try {
      const claim = await outbox.claimSend(paymentId, longAgo());
      expect(claim).not.toBeNull();
      await outbox.recordSend(paymentId, claim!, "sent");
      expect((await rowOf(paymentId)).status).toBe("sent");
    } finally {
      await dropUser(userId);
    }
  });

  it("ignores a send that lost the row while it was away", async () => {
    const { userId, paymentId } = await seedRow("pending");
    try {
      // A claims, then hangs long enough to be treated as abandoned.
      const first = await outbox.claimSend(paymentId, longAgo());
      await sql`
        UPDATE purchase_mail_outbox SET updated_at = now() - interval '30 minutes'
        WHERE payment_id = ${paymentId}
      `;
      // B takes it over and really sends the letter.
      const second = await outbox.claimSend(paymentId, justNow());
      await outbox.recordSend(paymentId, second!, "sent");

      // A's socket finally times out and it tries to write its failure. The
      // letter B sent did go out; recording it as failed would put the resend
      // control back and send a third.
      await outbox.recordSend(paymentId, first!, "failed", "socket timeout");

      const row = await rowOf(paymentId);
      expect(row.status).toBe("sent");
      expect(row.last_error).toBeNull();
    } finally {
      await dropUser(userId);
    }
  });
});
