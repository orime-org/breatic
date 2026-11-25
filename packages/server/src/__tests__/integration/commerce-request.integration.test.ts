// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Every write the billing service asks of the product runs once per key
 * (inner#1993 §3.3, §8.2): the first request runs inside the transaction that
 * claims its `commerce_requests` row and stores the answer there; the same
 * key with the same request replays that answer, refusals included; the same
 * key with a different request is refused with 422; a run that throws stores
 * nothing, so the next request runs it again.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { closeDb, initCore } from "@breatic/core";
import { answerOnce } from "@server/modules/commerce/commerce-request.service.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-request-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * A fresh key, so cases never share a row.
 * @returns The key.
 */
function key(): string {
  return `grant:${randomUUID()}`;
}

describe("answerOnce", () => {
  it("runs the first request and stores its answer under the key", async () => {
    const k = key();
    const run = vi.fn(async () => ({ status: "applied" as const, httpStatus: 200, body: { lotId: "lot-1" } }));

    const answer = await answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, run);

    expect(answer).toEqual({ httpStatus: 200, body: { lotId: "lot-1" } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await sql`SELECT kind, status, answer FROM commerce_requests WHERE key = ${k}`).toEqual([
      { kind: "grant", status: "applied", answer: { httpStatus: 200, body: { lotId: "lot-1" } } },
    ]);
  });

  it("replays the stored answer for the same key and request without running again", async () => {
    const k = key();
    const first = vi.fn(async () => ({ status: "applied" as const, httpStatus: 200, body: { n: 1 } }));
    const second = vi.fn(async () => ({ status: "applied" as const, httpStatus: 200, body: { n: 2 } }));
    await answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, first);

    const answer = await answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, second);

    expect(answer).toEqual({ httpStatus: 200, body: { n: 1 } });
    expect(second).not.toHaveBeenCalled();
  });

  it("replays a refusal the same way", async () => {
    const k = key();
    await answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, async () => ({
      status: "refused" as const,
      httpStatus: 409,
      body: { code: "receipt_conflict" },
    }));

    const answer = await answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, vi.fn());

    expect(answer).toEqual({ httpStatus: 409, body: { code: "receipt_conflict" } });
  });

  it("refuses the same key with a different request and runs nothing", async () => {
    const k = key();
    await answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, async () => ({ status: "applied" as const, httpStatus: 200, body: {} }));
    const run = vi.fn();

    const answer = await answerOnce({ key: k, kind: "grant", hash: "b".repeat(64) }, run);

    expect(answer).toEqual({ httpStatus: 422, body: { code: "idempotency_key_reused" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("stores nothing when the run throws, so the next request runs it", async () => {
    const k = key();
    await expect(
      answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await sql`SELECT 1 FROM commerce_requests WHERE key = ${k}`).toHaveLength(0);

    const run = vi.fn(async () => ({ status: "applied" as const, httpStatus: 200, body: { ok: true } }));
    expect(await answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, run)).toEqual({ httpStatus: 200, body: { ok: true } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs once when two requests with one key arrive together", async () => {
    const k = key();
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: "applied" as const, httpStatus: 200, body: { once: true } };
    });

    const answers = await Promise.all([
      answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, run),
      answerOnce({ key: k, kind: "grant", hash: "a".repeat(64) }, run),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([{ httpStatus: 200, body: { once: true } }, { httpStatus: 200, body: { once: true } }]);
  });
});
