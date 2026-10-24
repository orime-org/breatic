// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Consume a Redis stream as one member of a consumer group (inner#1497 §6.1).
 *
 * Every application instance is one consumer in the group, so each entry is held
 * by one instance at a time. An entry that is not acknowledged goes to another
 * consumer once it has been idle past `claimIdleMs`, so delivery is at least
 * once and the caller's handling must tolerate a repeat. What this module owns is the part every stream needs
 * the same way: creating the group, reading, acknowledging, taking over the
 * entries of a consumer that stopped answering, retrying a failing entry with
 * a growing delay until it goes to the dead-letter stream, and handing the
 * unfinished entries over on a graceful stop. What an entry means is the
 * caller's: it names each entry's key, gets one key's entries at a time and
 * answers each entry with an outcome.
 *
 * Entries of one key run one round at a time, in the order this consumer took
 * them. An entry retried after a failure, and one taken over from another
 * consumer, runs after newer ones of its key, and the caller's versions keep
 * that safe; entries answered `wait` go back to the head of their key's queue.
 * Different keys run side by side up to `keyConcurrency`. Reads go on while
 * rounds run, and a read asks for at most as many entries as there are free
 * key slots, so an entry read off the stream does not wait here behind a busy
 * slot while a peer sits idle (Celery prefetch, RabbitMQ consumer prefetch,
 * Pub/Sub flow control); a take-over sweep claims up to the room left within
 * `maxHeld`. Entries for a key whose round is running join that key's next
 * round.
 *
 * Two connections: the blocking read holds one for up to `blockMs`, and any
 * command sent on it would queue behind the block.
 */

import { setTimeout as delay } from "node:timers/promises";
import { type Redis } from "ioredis";
import { createRedisClient } from "@core/infra/redis.js";
import { STREAM_MAXLEN } from "@core/infra/event-stream.js";

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
 * - `wait`: not attempted this time (lease busy, peer write not here yet, or stopping); retried soon, not counted as a failure; while stopping, left pending: handed over when its round settled before the stop deadline, otherwise taken over once idle past `claimIdleMs`.
 * - `{ failed }`: handling threw; counted, retried with backoff, dead-lettered at the limit.
 */
export type EntryOutcome = "done" | "wait" | { failed: unknown };

/** Timing and limits, supplied by the application configuration. */
export interface GroupConsumerSettings {
  /** Most entries this consumer holds at once, running and queued. */
  maxHeld: number;
  /** Most keys with a round running at once. */
  keyConcurrency: number;
  /** Longest a read blocks when nothing is waiting. */
  blockMs: number;
  /** Hold on a key after a `wait` outcome; also the longest a read blocks while rounds run. */
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

/** A consumer lifecycle or delivery report; the application decides how to record it. */
export type GroupConsumerReport =
  | { event: "stream_group_created"; context: { streamKey: string; group: string; start: string } }
  | { event: "stream_group_consumer_forgotten"; context: { streamKey: string; group: string; consumer: string } }
  | { event: "stream_entries_trimmed_before_handled"; context: { streamKey: string; group: string; ids: string[] } }
  | { event: "stream_entry_failed_will_retry"; context: { err: unknown; streamKey: string; id: string; failures: number; delayMs: number } }
  | { event: "stream_entry_dead_lettered"; context: { err: unknown; streamKey: string; deadKey: string; id: string; originId: string; failures: number; payload: string | undefined } }
  | { event: "stream_entry_failure_not_recorded"; context: { err: unknown; streamKey: string; id: string } }
  | { event: "stream_round_settle_failed"; context: { err: unknown; streamKey: string; group: string; ids: string[] } }
  | { event: "stream_group_create_failed"; context: { err: unknown; streamKey: string; group: string } }
  | { event: "stream_group_loop_failed"; context: { err: unknown; streamKey: string; group: string } }
  | { event: "stream_entries_handed_over"; context: { streamKey: string; group: string; count: number } }
  | { event: "stream_entries_renew_failed"; context: { err: unknown; streamKey: string; group: string } }
  | { event: "stream_hand_over_failed"; context: { err: unknown; streamKey: string; group: string } };

/** Everything one consumer needs. */
export interface GroupConsumerOptions {
  /** Receive lifecycle and failure reports. This callback must not throw. */
  report: (report: GroupConsumerReport) => void;
  /** Diagnostic connection name prefix; dedicated read and command sockets remain separate. */
  connectionNamePrefix?: string;
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
  /** Handle one key's entries, in the order taken; an entry left unanswered counts as `wait`. */
  process: (
    entries: StreamEntry[],
    control: { stopping: () => boolean },
  ) => Promise<Map<string, EntryOutcome>>;
}

/** A running consumer. */
export interface GroupConsumer {
  /**
   * Stop reading and starting rounds, wait up to `stopDeadlineMs` for the
   * running rounds, then hand over every entry not in a running round and
   * resolve. A round still running then settles afterwards on a connection
   * kept open until it does.
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
 * @param opts - Stream, group, names, limits, the key function and the round handler.
 * @returns The running consumer.
 */
export function startGroupConsumer(opts: GroupConsumerOptions): GroupConsumer {
  const { streamKey, group, consumer, settings, coordination, failuresKey } = opts;
  const deadKey = `${streamKey}:dead`;
  // The blocking read must not time out on the client side.
  const reader = createRedisClient(opts.streamUrl, {
    name: `${opts.connectionNamePrefix ?? "stream-group"}-read:${group}`,
    commandTimeout: undefined,
  });
  const commands = createRedisClient(opts.streamUrl, { name: `${opts.connectionNamePrefix ?? "stream-group"}-cmd:${group}` });

  let stopping = false;
  let stopped: Promise<void> | undefined;
  let waiting: Waiting[] = [];
  const claimed: StreamEntry[] = [];
  /** Entries waiting for their key's next round, by key. */
  const queued = new Map<string, StreamEntry[]>();
  /** Ids of the queued entries. */
  const queuedIds = new Set<string>();
  /** The running round of each key. */
  const running = new Map<string, Promise<void>>();
  /** Ids of the entries in running rounds. */
  const inHand = new Set<string>();
  /** Keys whose next round must not start before the given time. */
  const delayedUntil = new Map<string, number>();
  let nextSweepAt = 0;
  /** Where the next take-over sweep continues its walk of the pending list. */
  let claimCursor = "0-0";
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
      opts.report({ event: "stream_group_created", context: { streamKey, group, start } });
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
      opts.report({ event: "stream_group_consumer_forgotten", context: { streamKey, group, consumer: name } });
    }
  }

