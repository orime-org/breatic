// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `transitionOperation` on the two terminal lines of the disposition table
 * (inner#1410 §6.2), one case per cell, on real Postgres.
 *
 * | event   | succeeded                         | needs_attention                                 |
 * |---------|-----------------------------------|-------------------------------------------------|
 * | E1      | impossible                        | impossible                                      |
 * | E2–E6   | unchanged (one event row)         | unchanged (one event row)                       |
 * | E7–E12  | impossible                        | impossible                                      |
 * | E13     | unaffected (one event row)        | unaffected (one event row)                      |
 * | E14     | unchanged (one event row)         | attention_closed_at / attention_closed_by set   |
 * | E15     | discarded (one late_answer row)   | discarded (one late_answer row)                 |
 * | E16     | unchanged (one event row)         | unchanged (one event row)                       |
 * | E17     | impossible                        | impossible                                      |
 *
 * "Unchanged" means no lot, ledger, copy, bell or mail write: a finished
 * approve does not book or tell the buyer twice, a finished restore does not
 * give the credits back twice. Each case runs against a finished approve, a
 * rejection and a restore_credits (v9) for `succeeded`, and against an
 * approve stopped at partial_refund and one Stripe declined for
 * `needs_attention`.
 */

import { describe, it, expect, vi } from "vitest";

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

import { randomUUID } from "node:crypto";
import { transitionOperation } from "@server/modules/credit-refund/operation-transitions.js";
import {
  inTx,
  readOp,
  refundObject,
  reId,
  seedCopy,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  worldOf,
  type OpStatus,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import {
  eventOf,
  expectImpossible,
  expectStays,
  newEventsOn,
} from "./credit-refund-cells.js";

const suite = useRefundSuite("credit-refund-op-terminal-test");

interface Terminal {
  label: string;
  status: Extract<OpStatus, "succeeded" | "needs_attention">;
  make: () => Promise<{ lot: SeededLot; opId: string; refundId: string }>;
}

const TERMINALS: Terminal[] = [
  {
    label: "succeeded approve (refunded lot)",
    status: "succeeded",
    make: async () => {
      const lot = await seedRefundLot(suite.sql, "refunded");
      const refundId = reId("done");
      const op = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "succeeded",
        result: "refunded",
        stripeRefundId: refundId,
      });
      await seedCopy(suite.sql, lot, {
        id: refundId,
        amountCents: 1080,
        status: "succeeded",
        operationId: op.id,
      });
      return { lot, opId: op.id, refundId };
    },
  },
  {
    label: "succeeded reject (active lot)",
    status: "succeeded",
    make: async () => {
      const lot = await seedRefundLot(suite.sql, "active");
      const op = await seedOperation(suite.sql, lot, {
        kind: "reject",
        status: "succeeded",
        result: "rejected",
      });
      return { lot, opId: op.id, refundId: reId("none") };
    },
  },
  {
    label: "succeeded restore_credits (active lot)",
    status: "succeeded",
    make: async () => {
      const lot = await seedRefundLot(suite.sql, "active");
      const op = await seedOperation(suite.sql, lot, {
        kind: "restore_credits",
        status: "succeeded",
        result: "restored",
        notify: true,
      });
      return { lot, opId: op.id, refundId: reId("none") };
    },
  },
  {
    label: "needs_attention approve (refunding lot)",
    status: "needs_attention",
    make: async () => {
      const lot = await seedRefundLot(suite.sql, "refunding");
      const refundId = reId("partial");
      const op = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "needs_attention",
        attentionReason: "partial_refund",
        stripeRefundId: refundId,
      });
      await seedCopy(suite.sql, lot, {
        id: refundId,
        amountCents: 700,
        status: "succeeded",
        operationId: op.id,
      });
      return { lot, opId: op.id, refundId };
    },
  },
  {
    label: "needs_attention approve Stripe declined (refunding lot, no refund)",
    status: "needs_attention",
    make: async () => {
      const lot = await seedRefundLot(suite.sql, "refunding");
      const op = await seedOperation(suite.sql, lot, {
        kind: "approve",
        status: "needs_attention",
        attentionReason: "stripe_declined",
      });
      return { lot, opId: op.id, refundId: reId("none") };
    },
  },
];

