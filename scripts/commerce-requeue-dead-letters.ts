// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Requeues dead-lettered billing-service outbox rows (inner#1993 §5.2).
 *
 * The relay gives a `commerce_outbox` row up, into
 * `commerce_outbox_dead_letters`, after a refusal or `relay_max_attempts`
 * failed attempts, and never sends it again. Once the cause is found and
 * fixed, this puts the picked rows back as new unsent rows with the same
 * type, aggregate and payload, keeps the dead letters and marks them
 * requeued, all in one transaction; the running relay then sends them. A
 * dead-lettered lot event is resent as its lot's current lifecycle, never as
 * the old event. A requeued row carries a new id and seq, so the billing
 * service applies it again; each event type must be idempotent there (a
 * binding answers already_bound, an erasure repeats, a lot is resent as its
 * current state). A selection by reason skips dead letters already
 * requeued; one named by id is requeued again only with --again. A
 * deployment that sells nothing (no COMMERCE_API_URL) refuses --apply, since
 * no relay would send the rows.
 *
 * Usage, from the repository root:
 *   pnpm commerce:requeue-dead-letters --id <id> [--id <id> ...] [--again] report only
 *   pnpm commerce:requeue-dead-letters --reason <reason> --since <instant> report only
 *   add --apply to either to requeue what the report lists
 */

import { findRoot, loadEnv } from "./load-env.js";
import { parseRequeueOptions, pickRequeue } from "./commerce-requeue-dead-letters-options.js";

const options = parseRequeueOptions(process.argv.slice(2));
if (options.help) {
  console.log("Usage: pnpm commerce:requeue-dead-letters (--id <id> ... [--again] | --reason <reason> --since <ISO instant with zone>) [--apply]");
} else {
  loadEnv(findRoot());
  const loaded: unknown = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
  const core = loaded as typeof import("../packages/core/src/index.js");
  const loadedDomain: unknown = await import(new URL("../packages/domain/dist/index.js", import.meta.url).href);
  const domain = loadedDomain as typeof import("../packages/domain/src/index.js");
  core.initCore(process.env);
  try {
    const letters = await core.commerceOutboxRepo.listDeadLetters(options.selection);
    for (const l of letters) {
      const requeued = l.requeuedAt === null ? "" : ` requeued=${l.requeuedAt.toISOString()}`;
      console.log(`${l.id} ${l.type} ${l.aggregateKey} reason=${l.reason} attempts=${l.attempts} failed=${l.failedAt.toISOString()}${requeued}`);
    }
    const { requeue, skipped } = pickRequeue(options.selection, letters, options.again);
    for (const l of skipped) console.log(`skip ${l.id}: already requeued at ${l.requeuedAt!.toISOString()}`);
    if (options.apply) {
      const result = await core.commerceOutboxRepo.requeueDeadLetters(
        requeue.map((l) => l.id),
        (lotIds) => domain.creditLotService.resendLotStates(lotIds),
      );
      for (const m of result.requeued) console.log(`requeued ${m.deadLetterId} as outbox row ${m.outboxId}`);
      const lots = requeue.length - result.requeued.length;
      console.log(`${letters.length} dead letters listed, ${skipped.length} skipped, ${result.requeued.length} copied back, ${lots} lot dead letters answered with ${result.lotsResent} current-lifecycle rows; the relay sends them on its next pass`);
    } else {
      console.log(`${letters.length} dead letters listed, ${skipped.length} skipped; run again with --apply to requeue the other ${requeue.length}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await core.closeDb();
  }
}
