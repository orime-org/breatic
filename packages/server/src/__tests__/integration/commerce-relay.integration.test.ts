// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The relay that sends the product's outbox to the billing service
 * (inner#1993 §3.4, §5.2), against a stand-in billing service that checks the
 * signature the way the real one does: an answered row is marked sent, a
 * permanent failure or a refusal moves it to the dead letters, an
 * unavailable service puts it back with a backoff and holds back only its own
 * aggregate, and a row out of attempts is given up.
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { closeDb, createInternalAuth, env, getCommerceConfig, getRedis, initCore } from "@breatic/core";
import { forwardNextCommerceEvent } from "@server/modules/commerce/commerce-relay.js";
import { serveOnLoopback, type RunningApp } from "./internal-api-harness.js";

const PRODUCT_SECRET = "commerce-secret-current-0123456789abcdef";

/** What the stand-in answers next, and what it saw. */
const billing: {
  reply: () => { status: number; body: unknown };
  seen: Array<{ path: string; signer: string; body: unknown }>;
} = { reply: () => ({ status: 200, body: { result: "applied" } }), seen: [] };

let sql: ReturnType<typeof postgres>;
let running: RunningApp;

beforeAll(async () => {
  const app = new Hono();
  app.use(
    "*",
    createInternalAuth({
      secretsFor: (signer) => (signer === "product" ? { current: PRODUCT_SECRET, previous: "" } : null),
      mayAccess: () => true,
      redis: getRedis,
      keyPrefix: () => `${env.ENV}:relay-test`,
      report: () => undefined,
    })(),
  );
  app.post("/v1/inbox/:outboxId", async (c) => {
    billing.seen.push({ path: c.req.path, signer: c.req.header("x-internal-admin") ?? "", body: await c.req.json() });
    const { status, body } = billing.reply();
    return c.json(body as object, status as 200);
  });
  running = await serveOnLoopback(app);
  initCore({
    ...process.env,
    CHARGING_ENABLED: "true",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef",
    COMMERCE_API_URL: running.baseUrl,
    COMMERCE_API_SECRET: PRODUCT_SECRET,
  });
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-relay-test" } });
});

beforeEach(async () => {
  // Other files leave unsent rows behind; this file drains only its own.
  await sql`DELETE FROM commerce_outbox`;
  billing.reply = () => ({ status: 200, body: { result: "applied" } });
  billing.seen = [];
});

afterAll(async () => {
  await running?.close();
  await sql?.end({ timeout: 1 });
  await closeDb();
  initCore(process.env);
});

/**
 * Append one row.
 * @param aggregateKey - Its aggregate.
 * @returns Its id and sequence number.
 */
async function row(aggregateKey: string): Promise<{ id: string; seq: number }> {
  const [r] = await sql<{ id: string; seq: string }[]>`
    INSERT INTO commerce_outbox(aggregate_key,type,payload) VALUES (${aggregateKey},'account_erasure',${sql.json({ userId: randomUUID() })})
    RETURNING id, seq::text AS seq`;
  return { id: r!.id, seq: Number(r!.seq) };
}

/**
 * One outbox row's delivery state.
 * @param id - The row.
 * @returns Its state, or undefined once it left the outbox.
 */
async function state(id: string): Promise<{ sent: boolean; attempts: number; lastError: string | null; due: boolean } | undefined> {
  const [r] = await sql<{ sent: boolean; attempts: number; last_error: string | null; due: boolean }[]>`
    SELECT sent_at IS NOT NULL AS sent, attempts, last_error, next_attempt_at <= now() AS due FROM commerce_outbox WHERE id = ${id}`;
  return r === undefined ? undefined : { sent: r.sent, attempts: r.attempts, lastError: r.last_error, due: r.due };
}

/**
 * The dead letter kept for a row.
 * @param id - The row.
 * @returns Its reason and attempts, or undefined.
 */
async function deadLetter(id: string): Promise<{ reason: string; attempts: number } | undefined> {
  const [r] = await sql<{ reason: string; attempts: number }[]>`SELECT reason, attempts FROM commerce_outbox_dead_letters WHERE id = ${id}`;
  return r;
}

describe("forwardNextCommerceEvent", () => {
  it("delivers a row signed as the product and marks it sent", async () => {
    const aggregateKey = `erasure:${randomUUID()}`;
    const { id, seq } = await row(aggregateKey);

    expect(await forwardNextCommerceEvent()).toEqual({ id });

    expect(await state(id)).toMatchObject({ sent: true });
    expect(billing.seen).toEqual([
      { path: `/v1/inbox/${id}`, signer: "product", body: { type: "account_erasure", aggregateKey, seq, payload: expect.any(Object) } },
    ]);
    expect(await forwardNextCommerceEvent()).toBeNull();
  });

  it("marks a duplicate sent", async () => {
    const { id } = await row(`erasure:${randomUUID()}`);
    billing.reply = () => ({ status: 200, body: { result: "duplicate" } });

    await forwardNextCommerceEvent();

    expect(await state(id)).toMatchObject({ sent: true });
  });

  it("moves a permanent failure to the dead letters", async () => {
    const { id } = await row(`erasure:${randomUUID()}`);
    billing.reply = () => ({ status: 200, body: { result: "permanent_failure", detail: "unknown type" } });

    expect(await forwardNextCommerceEvent()).toMatchObject({ id, deadLettered: true });

    expect(await state(id)).toBeUndefined();
    expect(await deadLetter(id)).toEqual({ reason: "permanent_failure", attempts: 1 });
  });

  it("moves a refused delivery to the dead letters", async () => {
    const { id } = await row(`erasure:${randomUUID()}`);
    billing.reply = () => ({ status: 422, body: { code: "invalid_body" } });

    expect(await forwardNextCommerceEvent()).toMatchObject({ id, deadLettered: true });

    expect(await deadLetter(id)).toEqual({ reason: "refused", attempts: 1 });
  });

  it("puts an undelivered row back with a backoff, holding back only its own aggregate", async () => {
    const held = `erasure:${randomUUID()}`;
    const first = await row(held);
    const behind = await row(held);
    const other = await row(`erasure:${randomUUID()}`);
    billing.reply = () => ({ status: 503, body: { code: "unavailable" } });

    expect(await forwardNextCommerceEvent()).toMatchObject({ id: first.id, error: expect.anything() });
    expect(await state(first.id)).toMatchObject({ sent: false, attempts: 1, due: false, lastError: expect.stringContaining("503") });

    billing.reply = () => ({ status: 200, body: { result: "applied" } });
    expect(await forwardNextCommerceEvent()).toEqual({ id: other.id });
    expect(await forwardNextCommerceEvent()).toBeNull();
    expect(await state(behind.id)).toMatchObject({ sent: false, attempts: 0 });
  });

  it("gives up a row that runs out of attempts", async () => {
    const { id } = await row(`erasure:${randomUUID()}`);
    await sql`UPDATE commerce_outbox SET attempts = ${getCommerceConfig().relay_max_attempts - 1} WHERE id = ${id}`;
    billing.reply = () => ({ status: 503, body: { code: "unavailable" } });

    expect(await forwardNextCommerceEvent()).toMatchObject({ id, deadLettered: true });

    expect(await deadLetter(id)).toEqual({ reason: "attempts_exhausted", attempts: getCommerceConfig().relay_max_attempts });
  });
});
