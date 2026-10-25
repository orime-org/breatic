// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { closeDb, initCore } from "@breatic/core";
import { beginAttempt, finishAttempt } from "@server/modules/stripe-webhook/attempts.repo.js";
import type { AttemptStart } from "@server/modules/stripe-webhook/types.js";

let sql: ReturnType<typeof postgres>;
const ids: string[] = [];

/** Creates an owned receipt with all controlled start metadata. */
function start(eventId = `evt_${randomUUID()}`): AttemptStart {
  const id = randomUUID();
  ids.push(id);
  return { id, eventId, eventType: "refund.failed", livemode: false, accountId: null, endpointId: null, connectedAccountId: null, environment: "test", receivedAt: new Date("2026-10-24T08:00:00Z") };
}

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "stripe-attempt-repo-test" } });
});

afterAll(async () => {
  try {
    if (ids.length > 0) await sql`update stripe_webhook_attempts set deleted_at = now() where id = any(${ids}::uuid[])`;
  } finally {
    await sql?.end({ timeout: 1 });
    await closeDb();
  }
});

describe("persisted Stripe attempt transactions", () => {
  it("commits an unfinished start then preserves the first complete result", async () => {
    const input = start();
    await beginAttempt(input);
    expect(await sql`select event_id, event_type, livemode, account_id, endpoint_id, connected_account_id, environment, received_at, finished_at, response_status, result from stripe_webhook_attempts where id = ${input.id}`).toEqual([{
      event_id: input.eventId, event_type: "refund.failed", livemode: false, account_id: null, endpoint_id: null, connected_account_id: null, environment: "test", received_at: input.receivedAt, finished_at: null, response_status: null, result: null,
    }]);
    expect(await finishAttempt({ id: input.id, responseStatus: 200, result: "refund_synced" })).toBe("recorded");
    expect(await finishAttempt({ id: input.id, responseStatus: 500, result: "handler_exception" })).toBe("already_finished");
    const [row] = await sql`select response_status, result, finished_at is not null as finished from stripe_webhook_attempts where id = ${input.id}`;
    expect(row).toEqual({ response_status: 200, result: "refund_synced", finished: true });
  });

  it("retains independent concurrent attempts for one event", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async count => {
      const eventId = `evt_${randomUUID()}`;
      const inputs = Array.from({ length: count }, () => start(eventId));
      await Promise.all(inputs.map(input => beginAttempt(input)));
      const rows = await sql<{ id: string; event_id: string }[]>`select id, event_id from stripe_webhook_attempts where event_id = ${eventId} and deleted_at is null`;
      expect(rows.map(row => row.id).sort()).toEqual(inputs.map(input => input.id).sort());
      expect(rows.map(row => row.event_id)).toEqual(Array.from({ length: count }, () => eventId));
    }), { numRuns: 6 });
  });

  it("has one terminal winner under concurrent completions", async () => {
    const input = start();
    await beginAttempt(input);
    const results = await Promise.all([
      finishAttempt({ id: input.id, responseStatus: 200, result: "ignored" }),
      finishAttempt({ id: input.id, responseStatus: 500, result: "handler_exception" }),
    ]);
    expect(results.sort()).toEqual(["already_finished", "recorded"]);
    const [row] = await sql`select response_status, result from stripe_webhook_attempts where id = ${input.id}`;
    expect([{ response_status: 200, result: "ignored" }, { response_status: 500, result: "handler_exception" }]).toContainEqual(row);
  });

  it("rolls back a timed-out completion and accepts a later retry", async () => {
    const input = start();
    await beginAttempt(input);
    let locked: (() => void) | undefined;
    let release: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hold = sql.begin(async tx => {
      await tx`select id from stripe_webhook_attempts where id = ${input.id} for update`;
      locked!();
      await gate;
    });
    await ready;
    try {
      await expect(finishAttempt({ id: input.id, responseStatus: 200, result: "ignored" })).rejects.toMatchObject({ cause: { code: "57014" } });
    } finally {
      release!();
      await hold;
    }
    expect(await sql`select finished_at, response_status, result from stripe_webhook_attempts where id = ${input.id}`).toEqual([{ finished_at: null, response_status: null, result: null }]);
    expect(await finishAttempt({ id: input.id, responseStatus: 200, result: "ignored" })).toBe("recorded");
  });

  it("rolls back a timed-out start before acknowledging a later retry", async () => {
    const input = start();
    let locked: (() => void) | undefined;
    let release: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hold = sql.begin(async tx => {
      await tx`lock table stripe_webhook_attempts in access exclusive mode`;
      locked!();
      await gate;
    });
    await ready;
    try {
      await expect(beginAttempt(input)).rejects.toMatchObject({ cause: { code: "57014" } });
    } finally {
      release!();
      await hold;
    }
    expect(await sql`select id from stripe_webhook_attempts where id = ${input.id}`).toHaveLength(0);
    await beginAttempt(input);
    expect(await sql`select result, finished_at from stripe_webhook_attempts where id = ${input.id}`).toEqual([{ result: null, finished_at: null }]);
  });
});
