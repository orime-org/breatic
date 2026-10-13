// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Consume a Redis stream as one member of a consumer group (#1497 §6.1).
 *
 * Every collab instance is one consumer in the group, so each entry goes to
 * exactly one instance. What this module owns is the part every stream needs
 * the same way: creating the group, reading, acknowledging, taking over the
 * entries of a consumer that stopped answering, retrying a failing entry with
 * a growing delay until it goes to the dead-letter stream, and handing the
 * unfinished entries over on a graceful stop. What an entry means is the
 * caller's: it names each entry's key, gets one key's entries at a time and
 * answers each entry with an outcome.
 *
 * Entries of one key run one round at a time, in stream order; different keys
 * run side by side up to `keyConcurrency`. The consumer takes only what it can
 * start now and keeps reading while rounds run: a read asks for at most as
 * many entries as there are free key slots, so even with every entry on a new
 * key nothing waits here behind a busy slot while a peer sits idle (Celery
 * prefetch, RabbitMQ consumer prefetch, Pub/Sub flow control). Entries for a
 * key whose round is running join that key's next round.
 *
 * Two connections: the blocking read holds one for up to `blockMs`, and any
 * command sent on it would queue behind the block.
 */

import { setTimeout as delay } from "node:timers/promises";
import { createLogger, createRedisClient, STREAM_MAXLEN, type Redis } from "@breatic/core";

const logger = createLogger("stream-group-consumer");

/** How long a failure count is kept after its last failure. */
const FAILURES_TTL_SECONDS = 24 * 60 * 60;

/** Wait before retrying group creation or the read loop after an error. */
const LOOP_ERROR_DELAY_MS = 1000;

/** One stream entry as the caller sees it. */
export interface StreamEntry {
  /** The id Redis gave this entry. */
  id: string;
  /** The id of the original entry, on an entry replayed from the dead-letter stream. */
  originId: string | undefined;
  /** The `payload` field, absent on an entry written without one. */
  payload: string | undefined;
}

/**
 * What became of one entry.
 * - `done`: handled (or deliberately skipped); acknowledged.
 * - `wait`: not attempted this time (lease busy, peer write not here yet, or stopping); retried soon, not counted as a failure; while stopping, left pending for the hand-over.
 * - `{ failed }`: handling threw; counted, retried with backoff, dead-lettered at the limit.
 */
export type EntryOutcome = "done" | "wait" | { failed: unknown };

/** Timing and limits, all from `config/collab.yaml` in production. */
export interface GroupConsumerSettings {
  /** Most entries this consumer holds at once, running and queued. */
  batchCount: number;
  /** Most keys with a round running at once. */
  keyConcurrency: number;
  /** Longest a read blocks when nothing is waiting. */
  blockMs: number;
  /** Retry delay of a `wait` outcome. */
  leaseRetryMs: number;
  /** Gap between take-over sweeps. */
  claimIntervalMs: number;
  /** Idle time after which another consumer's entry is taken over. */
  claimIdleMs: number;
  /** Retry delay after the first failure of an entry. */
  retryMinMs: number;
  /** Longest retry delay. */
  retryMaxMs: number;
  /** Failures at which an entry goes to the dead-letter stream. */
  maxFailures: number;
  /** Longest a graceful stop waits for the running rounds. */
  stopDeadlineMs: number;
  /** Idle time after which a consumer with nothing pending is removed from the group. */
  forgetIdleConsumerMs: number;
}

/** Everything one consumer needs. */
export interface GroupConsumerOptions {
  /** Redis URL of the stream database. */
  streamUrl: string;
  /** Stream key. */
  streamKey: string;
  /** Consumer group name. */
  group: string;
  /** This consumer's name, unique per process. */
  consumer: string;
  /** Where the single-instance reader kept its position; the group starts there. */
  legacyCursorKey: string;
  /** Hash in the coordination database counting failures per entry id. */
  failuresKey: string;
  /** Coordination database client (DB3). */
  coordination: Redis;
  /** Timing and limits. */
  settings: GroupConsumerSettings;
  /** The key an entry's round is grouped under. */
  keyOf: (entry: StreamEntry) => string;
  /** Handle one key's entries, in stream order; an entry left unanswered counts as `wait`. */
  process: (
    entries: StreamEntry[],
    control: { stopping: () => boolean },
  ) => Promise<Map<string, EntryOutcome>>;
}

