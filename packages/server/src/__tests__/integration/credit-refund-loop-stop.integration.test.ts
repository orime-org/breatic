// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Stopping the refund loop mid-tick (inner#1410 §7.1; round-3 findings 4
 * and 10), on real Postgres and Redis with the stateful fake Stripe.
 *
 * Contract this suite drives — `packages/server/src/modules/credit-refund/refund-loop.ts`:
 *
 *   export function startRefundLoop(): { stop: () => Promise<void> }
 *     `stop()` is called on shutdown, which gives the drains a few seconds.
 *     Once it has been called, the tick in progress finishes only the
 *     disposition it is executing: it takes no further candidate in step 1,
 *     and starts none of the steps after the one it is in (step 2's Stripe
 *     reads, step 3's mail sweep, the stale-mail pass, step 4's reconcile).
 *     Whatever it skips is due again on the next start.
 *
 * Each case holds the first step on a `refunds.create` that waits on a gate,
 * calls `stop()`, then opens the gate and waits for `stop()` to resolve.
 *
 * Only the mail backend is stood in for besides Stripe: `sendMail` is a spy,
 * so a sweep that does run marks the row sent instead of reaching SMTP.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const sendMail = vi.fn();
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMail: (...args: unknown[]) => sendMail(...args),
}));

vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import { env, getRedis, initCore } from "@breatic/core";
import { startRefundLoop } from "@server/modules/credit-refund/refund-loop.js";
import { fakeStripe } from "./fake-stripe-refunds.js";
import {
  PAID_CENTS,
  eventsOf,
  giveIntentlessPaymentsAnIntent,
  parkInFlightOperations,
  refundObject,
  reId,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  type SeededLot,
} from "./credit-refund-fixtures.js";

const suite = useRefundSuite("credit-refund-loop-stop-test");

const BASE = {
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  INTERNAL_API_SECRET: "internal-secret-loop-stop-suite-0123456789",
};

beforeEach(async () => {
  fakeStripe.reset();
  sendMail.mockReset();
  sendMail.mockResolvedValue({ status: "sent" });
  await parkInFlightOperations(suite.sql);
  // The reconcile is due, so a tick that reached step 4 would start it.
  await giveIntentlessPaymentsAnIntent(suite.sql);
  await suite.sql`DELETE FROM credit_refund_reconcile_status WHERE name = 'daily'`;
  await getRedis().del(`${env.ENV}:server:refund-reconcile-lock`);
});

/**
 * A started disposition whose executor is gone, on a lot Stripe knows.
 * @returns The lot and the disposition.
 */
async function dueStarted(): Promise<{ lot: SeededLot; opId: string }> {
  const lot = await seedRefundLot(suite.sql, "refunding");
  fakeStripe.register(lot.paymentIntentId, PAID_CENTS);
  const { id } = await seedOperation(suite.sql, lot, { kind: "approve", status: "started", leaseExpired: true });
  return { lot, opId: id };
}

/**
 * Start the loop, wait until its first tick is held on a `refunds.create`
 * that waits on a gate, call `stop()`, then open the gate and wait for
 * `stop()` to resolve.
 */
async function stopWhileStepOneIsHeld(): Promise<void> {
  let open!: () => void;
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  fakeStripe.nextCreate({ kind: "hang", until, then: { kind: "refund", status: "succeeded" } });
  initCore({ ...BASE, INTERNAL_API_ENABLED: "true" });
  const loop = startRefundLoop();
  try {
    await vi.waitFor(() => expect(fakeStripe.createCalls).toHaveLength(1), { timeout: 10_000 });
    const stopping = loop.stop();
    open();
    await stopping;
  } finally {
    open();
    await loop.stop();
    initCore(BASE);
  }
}

describe("startRefundLoop — stop() during step 1 (§7.1)", () => {
  it("skips every step after the one in progress: no Stripe read in step 2, the due mail stays pending, the reconcile is not started", async () => {
    await dueStarted();
    // Step 2: an awaiting disposition whose lookup is due.
    const own = reId("own");
    const waitingLot = await seedRefundLot(suite.sql, "refunding");
    const { id: waitingId } = await seedOperation(suite.sql, waitingLot, {
      kind: "approve",
      status: "awaiting_stripe",
      stripeRefundId: own,
      firstCalledHoursAgo: 1,
    });
    fakeStripe.register(waitingLot.paymentIntentId, PAID_CENTS, [refundObject(own, "pending", PAID_CENTS, waitingId)]);
    // Step 3: an automatic mail row still pending two minutes after insert.
    const mailLot = await seedRefundLot(suite.sql, "refund_pending");
    const rejected = await seedOperation(suite.sql, mailLot, { kind: "reject", status: "succeeded", result: "rejected" });
    const [mail] = await suite.sql<{ id: string }[]>`
      INSERT INTO refund_mail_outbox (operation_id, kind, origin, status, created_at, updated_at)
      VALUES (${rejected.id}, 'refund_rejected', 'auto', 'pending',
              now() - interval '2 minutes', now() - interval '2 minutes')
      RETURNING id
    `;

    await stopWhileStepOneIsHeld();

    expect(fakeStripe.listedIntents()).not.toContain(waitingLot.paymentIntentId);
    const [mailAfter] = await suite.sql<{ status: string }[]>`
      SELECT status FROM refund_mail_outbox WHERE id = ${mail!.id}
    `;
    expect(mailAfter).toEqual({ status: "pending" });
    const reconcileRows = await suite.sql`SELECT 1 FROM credit_refund_reconcile_status WHERE name = 'daily'`;
    expect(reconcileRows).toHaveLength(0);
  });

  it("takes no further candidate in step 1: of two due started dispositions only the one in progress is claimed", async () => {
    const first = await dueStarted();
    const second = await dueStarted();

    await stopWhileStepOneIsHeld();

    const claimed = async (opId: string) =>
      (await eventsOf(suite.sql, opId)).some((e) => e.event === "claimed");
    expect([await claimed(first.opId), await claimed(second.opId)].filter(Boolean)).toHaveLength(1);
    expect(fakeStripe.createCalls).toHaveLength(1);
  });
});
