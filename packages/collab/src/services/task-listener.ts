// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Task lifecycle events, from the cross-service stream into the canvas
 * documents (#186, #1497 §6.1).
 *
 * Data path:
 *   server / worker → Redis stream → consumer group → per-document lease →
 *   one direct connection per document batch → applyNodeTaskCounts
 *
 * Collab executes; it does not judge. Which task moved, what the counts now
 * are, whether a result rides along — the server decided all of it.
 *
 * Several collab instances read the stream as one consumer group, so each
 * event reaches one of them. What keeps two of them from writing the same
 * document at once is the document lease in the coordination database; what
 * keeps the next holder from writing over a peer's update it has not received
 * yet is the hand-over record, the state vector the previous holder stored;
 * what keeps an older event from undoing a newer one is the version each node
 * carries.
 *
 * Doc layout: `project-{pid}/canvas-{spaceId}`, one canvas doc per Space. Any
 * other doc name is skipped.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { ExecutionError, Redlock, ResourceLockedError } from "@sesamecare-oss/redlock";
import type { NodeEvent, NodeTaskCountsEvent } from "@breatic/shared";
import { parseDocName } from "@breatic/shared";
import { createLogger, type Redis } from "@breatic/core";
import { applyNodeTaskCounts } from "@collab/services/node-task-counts.js";
import {
  startGroupConsumer,
  type EntryOutcome,
  type GroupConsumer,
  type GroupConsumerSettings,
  type StreamEntry,
} from "@collab/services/stream-group-consumer.js";

const logger = createLogger("task-listener");

/** Consumer group every collab instance joins for task events. */
export const TASK_EVENTS_GROUP = "collab-task-events";

/** How long a node's counts version is kept after its last write. */
const COUNTS_VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Settings of the task listener: the consumer group's, plus the per-document ones. */
export interface TaskListenerSettings extends GroupConsumerSettings {
  /** Documents of one batch handled at once. */
  docConcurrency: number;
  /** Document lease length. */
  docLeaseMs: number;
  /** Gap between checks that the local document holds the previous holder's writes. */
  handoffPollMs: number;
  /** Longest wait for those writes before the batch is retried. */
  handoffWaitMs: number;
}

/** What the listener needs. */
export interface TaskListenerDeps {
  /** The running Hocuspocus server. */
  hocuspocus: Hocuspocus;
  /** Redis URL of the stream database (DB2). */
  streamUrl: string;
  /** Task-events stream key. */
  streamKey: string;
  /** Where the single-instance reader kept its position. */
  legacyCursorKey: string;
  /** `REDIS_KEY_PREFIX`, namespacing every coordination key. */
  keyPrefix: string;
  /** This process's consumer name. */
  instanceId: string;
  /** Coordination database client (DB3). */
  coordination: Redis;
  /** Timing and limits. */
  settings: TaskListenerSettings;
}

/** One parsed event and the stream entry it came from. */
interface Item {
  entry: StreamEntry;
  event: NodeTaskCountsEvent;
}

/** A document's batch and the keys that coordinate it. */
interface DocBatch {
  docName: string;
  items: Item[];
}

/**
 * Coordination keys of one document.
 * @param keyPrefix - `REDIS_KEY_PREFIX`.
 * @param docName - The canvas document.
 * @returns Lease, hand-over and counts-version keys.
 */
function docKeys(keyPrefix: string, docName: string): { lease: string; handoff: string; versions: string } {
  return {
    lease: `${keyPrefix}:collab:task-doc-lease:${docName}`,
    handoff: `${keyPrefix}:collab:task-doc-handoff:${docName}`,
    versions: `${keyPrefix}:collab:task-counts-version:${docName}`,
  };
}

/**
 * Whether every client clock in the recorded vector is reached by the document.
 * @param doc - The local document.
 * @param recorded - The previous holder's state vector.
 * @returns True when the document holds everything the vector names.
 */
function covers(doc: Y.Doc, recorded: Map<number, number>): boolean {
  const local = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const [client, clock] of recorded) {
    if ((local.get(client) ?? 0) < clock) return false;
  }
  return true;
}

/**
 * Whether a failed lease acquisition failed only because another holder has
 * the lease. Redlock reports every failed acquisition as an `ExecutionError`
 * whose last attempt lists each client's reason.
 * @param err - What `using()` threw before the routine ran.
 * @returns True when every reason is "already locked".
 */
