// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Idempotency of the internal write endpoints (inner#1410 §4.6): one key
 * space over dispositions and resend mail rows, looked up when the request
 * arrives and again inside the write transaction, after the key's advisory
 * lock and the lot's row lock.
 */

import { createHash } from "node:crypto";
import type { DbTx } from "@breatic/core";
import * as operationRepo from "@server/modules/credit-refund/operation.repo.js";
import type { CreditRefundOperation } from "@server/modules/credit-refund/operation.repo.js";
import * as refundMailRepo from "@server/modules/credit-refund/refund-mail.repo.js";
import type { RefundMail } from "@server/modules/credit-refund/refund-mail.repo.js";
import { RefundRefusal } from "@server/modules/credit-refund/refusal.js";

/** What an earlier request under the same key left. */
export type Replay = { kind: "operation"; op: CreditRefundOperation } | { kind: "mail"; mail: RefundMail };

/**
 * JSON with every object's keys sorted, so field order does not make two
 * bodies different requests.
 * @param value - Parsed JSON.
 * @returns The canonical text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The request's fingerprint, kept in `request_hash`.
 * @param method - HTTP method.
 * @param routeTemplate - The route's path template.
 * @param targetId - The `lotId` or `operationId` in the path.
 * @param body - The parsed body.
 * @returns Lowercase hex SHA-256.
 */
export function fingerprint(
  method: string,
  routeTemplate: string,
  targetId: string,
  body: unknown,
): string {
  return createHash("sha256")
    .update([method, routeTemplate, targetId, canonicalJson(body)].join("\n"))
    .digest("hex");
}

/**
 * Look the key up in both tables and apply the §4.6 rules.
 * @param key - The `Idempotency-Key`.
 * @param hash - This request's fingerprint.
 * @param tx - The write transaction, for the second lookup.
 * @returns What to replay, or null when the key is unused.
 * @throws {RefundRefusal} 422 `idempotency_key_reused` or 409 `request_in_progress`.
 */
export async function lookupKey(key: string, hash: string, tx?: DbTx): Promise<Replay | null> {
  const held = await operationRepo.findByKey(key, tx);
  if (held) {
    if (held.op.requestHash !== hash) throw reused();
    if (held.op.status === "started" && held.leaseHeld) throw inProgress();
    return { kind: "operation", op: held.op };
  }
  const mail = await refundMailRepo.findByKey(key, tx);
  if (mail) {
    if (mail.requestHash !== hash) throw reused();
    if (mail.mail.status === "sending") throw inProgress();
    return { kind: "mail", mail: mail.mail };
  }
  return null;
}

/**
 * The refusal of a key reused by a different request.
 * @returns The 422.
 */
function reused(): RefundRefusal {
  return new RefundRefusal(422, "idempotency_key_reused", "idempotency_key_reused");
}

/**
 * The refusal of a key whose original request still runs.
 * @returns The 409.
 */
function inProgress(): RefundRefusal {
  return new RefundRefusal(409, "request_in_progress", "request_in_progress");
}