/** A running consumer. */
export interface GroupConsumer {
  /**
   * Stop reading and starting rounds, and hand over every entry not in a
   * running round. Resolves within `stopDeadlineMs`; a round still running
   * then settles afterwards on a connection kept open until it does.
   */
  stop: () => Promise<void>;
}

/** An entry to retry, and when. */
interface Waiting {
  entry: StreamEntry;
  notBefore: number;
}

/**
 * How long to wait before retrying an entry that has failed `failures` times:
 * the minimum after the first failure, doubling after each next one, never
 * past the maximum.
 * @param failures - Failures so far, at least 1.
 * @param minMs - Wait after the first failure.
 * @param maxMs - Longest wait.
 * @returns The wait in milliseconds.
 */
export function retryDelayMs(failures: number, minMs: number, maxMs: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(minMs * 2 ** exponent, maxMs);
}

/**
 * Build an entry from Redis's flat field list.
 * @param id - Entry id.
 * @param fields - `[name, value, name, value, …]`.
 * @returns The entry.
 */
function toEntry(id: string, fields: string[] | null): StreamEntry {
  const values = pairs(fields ?? []);
  return { id, originId: values.get("originId"), payload: values.get("payload") };
}

/**
 * Read a flat `[name, value, …]` reply into a map.
 * @param row - The reply.
 * @returns Field name to value.
 */
function pairs<T>(row: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (let i = 0; i + 1 < row.length; i += 2) out.set(String(row[i]), row[i + 1]!);
  return out;
}

/**
 * Text for an error, for the dead-letter record and the log.
 * @param err - Whatever was thrown.
 * @returns Its message.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start consuming.
 * @param opts - Stream, group, names, limits and the batch handler.
 * @returns The running consumer.
 */