async function leaseHeldElsewhere(err: unknown): Promise<boolean> {
  if (!(err instanceof ExecutionError)) return false;
  const last = err.attempts[err.attempts.length - 1];
  if (!last) return false;
  const stats = await last;
  const reasons = [...stats.votesAgainst.values()];
  return reasons.length > 0 && reasons.every((reason) => reason instanceof ResourceLockedError);
}

/**
 * Parse a batch, answer the entries that will not be applied, and group the
 * rest by document in stream order.
 * @param entries - The batch.
 * @param outcomes - Filled with `done` for every skipped entry.
 * @returns The documents' batches.
 */
function groupByDoc(entries: StreamEntry[], outcomes: Map<string, EntryOutcome>): DocBatch[] {
  const byDoc = new Map<string, Item[]>();
  for (const entry of entries) {
    let event: NodeEvent;
    try {
      event = JSON.parse(entry.payload ?? "") as NodeEvent;
    } catch (err) {
      logger.error({ err, id: entry.id, raw: entry.payload }, "task_event_unparseable_skipped");
      outcomes.set(entry.id, "done");
      continue;
    }
    if (event?.type !== "node-task-counts") {
      logger.warn({ id: entry.id, type: (event as { type?: unknown } | null)?.type }, "task_event_unknown_type_skipped");
      outcomes.set(entry.id, "done");
      continue;
    }
    const parsed = parseDocName(event.docName);
    if (!parsed || parsed.kind !== "canvas") {
      logger.warn({ id: entry.id, docName: event.docName }, "task_event_unknown_doc_skipped");
      outcomes.set(entry.id, "done");
      continue;
    }
    const items = byDoc.get(event.docName) ?? [];
    items.push({ entry, event });
    byDoc.set(event.docName, items);
  }
  return [...byDoc].map(([docName, items]) => ({ docName, items }));
}

/**
 * Run `work` over `items`, at most `limit` at a time.
 * @param items - What to work on.
 * @param limit - Most at once.
 * @param work - The work.
 */
async function runLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Start the task listener.
 * @param deps - Server, stream, names, coordination client and settings.
 * @returns The running consumer.
 */
