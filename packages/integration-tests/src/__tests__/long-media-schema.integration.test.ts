// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, initCore, users } from "@breatic/core";
import {
  applyUnderstandOperationEvent,
  getUnderstandOperation,
  openUnderstandOperation,
} from "@breatic/domain";

initCore(process.env);

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
});