export function startGroupConsumer(opts: GroupConsumerOptions): GroupConsumer {
  const { streamKey, group, consumer, settings, coordination, failuresKey } = opts;
  const deadKey = `${streamKey}:dead`;
  // The blocking read must not time out on the client side.
  const reader = createRedisClient(opts.streamUrl, {
    name: `collab-group-read:${group}`,
    commandTimeout: undefined,
  });
  const commands = createRedisClient(opts.streamUrl, { name: `collab-group-cmd:${group}` });

  let stopping = false;
  let stopped: Promise<void> | undefined;
  let waiting: Waiting[] = [];
  const claimed: StreamEntry[] = [];
  /** Entries waiting for their key's next round, by key, in stream order. */
  const queued = new Map<string, StreamEntry[]>();
  /** Ids of the queued entries. */
  const queuedIds = new Set<string>();
  /** The running round of each key. */
  const running = new Map<string, Promise<void>>();
  /** Ids of the entries in running rounds. */
  const inHand = new Set<string>();
  let nextSweepAt = 0;
  /** Ends the loop's idle wait early. */
  let wake: (() => void) | undefined;

  /**
   * Create the group where the single-instance reader stopped, or at the start.
   * @throws {Error} On any Redis error other than "the group already exists".
   */
  async function ensureGroup(): Promise<void> {
    const start = (await commands.get(opts.legacyCursorKey)) ?? "0";
    try {
      await commands.xgroup("CREATE", streamKey, group, start, "MKSTREAM");
      logger.info({ streamKey, group, start }, "stream_group_created");
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
    }
  }

  /**
   * Remove consumers that have been idle past the limit with nothing pending.
   * @throws {Error} When a Redis command fails; the read loop logs it and retries.
   */
  async function forgetIdleConsumers(): Promise<void> {
    const rows = (await commands.xinfo("CONSUMERS", streamKey, group)) as unknown[][];
    for (const row of rows) {
      const info = pairs(row);
      const name = String(info.get("name"));
      if (name === consumer) continue;
      if (Number(info.get("pending")) !== 0) continue;
      if (Number(info.get("idle")) <= settings.forgetIdleConsumerMs) continue;
      await commands.xgroup("DELCONSUMER", streamKey, group, name);
      logger.info({ streamKey, group, consumer: name }, "stream_group_consumer_forgotten");
    }
  }

  /**
   * Take over entries idle past `claimIdleMs`, then forget dead consumers.
   * @throws {Error} When a Redis command fails; the read loop logs it and retries.
   */
  async function sweep(): Promise<void> {
    let cursor = "0-0";
    do {
      const [next, entries, trimmed] = (await commands.xautoclaim(
        streamKey,
        group,
        consumer,
        settings.claimIdleMs,
        cursor,
        "COUNT",
        settings.batchCount,
      )) as [string, Array<[string, string[] | null]>, string[] | undefined];
      for (const [id, fields] of entries) claimed.push(toEntry(id, fields));
      if (trimmed && trimmed.length > 0) {
        logger.warn({ streamKey, group, ids: trimmed }, "stream_entries_trimmed_before_handled");
      }
      cursor = next;
    } while (cursor !== "0-0" && !stopping);
    await forgetIdleConsumers();
  }

  /**
   * Reset the idle time of every entry this consumer holds — running, queued
   * and waiting to retry — so no peer takes one over while this consumer is
   * alive. A consumer that stops answering stops renewing, and its entries go
   * idle past `claimIdleMs`. Once stopping, no chunk is sent; a chunk sent
   * before shares the command connection with the hand-over and runs first.
   * @throws {Error} When a Redis command fails; the timer logs it and renews next time.
   */
  async function renewHeld(): Promise<void> {
    const ids = [...new Set([...inHand, ...queuedIds, ...waiting.map((w) => w.entry.id)])];
    for (let i = 0; i < ids.length && !stopping; i += settings.batchCount) {
      const chunk = ids.slice(i, i + settings.batchCount);
      await commands.xclaim(streamKey, group, consumer, 0, ...chunk, "JUSTID");
    }
  }

  /**
   * Read new entries.
   * @param count - Most entries to take.
   * @param blockMs - Longest to block.
   * @returns The entries read.
   * @throws {Error} When a Redis command fails; the read loop logs it and retries.
   */
  async function readNew(count: number, blockMs: number): Promise<StreamEntry[]> {
    const reply = (await reader.xreadgroup(
      "GROUP",
      group,
      consumer,
      "COUNT",
      count,
      "BLOCK",
      blockMs,
      "STREAMS",
      streamKey,
      ">",
    )) as Array<[string, Array<[string, string[] | null]>]> | null;
    if (!reply) return [];
    return reply.flatMap(([, entries]) => entries.map(([id, fields]) => toEntry(id, fields)));
  }

  /**
   * Queue an entry for a retry.
   * @param entry - The entry.
   * @param delayMs - How long from now.
   */
  function retryLater(entry: StreamEntry, delayMs: number): void {
    if (stopping) return;
    waiting.push({ entry, notBefore: Date.now() + delayMs });
  }

  /**
   * Count a failure and either schedule the retry or dead-letter the entry.
   * @param entry - The entry that failed.
   * @param err - What it threw.
   * @returns True when the entry went to the dead-letter stream.
   * @throws {Error} When a Redis command fails; settle() logs it and retries the entry.
   */
  async function recordFailure(entry: StreamEntry, err: unknown): Promise<boolean> {
    const failures = await coordination.hincrby(failuresKey, entry.id, 1);
    await coordination.expire(failuresKey, FAILURES_TTL_SECONDS);
    if (failures < settings.maxFailures) {
      const delayMs = retryDelayMs(failures, settings.retryMinMs, settings.retryMaxMs);
      logger.warn({ err, streamKey, id: entry.id, failures, delayMs }, "stream_entry_failed_will_retry");
      retryLater(entry, delayMs);
      return false;
    }
    await commands.xadd(
      deadKey,
      "MAXLEN",
      "~",
      STREAM_MAXLEN,
      "*",
      "payload",
      entry.payload ?? "",
      "originId",
      entry.originId ?? entry.id,
      "error",
      describeError(err),
    );
    logger.error(
      { err, streamKey, deadKey, id: entry.id, originId: entry.originId ?? entry.id, failures, payload: entry.payload },
      "stream_entry_dead_lettered",
    );
    return true;
  }

  /**
   * Act on the outcome of every entry of a round.
   * @param entries - The round's entries.
   * @param outcomes - What the handler answered.
   * @throws {Error} When acknowledging fails; the round logs it.
   */
  async function settle(entries: StreamEntry[], outcomes: Map<string, EntryOutcome>): Promise<void> {
    const ack: string[] = [];
    for (const entry of entries) {
      const outcome = outcomes.get(entry.id) ?? "wait";
      if (outcome === "done") {
        ack.push(entry.id);
      } else if (outcome === "wait") {
        retryLater(entry, settings.leaseRetryMs);
      } else {
        try {
          if (await recordFailure(entry, outcome.failed)) ack.push(entry.id);
        } catch (err) {
          logger.error({ err, streamKey, id: entry.id }, "stream_entry_failure_not_recorded");
          retryLater(entry, settings.leaseRetryMs);
        }
      }
    }
    if (ack.length === 0) return;
    await commands.xack(streamKey, group, ...ack);
    await coordination.hdel(failuresKey, ...ack);
  }

  /** Let the loop's idle wait end now. */
  function wakeUp(): void {
    const w = wake;
    wake = undefined;
    w?.();
  }

  /**
   * Hand one key's entries to the caller and settle every entry; then start
   * whatever the freed slot allows.
   * @param key - The key.
   * @param entries - Its entries, in stream order.
   */
  function startRound(key: string, entries: StreamEntry[]): void {
    for (const e of entries) inHand.add(e.id);
    const round = (async (): Promise<void> => {
      let outcomes: Map<string, EntryOutcome>;
      try {
        outcomes = await opts.process(entries, { stopping: () => stopping });
      } catch (err) {
        outcomes = new Map(entries.map((e) => [e.id, { failed: err }]));
      }
      try {
        await settle(entries, outcomes);
      } catch (err) {
        // Unacknowledged entries stay pending and are taken over once idle.
        logger.error({ err, streamKey, group, ids: entries.map((e) => e.id) }, "stream_round_settle_failed");
      }
    })().finally(() => {
      for (const e of entries) inHand.delete(e.id);
      running.delete(key);
      startRounds();
      wakeUp();
    });
    running.set(key, round);
  }

  /** Start a round for every queued key without one, while slots are free. */
  function startRounds(): void {
    if (stopping) return;
    for (const [key, entries] of queued) {
      if (running.size >= settings.keyConcurrency) return;
      if (running.has(key)) continue;
      queued.delete(key);
      for (const e of entries) queuedIds.delete(e.id);
      startRound(key, entries);
    }
  }

  /**
   * Queue entries under their keys, skipping any already held, and drop the
   * retries of entries taken again.
   * @param entries - Entries just read, claimed or due.
   */
  function enqueue(entries: StreamEntry[]): void {
    if (entries.length === 0) return;
    const ids = new Set(entries.map((e) => e.id));
    waiting = waiting.filter((w) => !ids.has(w.entry.id));
    for (const entry of entries) {
      if (inHand.has(entry.id) || queuedIds.has(entry.id)) continue;
      const key = opts.keyOf(entry);
      const list = queued.get(key) ?? [];
      list.push(entry);
      queued.set(key, list);
      queuedIds.add(entry.id);
    }
  }

  /**
   * Take the retries that are due.
   * @returns The due entries.
   */
  function takeDue(): StreamEntry[] {
    const now = Date.now();
    const due = waiting.filter((w) => w.notBefore <= now).map((w) => w.entry);
    waiting = waiting.filter((w) => w.notBefore > now);
    return due;
  }

  /**
   * How many entries a read may take now: one per free key slot, within the
   * entries this consumer may hold.
   * @returns The count; zero when nothing may be read.
   */
  function readCapacity(): number {
    let startingKeys = 0;
    for (const key of queued.keys()) if (!running.has(key)) startingKeys += 1;
    const freeKeys = settings.keyConcurrency - running.size - startingKeys;
    const room = settings.batchCount - inHand.size - queuedIds.size;
    return Math.max(0, Math.min(freeKeys, room));
  }

  /**
   * How long the next read or idle wait may last: until the next retry or sweep is due.
   * @returns Milliseconds, at least 1.
   */
  function blockFor(): number {
    const now = Date.now();
    let until = Math.min(now + settings.blockMs, nextSweepAt);
    for (const w of waiting) until = Math.min(until, w.notBefore);
    return Math.max(1, until - now);
  }

  /**
   * Wait until a round ends, the consumer stops, or `ms` passes.
   * @param ms - Longest wait.
   * @returns Resolves when any of them happens.
   */
  function idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** The read loop. */
  async function run(): Promise<void> {
    while (!stopping) {
      try {
        await ensureGroup();
        break;
      } catch (err) {
        logger.error({ err, streamKey, group }, "stream_group_create_failed");
        await delay(LOOP_ERROR_DELAY_MS);
      }
    }
    while (!stopping) {
      try {
        if (Date.now() >= nextSweepAt) {
          await sweep();
          nextSweepAt = Date.now() + settings.claimIntervalMs;
        }
        enqueue(claimed.splice(0));
        enqueue(takeDue());
        startRounds();
        const count = readCapacity();
        if (count > 0) {
          // Entries read while stopping stay pending; handOver() marks them idle.
          enqueue(await readNew(count, blockFor()));
          startRounds();
        } else {
          await idle(blockFor());
        }
      } catch (err) {
        // A stop disconnects the blocked read; that rejection is expected.
        if (stopping) break;
        logger.error({ err, streamKey, group }, "stream_group_loop_failed");
        await delay(LOOP_ERROR_DELAY_MS);
      }
    }
  }

  /**
   * Mark every entry this consumer still holds, except those in running
   * rounds, as idle past the take-over limit, so the next sweep of any
   * consumer takes it. A running round's entries are acknowledged when it
   * settles, or taken over like a dead consumer's once the process is gone.
   * @throws {Error} When a Redis command fails; the stop logs it.
   */
  async function handOver(): Promise<void> {
    let start = "-";
    for (;;) {
      const rows = (await commands.xpending(
        streamKey,
        group,
        start,
        "+",
        settings.batchCount,
        consumer,
      )) as Array<[string, string, number, number]>;
      if (rows.length === 0) return;
      const ids = rows.map((r) => r[0]).filter((id) => !inHand.has(id));
      if (ids.length > 0) {
        await commands.xclaim(streamKey, group, consumer, 0, ...ids, "IDLE", settings.claimIdleMs, "JUSTID");
        logger.info({ streamKey, group, count: ids.length }, "stream_entries_handed_over");
      }
      if (rows.length < settings.batchCount) return;
      start = `(${rows[rows.length - 1]![0]}`;
    }
  }

  const loop = run();
  /**
   * The loop has ended and every round it started has settled.
   * @returns Resolves then.
   */
  const drained = async (): Promise<void> => {
    await loop;
    await Promise.all(running.values());
  };
  // Renewed three times within the take-over idle time, as BullMQ renews a
  // job lock at half its duration.
  const renewTimer = setInterval(() => {
    renewHeld().catch((err: unknown) => logger.warn({ err, streamKey, group }, "stream_entries_renew_failed"));
  }, Math.max(1, Math.floor(settings.claimIdleMs / 3)));

  return {
    stop: (): Promise<void> => {
      if (stopped) return stopped;
      stopping = true;
      clearInterval(renewTimer);
      // Ends a read blocked on the server; an entry Redis delivered just
      // before is in the pending list and is handed over below.
      reader.disconnect();
      wakeUp();
      stopped = (async (): Promise<void> => {
        await Promise.race([drained(), delay(settings.stopDeadlineMs)]);
        waiting = [];
        queued.clear();
        queuedIds.clear();
        try {
          await handOver();
        } catch (err) {
          logger.error({ err, streamKey, group }, "stream_hand_over_failed");
        }
        // Open until the running rounds settle, so they can still be acknowledged.
        void drained().finally(() => commands.quit().catch(() => commands.disconnect()));
      })();
      return stopped;
    },
  };
}