export function startTaskListener(deps: TaskListenerDeps): GroupConsumer {
  const { hocuspocus, coordination, settings, keyPrefix } = deps;
  // Redlock's scripts start with `SELECT <db>` and default to database 0, so
  // without the client's own number the leases land outside the coordination
  // database (`@sesamecare-oss/redlock` 1.4.0, `build/scripts.js`).
  const redlock = new Redlock([coordination], { retryCount: 0, db: coordination.options.db ?? 0 });

  /**
   * Wait until the local document holds what the previous holder wrote.
   * @param doc - The local document.
   * @param handoffKey - Where the previous holder left its state vector.
   * @returns True once covered; false when the wait ran out.
   */
  async function awaitHandOver(doc: Y.Doc, handoffKey: string): Promise<boolean> {
    const stored = await coordination.get(handoffKey);
    if (!stored) return true;
    const recorded = Y.decodeStateVector(Buffer.from(stored, "base64"));
    const deadline = Date.now() + settings.handoffWaitMs;
    while (!covers(doc, recorded)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, settings.handoffPollMs));
    }
    return true;
  }

  /**
   * Write one document's batch while holding its lease.
   * @param batch - The document and its events.
   * @param signal - Aborted when the lease could not be extended.
   * @param stopping - True once the listener is stopping.
   * @returns The outcome of every event.
   */
  async function writeBatch(
    batch: DocBatch,
    signal: AbortSignal,
    stopping: () => boolean,
  ): Promise<Map<string, EntryOutcome>> {
    const keys = docKeys(keyPrefix, batch.docName);
    const outcomes = new Map<string, EntryOutcome>();
    /**
     * Give every event of the batch the same outcome.
     * @param outcome - The outcome.
     * @returns The filled map.
     */
    const answerAll = (outcome: EntryOutcome): Map<string, EntryOutcome> => {
      for (const { entry } of batch.items) outcomes.set(entry.id, outcome);
      return outcomes;
    };

    let connection: Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;
    try {
      connection = await hocuspocus.openDirectConnection(batch.docName, {
        context: { user: { id: "system" }, source: "task-listener" },
      });
    } catch (err) {
      logger.error({ err, docName: batch.docName }, "task_doc_open_failed");
      return answerAll({ failed: err });
    }

    let disconnected = false;
    /** Close the direct connection once, which stores the document. */
    const disconnect = async (): Promise<void> => {
      if (disconnected) return;
      disconnected = true;
      try {
        await connection.disconnect();
      } catch (err) {
        logger.error({ err, docName: batch.docName }, "task_doc_disconnect_failed");
      }
    };
    try {
      const doc = connection.document!;
      if (!(await awaitHandOver(doc, keys.handoff))) {
        logger.warn({ docName: batch.docName }, "task_doc_handoff_not_reached");
        return answerAll("wait");
      }

      const versions = await coordination.hgetall(keys.versions);
      const moved = new Map<string, string>();
      await connection.transact((d) => {
        for (const { entry, event } of batch.items) {
          if (stopping()) {
            outcomes.set(entry.id, "held");
            continue;
          }
          if (signal.aborted) {
            outcomes.set(entry.id, "wait");
            continue;
          }
          try {
            const held = moved.get(event.nodeId) ?? versions[event.nodeId];
            const after = applyNodeTaskCounts(d, event, {
              version: entry.originId ?? entry.id,
              countsVersion: held,
            });
            if (after !== undefined && after !== held) moved.set(event.nodeId, after);
            outcomes.set(entry.id, "done");
          } catch (err) {
            logger.error({ err, id: entry.id, docName: batch.docName, nodeId: event.nodeId }, "task_event_apply_failed");
            outcomes.set(entry.id, { failed: err });
          }
        }
      });

      // The hand-over record names only what the store below has written.
      const vector = Y.encodeStateVector(doc);
      await disconnect();
      if (moved.size > 0) {
        await coordination.hset(keys.versions, Object.fromEntries(moved));
        await coordination.expire(keys.versions, COUNTS_VERSION_TTL_SECONDS);
      }
      await coordination.set(keys.handoff, Buffer.from(vector).toString("base64"), "PX", settings.docLeaseMs * 2);
      logger.info(
        { docName: batch.docName, events: batch.items.length, applied: [...outcomes.values()].filter((o) => o === "done").length },
        "task_doc_batch_written",
      );
    } catch (err) {
      // Whatever landed in the document is applied again on the retry, and the
      // versions make that a no-op.
      logger.warn({ err, docName: batch.docName }, "task_doc_coordination_failed");
      return answerAll(stopping() ? "held" : "wait");
    } finally {
      await disconnect();
    }
    return outcomes;
  }

  /**
   * Take a document's lease and write its batch, or say why not.
   * @param batch - The document and its events.
   * @param stopping - True once the listener is stopping.
   * @returns The outcome of every event.
   */
  async function handleDoc(batch: DocBatch, stopping: () => boolean): Promise<Map<string, EntryOutcome>> {
    const keys = docKeys(keyPrefix, batch.docName);
    let written: Map<string, EntryOutcome> | undefined;
    try {
      await redlock.using([keys.lease], settings.docLeaseMs, { retryCount: 0 }, async (signal) => {
        written = await writeBatch(batch, signal, stopping);
      });
      return written!;
    } catch (err) {
      if (written) {
        // The routine finished; only the release failed, and the lease runs out on its own.
        logger.warn({ err, docName: batch.docName }, "task_doc_lease_release_failed");
        return written;
      }
      if (!(await leaseHeldElsewhere(err))) {
        logger.warn({ err, docName: batch.docName }, "task_doc_lease_unavailable");
      }
      return new Map(batch.items.map(({ entry }) => [entry.id, stopping() ? "held" : "wait"]));
    }
  }

  return startGroupConsumer({
    streamUrl: deps.streamUrl,
    streamKey: deps.streamKey,
    group: TASK_EVENTS_GROUP,
    consumer: deps.instanceId,
    legacyCursorKey: deps.legacyCursorKey,
    failuresKey: `${keyPrefix}:collab:task-event-failures`,
    coordination,
    settings,
    process: async (entries, control) => {
      const outcomes = new Map<string, EntryOutcome>();
      const batches = groupByDoc(entries, outcomes);
      await runLimited(batches, settings.docConcurrency, async (batch) => {
        for (const [id, outcome] of await handleDoc(batch, control.stopping)) outcomes.set(id, outcome);
      });
      return outcomes;
    },
  });
}
