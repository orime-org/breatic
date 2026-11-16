// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writing a document from a stream consumer while no other collab instance
 * writes it (inner#1497 §6.1, breatic#1488 §6).
 *
 * Several collab instances read each stream as one consumer group, so two of
 * them can hold writes for the same document at once. What keeps them from
 * writing it at the same time is the document lease in the coordination
 * database; what keeps the next holder from writing over a peer's update it
 * has not received yet is the hand-over record, the state vector the previous
 * holder stored. A waiter mark lets an instance that lost the lease have the
 * next turn. Every consumer that writes a document takes the same lease under
 * the same keys, so task events and external-agent commands for one document
 * never write it at once.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { ExecutionError, Redlock, ResourceLockedError } from "@sesamecare-oss/redlock";
import { createLogger, type Redis } from "@breatic/core";

const logger = createLogger("doc-lease");

/** Deletes the waiter mark only while it is still the given instance's. */
const RELEASE_WAITER_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

/** Sets or renews the waiter mark unless another instance holds it. */
const MARK_WAITER_SCRIPT =
  'local v = redis.call("get", KEYS[1]) if v == false or v == ARGV[1] then return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2]) end return 0';

/** Timing of the lease and the hand-over. */
export interface DocLeaseSettings {
  /** Document lease length. */
  docLeaseMs: number;
  /** Hold on a document after a wait; a waiter mark lives twice this. */
  leaseRetryMs: number;
  /** Gap between checks that the local document holds the previous holder's writes. */
  handoffPollMs: number;
  /** Longest wait for those writes before the write is retried. */
  handoffWaitMs: number;
}

/** What the lease needs. */
export interface DocLeaseDeps {
  /** The running Hocuspocus server. */
  hocuspocus: Hocuspocus;
  /** Coordination database client (DB3). */
  coordination: Redis;
  /** `REDIS_KEY_PREFIX`, namespacing every coordination key. */
  keyPrefix: string;
  /** This process's consumer name. */
  instanceId: string;
  /** Timing. */
  settings: DocLeaseSettings;
  /** Names the writer in the direct connection's context. */
  source: string;
  /** Leads every log line's name, e.g. `task` for `task_doc_open_failed`. */
  logTag: string;
}

/** The direct connection a leased write runs on. */
export type DocConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

/** What a leased write hands back. */
export interface LeasedWrite<T> {
  /** The write's result. */
  value: T;
  /** Runs once the document is stored, before the hand-over record is written. */
  afterStore?: () => Promise<void>;
}

/**
 * What became of a leased write: its value; `wait` when it was not attempted
 * (lease busy, peer waiting, hand-over not reached, stopping, coordination
 * failure), to be retried; `failed` when the document could not be opened.
 */
export type LeasedOutcome<T> = { value: T } | "wait" | { failed: unknown };

/** Writes documents under their lease. */
export interface DocLease {
  /**
   * Take a document's lease, open it once the previous holder's writes are
   * here, run the write, store the document and leave the hand-over record.
   * @param docName - The document.
   * @param stopping - True once the consumer is stopping.
   * @param write - The write; answering `wait` stores nothing and records no hand-over.
   * @returns What became of it.
   */
  write<T>(
    docName: string,
    stopping: () => boolean,
    write: (connection: DocConnection, signal: AbortSignal) => Promise<LeasedWrite<T> | "wait">,
  ): Promise<LeasedOutcome<T>>;
}

/**
 * Coordination keys of one document.
 * @param keyPrefix - `REDIS_KEY_PREFIX`.
 * @param docName - The document.
 * @returns Lease, waiter and hand-over keys.
 */
export function docLeaseKeys(keyPrefix: string, docName: string): { lease: string; waiter: string; handoff: string } {
  return {
    lease: `${keyPrefix}:collab:task-doc-lease:${docName}`,
    waiter: `${keyPrefix}:collab:task-doc-lease-waiter:${docName}`,
    handoff: `${keyPrefix}:collab:task-doc-handoff:${docName}`,
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
 * Build the document lease of one consumer.
 * @param deps - Server, coordination client, names and timing.
 * @returns The lease.
 */
export function createDocLease(deps: DocLeaseDeps): DocLease {
  const { hocuspocus, coordination, settings, keyPrefix, logTag } = deps;
  // Redlock's scripts start with `SELECT <db>` and default to database 0, so
  // without the client's own number the leases land outside the coordination
  // database (`@sesamecare-oss/redlock` 1.4.0, `build/scripts.js`).
  const redlock = new Redlock([coordination], { retryCount: 0, db: coordination.options.db ?? 0 });

  /**
   * Wait until the local document holds what the previous holder wrote.
   * @param doc - The local document.
   * @param handoffKey - Where the previous holder left its state vector.
   * @param stopping - True once the consumer is stopping; the wait ends then.
   * @returns True once covered; false when the wait ran out or stopping began.
   * @throws {Error} When Redis rejects the read; the write answers wait and is retried without counting a failure.
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
   * Open the document and run one write while holding its lease.
   * @param docName - The document.
   * @param keys - Its coordination keys.
   * @param signal - Aborted when the lease could not be extended.
   * @param stopping - True once the consumer is stopping.
   * @param write - The write.
   * @returns What became of it.
   */
  async function writeLeased<T>(
    docName: string,
    keys: ReturnType<typeof docLeaseKeys>,
    signal: AbortSignal,
    stopping: () => boolean,
    write: (connection: DocConnection, signal: AbortSignal) => Promise<LeasedWrite<T> | "wait">,
  ): Promise<LeasedOutcome<T>> {
    let connection: DocConnection;
    try {
      connection = await hocuspocus.openDirectConnection(docName, {
        context: { user: { id: "system" }, source: deps.source },
      });
    } catch (err) {
      logger.error({ err, docName }, `${logTag}_doc_open_failed`);
      return { failed: err };
    }

    let disconnected = false;
    /** Close the direct connection once, which stores the document. */
    const disconnect = async (): Promise<void> => {
      if (disconnected) return;
      disconnected = true;
      try {
        await connection.disconnect();
      } catch (err) {
        logger.error({ err, docName }, `${logTag}_doc_disconnect_failed`);
      }
    };
    try {
      const doc = connection.document!;
      if (!(await awaitHandOver(doc, keys.handoff, stopping))) {
        if (!stopping()) logger.warn({ docName }, `${logTag}_doc_handoff_not_reached`);
        return "wait";
      }
      if (stopping() || signal.aborted) return "wait";
      const written = await write(connection, signal);
      if (written === "wait") return "wait";

      // The hand-over record is this holder's in-memory state. With other
      // connections on this instance the store below writes nothing yet; the
      // next holder waits until the Redis extension's sync, or a load from the
      // database once stored, covers it.
      const vector = Y.encodeStateVector(doc);
      await disconnect();
      await written.afterStore?.();
      await coordination.set(keys.handoff, Buffer.from(vector).toString("base64"), "PX", settings.docLeaseMs * 2);
      return { value: written.value };
    } catch (err) {
      // Whatever landed in the document is applied again on the retry, and
      // each writer makes that a no-op.
      logger.warn({ err, docName }, `${logTag}_doc_coordination_failed`);
      return "wait";
    } finally {
      await disconnect();
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
      logger.warn({ err, waiterKey }, `${logTag}_doc_waiter_unreadable`);
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
      logger.warn({ err, waiterKey }, `${logTag}_doc_waiter_unmarked`);
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
      logger.warn({ err, waiterKey }, `${logTag}_doc_waiter_unreleased`);
    }
  }

  /**
   * Take a document's lease and run one write, or say why not.
   * @param docName - The document.
   * @param stopping - True once the consumer is stopping.
   * @param write - The write.
   * @returns What became of it.
   */
  async function leasedWrite<T>(
    docName: string,
    stopping: () => boolean,
    write: (connection: DocConnection, signal: AbortSignal) => Promise<LeasedWrite<T> | "wait">,
  ): Promise<LeasedOutcome<T>> {
    const keys = docLeaseKeys(keyPrefix, docName);
    // Another instance is waiting for this lease: let it have the next turn.
    if (await peerWaiting(keys.waiter)) return "wait";
    let outcome: LeasedOutcome<T> | undefined;
    try {
      await redlock.using([keys.lease], settings.docLeaseMs, { retryCount: 0 }, async (signal) => {
        await releaseWaiting(keys.waiter);
        outcome = await writeLeased(docName, keys, signal, stopping, write);
      });
      return outcome!;
    } catch (err) {
      if (outcome) {
        // The routine finished; only the release failed, and the lease runs out on its own.
        logger.warn({ err, docName }, `${logTag}_doc_lease_release_failed`);
        return outcome;
      }
      if (await leaseHeldElsewhere(err)) await markWaiting(keys.waiter);
      else logger.warn({ err, docName }, `${logTag}_doc_lease_unavailable`);
      return "wait";
    }
  }

  return { write: leasedWrite };
}
