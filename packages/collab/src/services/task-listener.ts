// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

import type { Hocuspocus } from "@hocuspocus/server";
import type { NodeTaskCountsEvent } from "@breatic/shared";
import { parseDocName } from "@breatic/shared";
import { createLogger, type Redis } from "@breatic/core";
import { applyNodeTaskCounts } from "@collab/services/node-task-counts.js";
import { createDocLease, type DocLeaseSettings } from "@collab/services/doc-lease.js";
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
export interface TaskListenerSettings extends GroupConsumerSettings, DocLeaseSettings {}

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
 * Key of the counts version each node of a document carries.
 * @param keyPrefix - `REDIS_KEY_PREFIX`.
 * @param docName - The canvas document.
 * @returns The hash key.
 */
function versionsKey(keyPrefix: string, docName: string): string {
  return `${keyPrefix}:collab:task-counts-version:${docName}`;
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
  const lease = createDocLease({
    hocuspocus,
    coordination,
    keyPrefix,
    instanceId: deps.instanceId,
    settings,
    source: "task-listener",
    logTag: "task",
  });

  /**
   * Write one document's batch under its lease.
   * @param batch - The document and its events.
   * @param stopping - True once the listener is stopping.
   * @returns The outcome of every event.
   */
  async function handleDoc(batch: DocBatch, stopping: () => boolean): Promise<Map<string, EntryOutcome>> {
    const key = versionsKey(keyPrefix, batch.docName);
    const written = await lease.write(batch.docName, stopping, async (connection, signal) => {
      const versions = await coordination.hgetall(key);
      // Nothing awaits between here and the transaction, which runs synchronously.
      if (stopping() || signal.aborted) return "wait";
      const outcomes = new Map<string, EntryOutcome>();
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
      return {
        value: outcomes,
        afterStore: async () => {
          if (moved.size === 0) return;
          await coordination.hset(key, Object.fromEntries(moved));
          await coordination.expire(key, COUNTS_VERSION_TTL_SECONDS);
        },
      };
    });
    if (written === "wait") return outcomeForAll(batch, "wait");
    if ("failed" in written) return outcomeForAll(batch, written);
    const outcomes = written.value;
    logger.info(
      { docName: batch.docName, events: batch.items.length, applied: [...outcomes.values()].filter((o) => o === "done").length },
      "task_doc_batch_written",
    );
    return outcomes;
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
