// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Task lifecycle events, from the cross-service stream into the canvas
 * documents (#186, inner#1497 §6.1).
 *
 * Data path:
 *   server / worker → Redis stream → consumer group (one round per document) →
 *   per-document lease → one direct connection per round → applyNodeTaskCounts
 *
 * Collab executes; it does not judge. Which task moved, what the counts now
 * are, whether a result rides along — the server decided all of it.
 *
 * Several collab instances read the stream as one consumer group, so each
 * event is held by one of them at a time; an event not acknowledged goes to
 * another once idle, so one can be handled twice. What keeps two of them from
 * writing the same document at once is the document lease in the coordination
 * database; what keeps the next holder from writing over a peer's update it
 * has not received yet is the hand-over record, the state vector the previous
 * holder stored; what keeps an older event from undoing a newer one is the
 * version each node carries.
 *
 * Doc layout: `project-{pid}/canvas-{spaceId}`, one canvas doc per Space. Any
 * other doc name is skipped.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { ExecutionError, Redlock, ResourceLockedError } from "@sesamecare-oss/redlock";
import type { NodeTaskCountsEvent } from "@breatic/shared";
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

/** Deletes the waiter mark only while it is still the given instance's. */
const RELEASE_WAITER_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

/** Sets or renews the waiter mark unless another instance holds it. */
const MARK_WAITER_SCRIPT =
  'local v = redis.call("get", KEYS[1]) if v == false or v == ARGV[1] then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2]) end return 0';

/** How long a node's counts version is kept after its last write. */
const COUNTS_VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Settings of the task listener: the consumer group's, plus the per-document ones. */
export interface TaskListenerSettings extends GroupConsumerSettings {
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

/** One document's events, in stream order. */
interface DocBatch {
  docName: string;
  items: Item[];
}

/**
 * Give every event of a batch the same outcome.
 * @param batch - The document and its events.
 * @param outcome - The outcome.
 * @returns The outcomes.
 */
function outcomeForAll(batch: DocBatch, outcome: EntryOutcome): Map<string, EntryOutcome> {
  return new Map(batch.items.map(({ entry }) => [entry.id, outcome]));
}

/**
 * Coordination keys of one document.
 * @param keyPrefix - `REDIS_KEY_PREFIX`.
 * @param docName - The canvas document.
 * @returns Lease, waiter, hand-over and counts-version keys.
 */
function docKeys(
  keyPrefix: string,
  docName: string,
): { lease: string; waiter: string; handoff: string; versions: string } {
  return {
    lease: `${keyPrefix}:collab:task-doc-lease:${docName}`,
    waiter: `${keyPrefix}:collab:task-doc-lease-waiter:${docName}`,
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
 * Read one entry as a task event for a canvas document.
 * @param entry - The stream entry.
 * @returns The event, or why it is skipped.
 */
function readItem(entry: StreamEntry): NodeTaskCountsEvent | { skip: string } {
  let event: unknown;
  try {
    event = JSON.parse(entry.payload ?? "");
  } catch {
    return { skip: "task_event_unparseable_skipped" };
  }
  if (typeof event !== "object" || event === null || (event as { type?: unknown }).type !== "node-task-counts") {
    return { skip: "task_event_unknown_type_skipped" };
  }
  const docName = (event as { docName?: unknown }).docName;
  const parsed = typeof docName === "string" ? parseDocName(docName) : null;
  if (!parsed || parsed.kind !== "canvas") return { skip: "task_event_unknown_doc_skipped" };
  return event as NodeTaskCountsEvent;
}

/**
 * The round key of an entry: its document, or the entry itself when it names
 * no canvas document, so it is skipped on its own.
 * @param entry - The stream entry.
 * @returns The key.
 */
function docKeyOf(entry: StreamEntry): string {
  const read = readItem(entry);
  return "skip" in read ? `skip:${entry.id}` : read.docName;
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
   * @param stopping - True once the listener is stopping; the wait ends then.
   * @returns True once covered; false when the wait ran out or stopping began.
   * @throws {Error} When Redis rejects the read; the batch answers wait and is retried without counting a failure.
   */
  async function awaitHandOver(doc: Y.Doc, handoffKey: string, stopping: () => boolean): Promise<boolean> {
    const stored = await coordination.get(handoffKey);
    if (!stored) return true;
    const recorded = Y.decodeStateVector(Buffer.from(stored, "base64"));
    const deadline = Date.now() + settings.handoffWaitMs;
    while (!covers(doc, recorded)) {
      if (stopping() || Date.now() >= deadline) return false;
      await delay(settings.handoffPollMs);
    }
    return true;
  }

  /**
   * Write one document's batch while holding its lease.
   * @param batch - The document and its events.
   * @param keys - The document's lease, hand-over and counts-version keys.
   * @param signal - Aborted when the lease could not be extended.
   * @param stopping - True once the listener is stopping.
   * @returns The outcome of every event.
   */
  async function writeBatch(
    batch: DocBatch,
    keys: ReturnType<typeof docKeys>,
    signal: AbortSignal,
    stopping: () => boolean,
  ): Promise<Map<string, EntryOutcome>> {
    const outcomes = new Map<string, EntryOutcome>();

    let connection: Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;
    try {
      connection = await hocuspocus.openDirectConnection(batch.docName, {
        context: { user: { id: "system" }, source: "task-listener" },
      });
    } catch (err) {
      logger.error({ err, docName: batch.docName }, "task_doc_open_failed");
      return outcomeForAll(batch, { failed: err });
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
      if (!(await awaitHandOver(doc, keys.handoff, stopping))) {
        if (!stopping()) logger.warn({ docName: batch.docName }, "task_doc_handoff_not_reached");
        return outcomeForAll(batch, "wait");
      }
      const versions = await coordination.hgetall(keys.versions);
      // Nothing awaits between here and the transaction, which runs synchronously.
      if (stopping() || signal.aborted) return outcomeForAll(batch, "wait");
      const moved = new Map<string, string>();
      await connection.transact((d) => {
        for (const { entry, event } of batch.items) {
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

      // The hand-over record is this holder's in-memory state. With other
      // connections on this instance the store below writes nothing yet; the
      // next holder waits until the Redis extension's sync, or a load from the
      // database once stored, covers it.
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
      return outcomeForAll(batch, "wait");
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
    // Another instance is waiting for this lease: let it have the next turn.
    if (await peerWaiting(keys.waiter)) return outcomeForAll(batch, "wait");
    let written: Map<string, EntryOutcome> | undefined;
    try {
      await redlock.using([keys.lease], settings.docLeaseMs, { retryCount: 0 }, async (signal) => {
        await releaseWaiting(keys.waiter);
        written = await writeBatch(batch, keys, signal, stopping);
      });
      return written!;
    } catch (err) {
      if (written) {
        // The routine finished; only the release failed, and the lease runs out on its own.
        logger.warn({ err, docName: batch.docName }, "task_doc_lease_release_failed");
        return written;
      }
      if (await leaseHeldElsewhere(err)) await markWaiting(keys.waiter);
      else logger.warn({ err, docName: batch.docName }, "task_doc_lease_unavailable");
      return outcomeForAll(batch, "wait");
    }
  }

  /**
   * Whether another instance has marked itself as waiting for a document lease.
   * @param waiterKey - The document's waiter mark.
   * @returns True when the mark names another instance; false when it is absent, this instance's, or unreadable.
   */
  async function peerWaiting(waiterKey: string): Promise<boolean> {
    try {
      const waiter = await coordination.get(waiterKey);
      return waiter !== null && waiter !== deps.instanceId;
    } catch (err) {
      logger.warn({ err, waiterKey }, "task_doc_waiter_unreadable");
      return false;
    }
  }

  /**
   * Mark this instance as waiting for a document lease, unless another
   * instance already waits; renew the mark when it is this instance's.
   * @param waiterKey - The document's waiter mark.
   */
  async function markWaiting(waiterKey: string): Promise<void> {
    try {
      await coordination.eval(MARK_WAITER_SCRIPT, 1, waiterKey, deps.instanceId, settings.leaseRetryMs * 2);
    } catch (err) {
      logger.warn({ err, waiterKey }, "task_doc_waiter_unmarked");
    }
  }

  /**
   * Remove this instance's waiter mark once it holds the lease.
   * @param waiterKey - The document's waiter mark.
   */
  async function releaseWaiting(waiterKey: string): Promise<void> {
    try {
      await coordination.eval(RELEASE_WAITER_SCRIPT, 1, waiterKey, deps.instanceId);
    } catch (err) {
      logger.warn({ err, waiterKey }, "task_doc_waiter_unreleased");
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
    keyOf: docKeyOf,
    process: async (entries, control) => {
      const outcomes = new Map<string, EntryOutcome>();
      const items: Item[] = [];
      for (const entry of entries) {
        const read = readItem(entry);
        if ("skip" in read) {
          logger.warn({ id: entry.id, raw: entry.payload }, read.skip);
          outcomes.set(entry.id, "done");
        } else {
          items.push({ entry, event: read });
        }
      }
      if (items.length === 0 || control.stopping()) return outcomes;
      for (const [id, outcome] of await handleDoc({ docName: items[0]!.event.docName, items }, control.stopping)) {
        outcomes.set(id, outcome);
      }
      return outcomes;
    },
  });
}