  /**
   * Take over as many entries idle past `claimIdleMs` as there is room for,
   * continuing where the last sweep stopped, then forget dead consumers. What
   * is left stays idle for the next sweep of any consumer.
   * @throws {Error} When a Redis command fails; the read loop logs it and retries.
   */
  async function sweep(): Promise<void> {
    const free = room();
    if (free > 0) {
      // One call scans at most ten times COUNT entries; the cursor carries the
      // walk on from where this one stopped.
      const [next, entries, trimmed] = (await commands.xautoclaim(
        streamKey,
        group,
        consumer,
        settings.claimIdleMs,
        claimCursor,
        "COUNT",
        free,
      )) as [string, Array<[string, string[] | null]>, string[] | undefined];
      claimCursor = next;
      for (const [id, fields] of entries) claimed.push(toEntry(id, fields));
      if (trimmed && trimmed.length > 0) {
        opts.report({ event: "stream_entries_trimmed_before_handled", context: { streamKey, group, ids: trimmed } });
      }
    }
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
    for (let i = 0; i < ids.length && !stopping; i += settings.maxHeld) {
      const chunk = ids.slice(i, i + settings.maxHeld);
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
   * Queue a failed entry for a retry after its backoff.
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
      opts.report({ event: "stream_entry_failed_will_retry", context: { err, streamKey, id: entry.id, failures, delayMs } });
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
    opts.report({ event: "stream_entry_dead_lettered", context: { err, streamKey, deadKey, id: entry.id, originId: entry.originId ?? entry.id, failures, payload: entry.payload } });
    return true;
  }

  /**
   * Put entries back at the head of their key's queue and hold the key's next
   * round for `leaseRetryMs`. A `wait` is about the key (its lease is busy, a
   * peer's writes are not here yet), so the key retries as a whole, together
   * with whatever arrived for it meanwhile.
   * @param key - The key.
   * @param entries - Its entries to retry, in the order taken.
   */
  function retryKeyLater(key: string, entries: StreamEntry[]): void {
    if (stopping || entries.length === 0) return;
    queued.set(key, [...entries, ...(queued.get(key) ?? [])]);
    for (const e of entries) queuedIds.add(e.id);
    delayedUntil.set(key, Date.now() + settings.leaseRetryMs);
  }

  /**
   * Act on the outcome of every entry of a round.
   * @param key - The round's key.
   * @param entries - The round's entries.
   * @param outcomes - What the handler answered.
   * @throws {Error} When acknowledging fails; the round logs it.
   */
  async function settle(key: string, entries: StreamEntry[], outcomes: Map<string, EntryOutcome>): Promise<void> {
    const ack: string[] = [];
    const retry: StreamEntry[] = [];
    for (const entry of entries) {
      const outcome = outcomes.get(entry.id) ?? "wait";
      if (outcome === "done") {
        ack.push(entry.id);
      } else if (outcome === "wait") {
        retry.push(entry);
      } else {
        try {
          if (await recordFailure(entry, outcome.failed)) ack.push(entry.id);
        } catch (err) {
          opts.report({ event: "stream_entry_failure_not_recorded", context: { err, streamKey, id: entry.id } });
          retry.push(entry);
        }
      }
    }
    retryKeyLater(key, retry);
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
   * @param entries - Its entries, in the order taken.
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
        await settle(key, entries, outcomes);
      } catch (err) {
        // Unacknowledged entries stay pending and are taken over once idle.
        opts.report({ event: "stream_round_settle_failed", context: { err, streamKey, group, ids: entries.map((e) => e.id) } });
      }
    })().finally(() => {
      for (const e of entries) inHand.delete(e.id);
      running.delete(key);
      startRounds();
      wakeUp();
    });
    running.set(key, round);
  }

  /** Start a round for every queued key without one and not held back, while slots are free. */
  function startRounds(): void {
    if (stopping) return;
    const now = Date.now();
    for (const [key, entries] of queued) {
      if (running.size >= settings.keyConcurrency) return;
      if (running.has(key) || (delayedUntil.get(key) ?? 0) > now) continue;
      queued.delete(key);
      delayedUntil.delete(key);
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
   * How many entries a read may take now: one per key slot that neither a
   * running round nor a held-back key occupies, within the entries this
   * consumer may hold.
   * @returns The count; zero when nothing may be read.
   */
  function readCapacity(): number {
    return Math.max(0, Math.min(settings.keyConcurrency - running.size - delayedUntil.size, room()));
  }

  /**
   * Entries this consumer may still take within `maxHeld`.
   * @returns The count; negative while due failure retries, which do not
   *   count against `maxHeld` while they wait, are back in the queue, and
   *   briefly while a round that answered `wait` settles with its entries
   *   both in hand and queued.
   */
  function room(): number {
    return settings.maxHeld - inHand.size - queuedIds.size;
  }

  /**
   * How long the next read or idle wait may last: until the next retry or
   * sweep is due, or a held-back key's hold ends while a slot is free. A running round can queue a retry due `leaseRetryMs` after
   * it ends, and nothing can end a blocked read early, so a read issued while
   * rounds run blocks at most that long.
   * @returns Milliseconds, at least 1.
   */
  function blockFor(): number {
    const now = Date.now();
    let until = Math.min(now + settings.blockMs, nextSweepAt);
    if (running.size > 0) until = Math.min(until, now + settings.leaseRetryMs);
    for (const w of waiting) until = Math.min(until, w.notBefore);
    // A held-back key can start only in a free slot; while every slot is busy,
    // the round that ends frees one and starts it.
    if (running.size < settings.keyConcurrency) for (const t of delayedUntil.values()) until = Math.min(until, t);
    return Math.max(1, until - now);
  }

  /**
   * Wait until a round ends, the consumer stops, or `ms` passes.
   * @param ms - Longest wait.
   * @returns Resolves when any of them happens.
   */
  function idle(ms: number): Promise<void> {
    if (stopping) return Promise.resolve();
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
        opts.report({ event: "stream_group_create_failed", context: { err, streamKey, group } });
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
        opts.report({ event: "stream_group_loop_failed", context: { err, streamKey, group } });
        await delay(LOOP_ERROR_DELAY_MS);
      }
    }
  }

  /**
   * Mark every entry this consumer still holds, except those in running
   * rounds, as idle past the take-over limit, so a later sweep of a consumer
   * with room takes it: a successor's first sweep at startup, or a peer's once
   * its walk of the pending list reaches it. A running round's entries are acknowledged when it
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
        settings.maxHeld,
        consumer,
      )) as Array<[string, string, number, number]>;
      if (rows.length === 0) return;
      const ids = rows.map((r) => r[0]).filter((id) => !inHand.has(id));
      if (ids.length > 0) {
        await commands.xclaim(streamKey, group, consumer, 0, ...ids, "IDLE", settings.claimIdleMs, "JUSTID");
        opts.report({ event: "stream_entries_handed_over", context: { streamKey, group, count: ids.length } });
      }
      if (rows.length < settings.maxHeld) return;
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
    renewHeld().catch((err: unknown) => opts.report({ event: "stream_entries_renew_failed", context: { err, streamKey, group } }));
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
        delayedUntil.clear();
        try {
          await handOver();
        } catch (err) {
          opts.report({ event: "stream_hand_over_failed", context: { err, streamKey, group } });
        }
        // Open until the running rounds settle, so they can still be acknowledged.
        void drained().finally(() => commands.quit().catch(() => commands.disconnect()));
      })();
      return stopped;
    },
  };
}
