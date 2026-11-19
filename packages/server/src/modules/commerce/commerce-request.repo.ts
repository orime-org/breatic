// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `commerce_requests`: one row per write the billing service asked of the
 * product, holding the answer it got (inner#1993 §3.3).
 */

import { eq, sql } from "drizzle-orm";
import { commerceRequests, type DbTx } from "@breatic/core";

/** The answer a request got, as stored and replayed. */
export interface StoredAnswer {
  httpStatus: number;
  body: unknown;
}

/** A request's stored record. */
export interface StoredRequest {
  requestHash: string;
  answer: StoredAnswer;
}

/**
 * Hold the key for the rest of the transaction, so two requests with one key
 * run one after the other.
 * @param key - The request key.
 * @param tx - The claiming transaction.
 */
export async function lockKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`commerce-request:${key}`}))`);
}

/**
 * Read a key's stored record.
 * @param key - The request key.
 * @param tx - The claiming transaction.
 * @returns The record, or null for an unused key.
 */
export async function findRequest(key: string, tx: DbTx): Promise<StoredRequest | null> {
  const [row] = await tx
    .select({ requestHash: commerceRequests.requestHash, answer: commerceRequests.answer })
    .from(commerceRequests)
    .where(eq(commerceRequests.key, key))
    .limit(1);
  return row === undefined ? null : { requestHash: row.requestHash, answer: row.answer as StoredAnswer };
}

/**
 * Store a request's answer.
 * @param request - The key, kind, request hash, outcome and answer.
 * @param request.key - The request key.
 * @param request.kind - What kind of write it was.
 * @param request.hash - The request's fingerprint.
 * @param request.status - Whether it was applied or refused.
 * @param request.answer - What it answered.
 * @param tx - The claiming transaction.
 */
export async function insertRequest(
  request: { key: string; kind: string; hash: string; status: "applied" | "refused"; answer: StoredAnswer },
  tx: DbTx,
): Promise<void> {
  await tx.insert(commerceRequests).values({
    key: request.key,
    kind: request.kind,
    requestHash: request.hash,
    status: request.status,
    answer: request.answer,
  });
}