describe.each(TERMINALS)("$label", ({ status, make }) => {
  it("× E1 is impossible", async () => {
    const { lot, opId } = await make();
    await expectImpossible(suite.sql, lot, { id: opId }, status, {
      type: "E1",
      create: {
        kind: "settle",
        lotId: lot.lotId,
        paymentId: lot.paymentId,
        idempotencyKey: `idem-${randomUUID()}`,
        requestHash: "d".repeat(64),
        requestedBy: "admin_7",
        reason: "again",
        notify: true,
        confirmedSucceededCents: 1080,
      },
      actor: "request",
    });
  });

  it.each(["E2", "E3", "E4", "E5", "E6"] as const)(
    "× %s leaves everything unchanged and appends one event row",
    async (type) => {
      const { lot, opId, refundId } = await make();
      await expectStays(
        suite.sql,
        lot,
        opId,
        status,
        eventOf(type, refundObject(refundId, "succeeded", 1080, opId)),
      );
    },
  );

  it.each(["E7", "E8", "E9", "E10", "E11", "E12", "E17"] as const)(
    "× %s is impossible and writes nothing",
    async (type) => {
      const { lot, opId } = await make();
      await expectImpossible(suite.sql, lot, { id: opId }, status, eventOf(type));
    },
  );

  it("× E13 leaves everything unchanged and appends one event row", async () => {
    const { lot, opId } = await make();
    await expectStays(suite.sql, lot, opId, status, { type: "E13", actor: "loop" });
  });

  it("× E15 (an answer under a lease it does not hold) is discarded", async () => {
    const { lot, opId, refundId } = await make();
    await expectStays(
      suite.sql,
      lot,
      opId,
      status,
      {
        type: "E2",
        refund: refundObject(refundId, "succeeded", 1080, opId),
        leaseToken: randomUUID(),
        actor: "loop",
      },
      "late_answer",
    );
  });

  it("× E16 leaves everything unchanged and appends one event row", async () => {
    const { lot, opId } = await make();
    await expectStays(suite.sql, lot, opId, status, eventOf("E16"));
  });
});

describe("succeeded × E14: nothing to close", () => {
  it("leaves the finished disposition unchanged and appends one event row", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const done = await seedOperation(suite.sql, lot, {
      kind: "send_back",
      status: "succeeded",
      result: "sent_back",
      createdSecondsAgo: 120,
    });
    const later = await seedOperation(suite.sql, lot, {
      kind: "send_back",
      status: "succeeded",
      result: "sent_back",
    });
    await expectStays(suite.sql, lot, done.id, "succeeded", { type: "E14", closedBy: later.id, actor: "request" });
    expect((await readOp(suite.sql, done.id)).attention_closed_at).toBeNull();
  });
});

describe("needs_attention × E14: a later disposition finished on this lot", () => {
  it("writes attention_closed_at and attention_closed_by and nothing else", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "stripe_result_unknown",
      createdSecondsAgo: 120,
    });
    const closer = await seedOperation(suite.sql, lot, {
      kind: "send_back",
      status: "succeeded",
      result: "sent_back",
    });
    const openBefore = await readOp(suite.sql, open.id);
    const before = await worldOf(suite.sql, lot);

    const returned = await inTx((tx) =>
      transitionOperation(tx, { id: open.id }, { type: "E14", closedBy: closer.id, actor: "request" }),
    );

    expect(returned).toMatchObject({ id: open.id, status: "needs_attention" });
    const after = await readOp(suite.sql, open.id);
    expect(after.attention_closed_at).not.toBeNull();
    expect(after.attention_closed_by).toBe(closer.id);
    expect({ ...after, attention_closed_at: null, attention_closed_by: null }).toEqual(openBefore);
    const world = await worldOf(suite.sql, lot);
    expect(world.lot).toEqual(before.lot);
    expect(world.ledger).toEqual(before.ledger);
    expect(world.copies).toEqual(before.copies);
    expect(world.bells).toEqual(before.bells);
    expect(world.mails).toEqual(before.mails);
    expect(await newEventsOn(suite.sql, lot, before, open.id)).toEqual([
      { event: "attention_closed", from_status: "needs_attention", to_status: "needs_attention" },
    ]);
  });

  it("does not move a needs_attention that is already closed", async () => {
    const lot = await seedRefundLot(suite.sql, "refund_pending");
    const open = await seedOperation(suite.sql, lot, {
      kind: "approve",
      status: "needs_attention",
      attentionReason: "partial_refund",
      createdSecondsAgo: 300,
    });
    const first = await seedOperation(suite.sql, lot, {
      kind: "send_back",
      status: "succeeded",
      result: "sent_back",
      createdSecondsAgo: 200,
    });
    await suite.sql`
      UPDATE credit_refund_operations
      SET attention_closed_at = now() - interval '200 seconds', attention_closed_by = ${first.id}
      WHERE id = ${open.id}
    `;
    const second = await seedOperation(suite.sql, lot, {
      kind: "send_back",
      status: "succeeded",
      result: "sent_back",
    });

    await expectStays(suite.sql, lot, open.id, "needs_attention", {
      type: "E14",
      closedBy: second.id,
      actor: "request",
    });
    expect((await readOp(suite.sql, open.id)).attention_closed_by).toBe(first.id);
  });
});
