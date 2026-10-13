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
 * caller's: it gets a batch and answers each entry with an outcome.
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
 * - `wait`: not attempted this time (lease busy, peer write not here yet); retried soon, not counted as a failure.
 * - `held`: not attempted because the consumer is stopping; left pending for the hand-over.
 * - `{ failed }`: handling threw; counted, retried with backoff, dead-lettered at the limit.
 */
export type EntryOutcome = "done" | "wait" | "held" | { failed: unknown };

/** Timing and limits, all from `config/collab.yaml` in production. */
export interface GroupConsumerSettings {
  /** Most entries one read returns. */
  batchCount: number;
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
  /** Longest a graceful stop waits for the batch in hand. */
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
  /** Handle a batch; answer every entry. */
  process: (
    entries: StreamEntry[],
    control: { stopping: () => boolean },
  ) => Promise<Map<string, EntryOutcome>>;
}

/** A running consumer. */
export interface GroupConsumer {
  /** Stop reading, finish or hold the batch in hand, hand the rest over. */
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
  const values = new Map<string, string>();
  for (let i = 0; fields && i + 1 < fields.length; i += 2) values.set(fields[i]!, fields[i + 1]!);
  return { id, originId: values.get("originId"), payload: values.get("payload") };
}

/**
 * Read a flat `[name, value, …]` reply into a map.
 * @param row - The reply.
 * @returns Field name to value.
 */
function pairs(row: unknown[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (let i = 0; i + 1 < row.length; i += 2) out.set(String(row[i]), row[i + 1]);
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
  /** Ids of the batch being handled right now. */
  const inHand = new Set<string>();
  let nextSweepAt = 0;

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
   * Reset the idle time of every entry this consumer holds — the batch in
   * hand and the queued retries — so no peer takes one over while this
   * consumer is alive and still working on it. A consumer that stops
   * answering stops renewing, and its entries go idle past `claimIdleMs`.
   * @throws {Error} When a Redis command fails; the timer logs it and renews next time.
   */
  async function renewHeld(): Promise<void> {
    const ids = [...new Set([...inHand, ...waiting.map((w) => w.entry.id)])];
    for (let i = 0; i < ids.length; i += settings.batchCount) {
      const chunk = ids.slice(i, i + settings.batchCount);
      await commands.xclaim(streamKey, group, consumer, 0, ...chunk, "JUSTID");
    }
  }

  /**
   * Read new entries.
   * @param blockMs - Longest to block.
   * @returns The entries read.
    * @throws {Error} When a Redis command fails; the read loop logs it and retries.
   */
  async function readNew(blockMs: number): Promise<StreamEntry[]> {
    const reply = (await reader.xreadgroup(
      "GROUP",
      group,
      consumer,
      "COUNT",
      settings.batchCount,
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
    * @throws {Error} When a Redis command fails; the read loop logs it and retries.
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
   * Act on the outcome of every entry of a batch.
   * @param entries - The batch.
   * @param outcomes - What the handler answered.
    * @throws {Error} When a Redis command fails; the read loop logs it and retries.
   */
  async function settle(entries: StreamEntry[], outcomes: Map<string, EntryOutcome>): Promise<void> {
    const ack: string[] = [];
    for (const entry of entries) {
      const outcome = outcomes.get(entry.id) ?? "wait";
      if (outcome === "done") {
        ack.push(entry.id);
      } else if (outcome === "wait") {
        retryLater(entry, settings.leaseRetryMs);
      } else if (outcome !== "held") {
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

  /**
   * Hand a batch to the caller and settle every entry.
   * @param entries - The batch.
   */
  async function handle(entries: StreamEntry[]): Promise<void> {
    for (const e of entries) inHand.add(e.id);
    try {
      let outcomes: Map<string, EntryOutcome>;
      try {
        outcomes = await opts.process(entries, { stopping: () => stopping });
      } catch (err) {
        outcomes = new Map(entries.map((e) => [e.id, { failed: err }]));
      }
      await settle(entries, outcomes);
    } finally {
      inHand.clear();
    }
  }

  /**
   * Take the retries that are due, and drop queued retries of entries that
   * were just claimed again.
   * @param fresh - Entries about to be handled from elsewhere.
   * @returns The due retries.
   */
  function takeDue(fresh: StreamEntry[]): StreamEntry[] {
    const now = Date.now();
    const freshIds = new Set(fresh.map((e) => e.id));
    const due: StreamEntry[] = [];
    const rest: Waiting[] = [];
    for (const w of waiting) {
      if (freshIds.has(w.entry.id)) continue;
      if (w.notBefore <= now) due.push(w.entry);
      else rest.push(w);
    }
    waiting = rest;
    return due;
  }

  /**
   * How long the next read may block: until the next retry or sweep is due.
   * @returns Milliseconds, at least 1.
   */
  function blockFor(): number {
    const now = Date.now();
    let until = Math.min(now + settings.blockMs, nextSweepAt);
    for (const w of waiting) until = Math.min(until, w.notBefore);
    return Math.max(1, until - now);
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
        const fresh = claimed.splice(0);
        let batch = [...fresh, ...takeDue(fresh)];
        if (batch.length === 0) batch = await readNew(blockFor());
        // A batch taken while stopping stays pending; handOver() marks it idle.
        if (batch.length > 0 && !stopping) await handle(batch);
      } catch (err) {
        if (stopping) break;
        logger.error({ err, streamKey, group }, "stream_group_loop_failed");
        await delay(LOOP_ERROR_DELAY_MS);
      }
    }
  }

  /**
   * Mark every entry this consumer still holds as idle past the take-over
   * limit, so the next sweep of any consumer takes it.
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
      const ids = rows.map((r) => r[0]);
      await commands.xclaim(streamKey, group, consumer, 0, ...ids, "IDLE", settings.claimIdleMs, "JUSTID");
      logger.info({ streamKey, group, count: ids.length }, "stream_entries_handed_over");
      if (rows.length < settings.batchCount) return;
      start = `(${ids[ids.length - 1]}`;
    }
  }

  const loop = run();
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
      stopped = (async (): Promise<void> => {
        await Promise.race([loop, delay(settings.stopDeadlineMs)]);
        waiting = [];
        try {
          await handOver();
        } catch (err) {
          logger.error({ err, streamKey, group }, "stream_hand_over_failed");
        }
        await commands.quit().catch(() => commands.disconnect());
      })();
      return stopped;
    },
  };
}
