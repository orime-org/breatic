// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { db, initCore, users } from "@breatic/core";
import {
  applyUnderstandDispatchEvent,
  applyUnderstandOperationEvent,
  claimUnderstandOperationLease,
  getUnderstandOperation,
  listDueUnderstandDispatches,
  openUnderstandOperation,
  releaseUnderstandOperationLease,
  renewUnderstandOperationLease,
} from "@breatic/domain";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

initCore(process.env);
let sqlClient!: ReturnType<typeof postgres>;

beforeAll(() => {
  sqlClient = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
});

afterAll(async () => {
  await sqlClient.end({ timeout: 1 });
});

const TABLES = [
  "media_understanding_operations",
  "media_understanding_steps",
  "media_understanding_attempts",
  "usage_settlement_envelopes",
  "credit_settlement_receipts",
] as const;

describe("long-media persistence migration", () => {
  it("creates each durable fact table with its lifecycle timestamps", async () => {
    const result = await db.execute(sql`
      SELECT table_name, array_agg(column_name ORDER BY column_name) AS columns
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN (${sql.join(TABLES.map((table) => sql`${table}`), sql`, `)})
      GROUP BY table_name
    `);
    const tables = new Map(result.map((row) => [
      String(row.table_name),
      row.columns as string[],
    ]));

    expect([...tables.keys()].sort()).toEqual([...TABLES].sort());
    for (const table of TABLES) {
      expect(tables.get(table)).toContain("created_at");
      expect(tables.get(table)).toContain("deleted_at");
    }
    expect(tables.get("media_understanding_operations")).toEqual(
      expect.arrayContaining([
        "actor_user_id",
        "deadline_at",
        "logical_root_operation_id",
        "revision",
        "status",
      ]),
    );
    expect(tables.get("media_understanding_steps")).toEqual(
      expect.arrayContaining(["operation_id", "step_key", "input_digest", "accepted_attempt_id"]),
    );
    expect(tables.get("media_understanding_attempts")).toEqual(
      expect.arrayContaining(["step_id", "attempt_no", "request_state", "usage_record_id"]),
    );

    const existingColumns = await db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND ((table_name = 'conversation_messages' AND column_name = 'closed_producer_origin_key')
          OR (table_name = 'agent_usage_records' AND column_name IN (
            'settlement_envelope_id', 'settlement_receipt_id', 'cost_identity'
          )))
    `);
    const actualExtensions = existingColumns.map((row) => `${String(row.table_name)}.${String(row.column_name)}`).sort();
    expect(actualExtensions).toEqual([
      "agent_usage_records.cost_identity",
      "agent_usage_records.settlement_envelope_id",
      "agent_usage_records.settlement_receipt_id",
      "conversation_messages.closed_producer_origin_key",
    ]);
  });

  it("opens idempotently and serializes lifecycle changes by revision", async () => {
    const userRows = await db.insert(users).values({
      email: `long-media-${randomUUID()}@example.test`,
      emailVerified: true,
    }).returning({ id: users.id });
    const actorUserId = userRows[0]!.id;
    const input = {
      actorUserId,
      originKind: "agent_turn" as const,
      originKey: `turn:${randomUUID()}`,
      requestDigest: "sha256:stable-request",
      sources: [{ sourceIndex: 0, assetId: randomUUID() }],
      question: "Describe the recording.",
      mode: "understand",
      locale: "en",
      model: "test-model",
      promptVersion: "test-v1",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      recoveryGroupId: randomUUID(),
      logicalRequestId: randomUUID(),
      userActionId: randomUUID(),
    };
    const [opened, replayed] = await Promise.all([
      openUnderstandOperation(input),
      openUnderstandOperation(input),
    ]);
    expect(replayed.id).toBe(opened.id);
    expect(replayed.logicalRootOperationId).toBe(opened.id);
    expect((await getUnderstandOperation(opened.id))?.requestDigest).toBe(input.requestDigest);
    await expect(openUnderstandOperation({ ...input, requestDigest: "sha256:changed-request" }))
      .rejects.toThrow("already bound to different media-understanding input");

    const atMs = Date.now();
    const claimed = await applyUnderstandOperationEvent(opened.id, {
      type: "claim",
      expectedRevision: 1,
      atMs,
    });
    expect(claimed.status).toBe("running");
    expect(claimed.revision).toBe(2);
    await expect(applyUnderstandOperationEvent(opened.id, {
      type: "unknown",
      expectedRevision: 1,
      atMs: atMs + 1,
    })).rejects.toThrow("stale or invalid lifecycle facts");

    const cancelled = await applyUnderstandOperationEvent(opened.id, {
      type: "cancel-applied",
      expectedRevision: 2,
      atMs: atMs + 2,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.revision).toBe(3);
  });

  it("persists outbox delivery and advances the wake only after a claimed step ends", async () => {
    const userRows = await db.insert(users).values({
      email: `long-media-dispatch-${randomUUID()}@example.test`,
      emailVerified: true,
    }).returning({ id: users.id });
    const opened = await openUnderstandOperation({
      actorUserId: userRows[0]!.id,
      originKind: "agent_turn",
      originKey: `turn:${randomUUID()}`,
      requestDigest: "sha256:dispatch-request",
      sources: [{ sourceIndex: 0, assetId: randomUUID() }],
      question: "Describe the recording.",
      mode: "understand",
      locale: "en",
      model: "test-model",
      promptVersion: "test-v1",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      recoveryGroupId: randomUUID(),
      logicalRequestId: randomUUID(),
      userActionId: randomUUID(),
    });

    const sent = await applyUnderstandDispatchEvent(opened.id, {
      type: "dispatch",
      expectedRevision: 1,
      operationId: opened.id,
      atMs: Date.now() + 1_000,
    });
    expect(sent).toMatchObject({ dispatchState: "sent", dispatchSequence: 1, revision: 2 });

    const claimed = await applyUnderstandDispatchEvent(opened.id, {
      type: "claim",
      expectedRevision: 2,
      wakeSequence: 1,
    });
    expect(claimed).toMatchObject({ dispatchState: "claimed", dispatchSequence: 1, revision: 3 });

    const nextDueAt = Date.now() + 10_000;
    const nextWake = await applyUnderstandDispatchEvent(opened.id, {
      type: "step-ended",
      expectedRevision: 3,
      nextDueAtMs: nextDueAt,
    });
    expect(nextWake).toMatchObject({
      dispatchState: "pending",
      dispatchSequence: 2,
      dispatchDueAt: new Date(nextDueAt),
      revision: 4,
    });
  });

  it("grants one fenced lease at a time and rejects stale owners", async () => {
    const userRows = await db.insert(users).values({
      email: `long-media-lease-${randomUUID()}@example.test`,
      emailVerified: true,
    }).returning({ id: users.id });
    const opened = await openUnderstandOperation({
      actorUserId: userRows[0]!.id,
      originKind: "agent_turn",
      originKey: `turn:${randomUUID()}`,
      requestDigest: "sha256:lease-request",
      sources: [{ sourceIndex: 0, assetId: randomUUID() }],
      question: "Describe the recording.",
      mode: "understand",
      locale: "en",
      model: "test-model",
      promptVersion: "test-v1",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      recoveryGroupId: randomUUID(),
      logicalRequestId: randomUUID(),
      userActionId: randomUUID(),
    });

    const first = await claimUnderstandOperationLease(opened.id, 60_000);
    const duplicate = await claimUnderstandOperationLease(opened.id, 60_000);

    expect(first).toMatchObject({ kind: "claimed", epoch: 1 });
    expect(duplicate).toEqual({ kind: "busy" });
    if (first.kind !== "claimed") throw new Error("The first lease was not granted.");

    const operation = await getUnderstandOperation(opened.id);
    expect(operation).toMatchObject({
      status: "running",
      revision: 2,
      leaseEpoch: first.epoch,
      leaseToken: first.token,
    });
    expect(operation?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());

    const renewed = await renewUnderstandOperationLease(opened.id, first.token, first.epoch, 60_000);
    expect(renewed.kind).toBe("applied");
    if (renewed.kind !== "applied") throw new Error("The current lease did not renew.");
    expect(renewed.revision).toBe(3);
    await expect(releaseUnderstandOperationLease(opened.id, first.token, first.epoch + 1))
      .resolves.toEqual({ kind: "stale" });
    await expect(releaseUnderstandOperationLease(opened.id, first.token, first.epoch))
      .resolves.toEqual({ kind: "applied", revision: 4 });

    const recovered = await claimUnderstandOperationLease(opened.id, 60_000);
    expect(recovered).toMatchObject({ kind: "claimed", epoch: 2, revision: 5 });
    const cancelled = await applyUnderstandOperationEvent(opened.id, {
      type: "cancel-applied",
      expectedRevision: 5,
      atMs: Date.now(),
    });
    expect(cancelled).toMatchObject({ status: "cancelled", leaseToken: null, leaseExpiresAt: null, revision: 6 });
  });

  it("waits for the operation row lock before claiming a lease", async () => {
    const userRows = await db.insert(users).values({
      email: `long-media-lease-lock-${randomUUID()}@example.test`,
      emailVerified: true,
    }).returning({ id: users.id });
    const opened = await openUnderstandOperation({
      actorUserId: userRows[0]!.id,
      originKind: "agent_turn",
      originKey: `turn:${randomUUID()}`,
      requestDigest: "sha256:lease-lock-request",
      sources: [{ sourceIndex: 0, assetId: randomUUID() }],
      question: "Describe the recording.",
      mode: "understand",
      locale: "en",
      model: "test-model",
      promptVersion: "test-v1",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      recoveryGroupId: randomUUID(),
      logicalRequestId: randomUUID(),
      userActionId: randomUUID(),
    });

    let enterLock: () => void = () => undefined;
    let releaseLock: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { enterLock = resolve; });
    const resume = new Promise<void>((resolve) => { releaseLock = resolve; });
    const held = sqlClient.begin(async (tx) => {
      await tx`SELECT id FROM media_understanding_operations WHERE id = ${opened.id} FOR UPDATE`;
      enterLock();
      await resume;
    });
    await entered;
    const first = claimUnderstandOperationLease(opened.id, 60_000);
    try {
      await waitUntilBlockedOn(sqlClient, ["media_understanding_operations", "for update"]);
    } finally {
      releaseLock();
      await held;
    }

    expect(await first).toMatchObject({ kind: "claimed", epoch: 1 });
    expect(await claimUnderstandOperationLease(opened.id, 60_000)).toEqual({ kind: "busy" });
  });

  it("refuses an approved handoff after the operation has closed", async () => {
    const userRows = await db.insert(users).values({
      email: `long-media-closed-${randomUUID()}@example.test`,
      emailVerified: true,
    }).returning({ id: users.id });
    const opened = await openUnderstandOperation({
      actorUserId: userRows[0]!.id,
      originKind: "agent_turn",
      originKey: `turn:${randomUUID()}`,
      requestDigest: "sha256:closed-operation",
      sources: [{ sourceIndex: 0, assetId: randomUUID() }],
      question: "Describe the recording.",
      mode: "understand",
      locale: "en",
      model: "test-model",
      promptVersion: "test-v1",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      recoveryGroupId: randomUUID(),
      logicalRequestId: randomUUID(),
      userActionId: randomUUID(),
    });
    await applyUnderstandOperationEvent(opened.id, {
      type: "cancel-applied",
      expectedRevision: 1,
      atMs: Date.now(),
    });

    await expect(applyUnderstandDispatchEvent(opened.id, {
      type: "approved-handoff",
      expectedRevision: 2,
      nextDueAtMs: Date.now() + 5_000,
    })).rejects.toThrow("closed operation");
  });

  it("scans only due outbox wakes for operations that still accept work", async () => {
    const userRows = await db.insert(users).values({
      email: `long-media-scan-${randomUUID()}@example.test`,
      emailVerified: true,
    }).returning({ id: users.id });
    const common = {
      actorUserId: userRows[0]!.id,
      originKind: "agent_turn" as const,
      requestDigest: "sha256:dispatch-scan",
      sources: [{ sourceIndex: 0, assetId: randomUUID() }],
      question: "Describe the recording.",
      mode: "understand",
      locale: "en",
      model: "test-model",
      promptVersion: "test-v1",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      recoveryGroupId: randomUUID(),
      logicalRequestId: randomUUID(),
    };
    const active = await openUnderstandOperation({
      ...common,
      originKey: `turn:${randomUUID()}`,
      userActionId: randomUUID(),
    });
    const closed = await openUnderstandOperation({
      ...common,
      originKey: `turn:${randomUUID()}`,
      requestDigest: "sha256:closed-dispatch-scan",
      userActionId: randomUUID(),
    });
    const blocked = await openUnderstandOperation({
      ...common,
      originKey: `turn:${randomUUID()}`,
      requestDigest: "sha256:blocked-dispatch-scan",
      userActionId: randomUUID(),
    });
    await applyUnderstandOperationEvent(closed.id, {
      type: "cancel-applied",
      expectedRevision: 1,
      atMs: Date.now(),
    });
    await applyUnderstandOperationEvent(blocked.id, {
      type: "claim",
      expectedRevision: 1,
      atMs: Date.now(),
    });
    await applyUnderstandOperationEvent(blocked.id, {
      type: "unknown",
      expectedRevision: 2,
      atMs: Date.now(),
    });

    const due = await listDueUnderstandDispatches(50);
    expect(due.map(({ operationId }) => operationId)).toContain(active.id);
    expect(due.map(({ operationId }) => operationId)).not.toContain(closed.id);
    expect(due.map(({ operationId }) => operationId)).not.toContain(blocked.id);
  });
});
