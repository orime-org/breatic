// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { initCore, loadLocales } from "@breatic/core";
import { httpRequest } from "@breatic/shared";
import { serveOnLoopback, type RunningApp } from "@server/__tests__/integration/internal-api-harness.js";

const secret = "whsec_recording_integration_fixture";
const signer = new Stripe("sk_test_unused_by_recording_suite");
let running: RunningApp;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_unused_by_recording_suite", STRIPE_WEBHOOK_SECRET: secret, STRIPE_WEBHOOK_ACCOUNT_ID: "acct_recordtest", STRIPE_WEBHOOK_ENDPOINT_ID: "we_recordtest" });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "stripe-attempt-receiver-test" } });
  const { createApp } = await import("@server/app.js");
  running = await serveOnLoopback(createApp());
});

afterAll(async () => {
  await running?.close();
  await sql?.end({ timeout: 1 });
});

/**
 * Builds a complete signed event fixture without contacting Stripe.
 * @param type - Stripe event type.
 * @param object - Event resource fixture.
 * @returns The signed event payload.
 */
function event(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return { id: `evt_${randomUUID().replaceAll("-", "")}`, object: "event", api_version: "2025-01-27.acacia", created: Math.floor(Date.now() / 1000), livemode: false, account: "acct_connected123", pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, data: { object } };
}

/**
 * Sends a locally signed delivery through the real HTTP listener.
 * @param value - Complete event fixture.
 * @param signingSecret - Fixture endpoint signing secret.
 * @returns The actual HTTP response.
 * @throws When the HTTP transport fails.
 */
function deliver(value: Record<string, unknown>, signingSecret = secret): Promise<Response> {
  const payload = JSON.stringify(value);
  return httpRequest(`${running.baseUrl}/api/v1/payment/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret: signingSecret }) }, body: payload }, { replaySafe: false, timeoutMs: 10_000 });
}

describe("Stripe attempt receiver over HTTP and PostgreSQL", () => {
  it("retains an unfinished start when its receiver process dies during business", async () => {
    const child = fork(fileURLToPath(new URL("./receiver-child.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../../tsconfig.json", import.meta.url)),
        PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_unused_by_recording_suite", STRIPE_WEBHOOK_SECRET: secret },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let release: (() => void) | undefined;
    let hold: Promise<unknown> | undefined;
    let response: Promise<unknown> | undefined;
    const exited = once(child, "exit");
    try {
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
      const port = (message as { port: number }).port;
      let locked: (() => void) | undefined;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      hold = sql.begin(async tx => {
        await tx`lock table stripe_webhook_events in access exclusive mode`;
        locked!();
        await gate;
      });
      await ready;
      const input = event("refund.failed", { id: "re_process_death", payment_intent: null });
      const payload = JSON.stringify(input);
      response = httpRequest(`http://127.0.0.1:${port}/api/v1/payment/webhook`, {
        method: "POST", headers: { "content-type": "application/json", "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret }) }, body: payload,
      }, { replaySafe: false, timeoutMs: 15_000 }).catch(error => error);
      await vi.waitFor(async () => {
        expect(await sql`select id from stripe_webhook_attempts where event_id = ${String(input.id)}`).toHaveLength(1);
      });
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;
      release!();
      await hold;
      await response;
      expect(await sql`select result, response_status, finished_at from stripe_webhook_attempts where event_id = ${String(input.id)}`).toEqual([{ result: null, response_status: null, finished_at: null }]);
      expect(await sql`select event_id from stripe_webhook_events where event_id = ${String(input.id)}`).toHaveLength(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      release?.();
      await hold;
      await response;
    }
  });

  it("saves every ignored delivery with controlled source fields and no ledger claim", async () => {
    const input = event("charge.updated", { id: "ch_attempt", object: "charge" });
    for (let index = 0; index < 2; index++) {
      const response = await deliver(input);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
    }
    const rows = await sql`select id, event_type, livemode, account_id, endpoint_id, connected_account_id, environment, result, response_status, finished_at is not null as finished from stripe_webhook_attempts where event_id = ${String(input.id)} and deleted_at is null`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.id)).size).toBe(2);
    for (const row of rows) expect({ ...row, id: "attempt" }).toEqual({ id: "attempt", event_type: "charge.updated", livemode: false, account_id: "acct_recordtest", endpoint_id: "we_recordtest", connected_account_id: "acct_connected123", environment: "dev", result: "ignored", response_status: 200, finished: true });
    expect(await sql`select event_id from stripe_webhook_events where event_id = ${String(input.id)}`).toHaveLength(0);
  });

  it("records a missing refund target alongside its existing ledger claim", async () => {
    const input = event("refund.failed", { id: "re_attempt", object: "refund", payment_intent: null });
    const response = await deliver(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(await sql`select result, response_status from stripe_webhook_attempts where event_id = ${String(input.id)}`).toEqual([{ result: "refund_no_target", response_status: 200 }]);
    expect(await sql`select type from stripe_webhook_events where event_id = ${String(input.id)}`).toEqual([{ type: "refund.failed" }]);
  });

  it("records neither a rejected signature nor an invalid verified identity", async () => {
    const badSignature = event("charge.updated", { id: "ch_signature" });
    const response = await deliver(badSignature, "whsec_wrong_fixture");
    expect(response.status).toBe(400);
    const invalid = event("charge.updated", { id: "ch_shape" });
    delete invalid.livemode;
    expect((await deliver(invalid)).status).toBe(400);
    expect(await sql`select id from stripe_webhook_attempts where event_id in (${String(badSignature.id)}, ${String(invalid.id)})`).toHaveLength(0);
  });

  it("answers 503 without dispatch when the real start transaction times out", async () => {
    const input = event("refund.failed", { id: "re_blocked_start", payment_intent: null });
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
      const response = await deliver(input);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ received: false });
    } finally {
      release!();
      await hold;
    }
    expect(await sql`select id from stripe_webhook_attempts where event_id = ${String(input.id)}`).toHaveLength(0);
    expect(await sql`select event_id from stripe_webhook_events where event_id = ${String(input.id)}`).toHaveLength(0);
  });

  it("preserves HTTP 200 and the unfinished start when the real completion write fails", async () => {
    const input = event("charge.updated", { id: "ch_blocked_finish" });
    input.id = `evt_completion_failure_${randomUUID().replaceAll("-", "")}`;
    await sql`create function stripe_attempt_test_reject_finish() returns trigger language plpgsql as $$ begin raise exception 'controlled completion write failure'; end $$`;
    try {
      await sql`create trigger stripe_attempt_test_reject_finish before update on stripe_webhook_attempts for each row when (new.finished_at is not null and new.event_id like 'evt_completion_failure_%') execute function stripe_attempt_test_reject_finish()`;
      const response = await deliver(input);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
      expect(await sql`select finished_at, response_status, result from stripe_webhook_attempts where event_id = ${String(input.id)}`).toEqual([{ finished_at: null, response_status: null, result: null }]);
    } finally {
      await sql`drop trigger if exists stripe_attempt_test_reject_finish on stripe_webhook_attempts`;
      await sql`drop function stripe_attempt_test_reject_finish()`;
    }
  });
});
