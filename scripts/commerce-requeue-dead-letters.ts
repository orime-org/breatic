// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Requeues dead-lettered billing-service outbox rows (inner#1993 §5.2).
 *
 * The relay gives a `commerce_outbox` row up, into
 * `commerce_outbox_dead_letters`, after a refusal or `relay_max_attempts`
 * failed attempts, and never sends it again. Once the cause is found and
 * fixed, this puts the picked rows back as new unsent rows with the same
 * type, aggregate and payload, in one transaction, and keeps the dead
 * letters; the running relay then sends them. Requeueing twice sends twice;
 * the billing service's inbox dedupes repeats. A dead-lettered lot event is
 * resent as its lot's current lifecycle, never as the old event.
 *
 * Usage, from the repository root:
 *   pnpm commerce:requeue-dead-letters --id <id> [--id <id> ...]          report only
 *   pnpm commerce:requeue-dead-letters --reason <reason> --since <instant> report only
 *   add --apply to either to requeue what the report lists
 */

import { findRoot, loadEnv } from "./load-env.js";
import { parseRequeueOptions } from "./commerce-requeue-dead-letters-options.js";

const options = parseRequeueOptions(process.argv.slice(2));
if (options.help) {
  console.log("Usage: pnpm commerce:requeue-dead-letters (--id <id> ... | --reason <reason> --since <ISO instant with zone>) [--apply]");
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
      console.log(`${options.apply ? "requeue" : "would requeue"} ${l.id} ${l.type} ${l.aggregateKey} reason=${l.reason} attempts=${l.attempts} failed=${l.failedAt.toISOString()}`);
    }
    if (options.apply) {
      const lots = letters.filter((l) => l.type === "lot_refund_lifecycle");
      const made = await core.commerceOutboxRepo.requeueDeadLetters(letters.filter((l) => !lots.includes(l)).map((l) => l.id));
      for (const m of made) console.log(`requeued ${m.deadLetterId} as outbox row ${m.outboxId}`);
      await domain.creditLotService.resendLotStates(lots.map((l) => l.aggregateKey.slice("lot:".length)));
      for (const l of lots) console.log(`resent the current lifecycle of ${l.aggregateKey} for ${l.id}`);
      console.log(`${letters.length} dead letters listed, ${made.length + lots.length} requeued; the relay sends them on its next pass`);
    } else {
      console.log(`${letters.length} dead letters listed; run again with --apply to requeue them`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await core.closeDb();
  }
}
