// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size cap's half of `beforeSync` (inner#1790): admit or refuse each sync
 * message of a writable connection before Hocuspocus applies it.
 *
 * The upper bound only admits; a refusal comes from yjs reporting new pending
 * content, from the trial budget, or from an exact trial on a copy. A refused
 * message is not applied and Hocuspocus closes that document's connection
 * with the error's reason; the inbound filter then drops what the client had
 * already sent for it until it authenticates the document again.
 */

import type { beforeSyncPayload } from "@hocuspocus/server";
import { messageYjsSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";
import { checkRateLimit, createLogger, getRedis } from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from "@breatic/shared";
import { getCollabConfig } from "@collab/config.js";
import type { AuthContext } from "@collab/hooks/auth.js";
import { userIdOf } from "@collab/hooks/presence-wiring.js";
import { markRefused } from "@collab/infra/inbound-filter.js";
import {
  addUpperBound, analyze, holdUntilApplied, measure, readDocSizeRecord, recordExact, unappliedBesides,
} from "@collab/services/document-size.js";

const logger = createLogger("document-size-gate");

/** Why a message was refused, as the refusal log names it. */
type RefusalStep = "pending" | "budget_user" | "budget_process" | "trial";

/**
 * Build the size gate. Its token bucket bounds the time this process spends
 * on trials: it starts full, refills `document_size_trial_budget_ms_per_second`
 * per second up to one second's worth, and each trial is charged what it
 * took, so the balance may go negative and refuse until it has refilled.
 * @returns The `beforeSync` callback.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function createDocumentSizeGate(): (data: beforeSyncPayload<AuthContext>) => Promise<void> {
  const cfg = getCollabConfig();
  const rate = cfg.document_size_trial_budget_ms_per_second;
  // Kept in thousandths of a millisecond, so whole-millisecond refills and
  // charges add up exactly and a balance that should be 0 is not -1e-14.
  const capacity = rate * 1000;
  let balance = capacity;
  let at = performance.now();

  /**
   * Bring the bucket up to a moment.
   * @param now - The moment, from `performance.now()`.
   */
  const refill = (now: number): void => {
    balance = Math.min(capacity, balance + (now - at) * rate);
    at = now;
  };

  return async (data): Promise<void> => {
    const { documentName, document, connection, type, payload } = data;
    if (type === messageYjsSyncStep1 || connection.readOnly) return;
    const record = readDocSizeRecord(documentName);
    if (!record) return;
    const limit = cfg.max_document_bytes;
    const ceiling = limit + cfg.document_size_delete_headroom_bytes;
    const userId = userIdOf(data);

    /**
     * Refuse the message.
     * @param step - Why.
     * @param after - The trial's size, when a trial decided.
     * @throws {Error} Always, carrying the size-limit close reason.
     */
    const refuse = (step: RefusalStep, after?: number): never => {
      markRefused(connection.socketId, documentName);
      logger.warn({ documentName, userId, upper: record.upper, after, limit, ceiling, step }, "document_size_limit_refused");
      throw Object.assign(new Error("document size limit reached"), { reason: COLLAB_DOCUMENT_TOO_LARGE_REASON });
    };

    const analyzed = performance.now();
    const a = analyze(payload, document);
    if (a.skeletonBuilt) {
      const ended = performance.now();
      refill(ended);
      balance -= (ended - analyzed) * 1000;
    }
    if (a.wouldPend) refuse("pending");
    if (!a.integratesStored) {
      const g = a.growthBound;
      if (g === 0) {
        holdUntilApplied(documentName, connection, 0);
        return;
      }
      if (record.upper + g <= limit || (a.deletesLive && (record.upper + g <= ceiling || g <= a.freedBytes))) {
        const bound = Math.max(0, g - a.freedBytes);
        addUpperBound(documentName, bound);
        holdUntilApplied(documentName, connection, bound);
        return;
      }
    }

    refill(performance.now());
    if (balance < 0) refuse("budget_process");
    let allowed = true;
    try {
      ({ allowed } = await checkRateLimit(getRedis(), [
        { key: `collab-doc-size-trial:${documentName}:${userId}`, max: cfg.document_size_trials_per_user_per_minute, windowSeconds: 60 },
      ]));
    } catch (err) {
      // Redis down: the count is unknown, the token bucket still bounds the time.
      logger.error({ err, ctx: { documentName, userId } }, "doc_size_trial_budget_unavailable");
    }
    if (!allowed) refuse("budget_user");
    // Trials that passed the first check together resume one by one; each
    // sees what the ones before it spent.
    const started = performance.now();
    refill(started);
    if (balance < 0) refuse("budget_process");

    const pre = measure(document);
    const copy = new Y.Doc({ gc: document.gc });
    let after: number;
    try {
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
      Y.applyUpdate(copy, payload);
      after = measure(copy);
    } finally {
      copy.destroy();
      const ended = performance.now();
      refill(ended);
      balance -= (ended - started) * 1000;
    }
    // Updates admitted on other connections land after this one is decided.
    const others = unappliedBesides(documentName, connection);
    if (after + others <= limit || after <= pre || (a.deletesLive && after + others <= ceiling)) {
      recordExact(documentName, after);
      holdUntilApplied(documentName, connection, Math.max(0, after - pre));
      return;
    }
    refuse("trial", after);
  };
}
