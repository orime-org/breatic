/**
 * Redis Streams consumer for the event bus.
 *
 * Single-consumer design (one Collab instance per env), using
 * `XREAD BLOCK` with a Redis-persisted last-id to resume after
 * crashes or restarts without losing events. Replaces the previous
 * Redis Pub/Sub subscription which dropped messages during downtime.
 *
 * The last successfully handled stream id is stored in Redis at
 * `${env}:collab:<stream-key>:last-id`. On first startup (empty
 * key), we start from `0-0` to replay any pending events left by a
 * previous Collab that never acknowledged them. Subsequent startups
 * resume from the persisted id.
 *
 * The transport is intentionally generic over payload type — the
 * caller provides a parser + handler, and this module only owns the
 * Streams read loop, last-id persistence, and retry semantics.
 */

import { createRedisClient } from "@breatic/core";
import { createLogger } from "@collab/infra/logger.js";

const logger = createLogger("event-stream");

/** How long to block per XREAD call in milliseconds. */
const BLOCK_MS = 5000;

/** Max events read per XREAD call. */
const COUNT = 32;

/**
 * Start consuming events from a Redis stream with durable resume.
 *
 * Runs an infinite loop in the background. Each delivered event is
 * parsed via `parse` then passed to `handle`. On success the
 * last-id is persisted. On handler failure the event is NOT
 * acknowledged and will be retried on the next iteration.
 *
 * @param opts.redisUrl - Redis connection URL
 * @param opts.streamKey - Full stream key (e.g. `dev:stream:task-results`)
 * @param opts.lastIdKey - Full Redis key where the last-id is persisted
 * @param opts.parse - Parses the raw JSON string into a typed payload
 * @param opts.handle - Called for each event, must be idempotent
 * @returns Stop function that cancels the loop and closes the Redis client
 */
export function startStreamConsumer<T>(opts: {
  redisUrl: string;
  streamKey: string;
  lastIdKey: string;
  parse: (raw: string) => T;
  handle: (event: T) => Promise<void>;
}): () => Promise<void> {
  const { redisUrl, streamKey, lastIdKey, parse, handle } = opts;
  // Stream consumer holds a blocking XREAD BLOCK across the
  // event loop, so we override `commandTimeout` to undefined per
  // the BullMQ pattern (the 5s default would kill long polls).
  // The remaining production-safety knobs (keepAlive / READONLY
  // reconnect / error log tagging) flow from the core factory.
  const redis = createRedisClient(redisUrl, {
    name: "collab-event-stream",
    commandTimeout: undefined,
  });

  let stopped = false;

  async function loop(): Promise<void> {
    let lastId = (await redis.get(lastIdKey)) ?? "0-0";
    logger.info({ streamKey, startId: lastId }, "Stream consumer started");

    while (!stopped) {
      try {
        const result = (await redis.xread(
          "COUNT",
          COUNT,
          "BLOCK",
          BLOCK_MS,
          "STREAMS",
          streamKey,
          lastId,
        )) as [string, [string, string[]][]][] | null;

        if (!result) continue; // Timeout, loop again

        for (const [, entries] of result) {
          let handlerFailed = false;

          for (const [id, fields] of entries) {
            // fields is a flat array: [key1, val1, key2, val2, ...]
            const payloadIdx = fields.indexOf("payload");
            if (payloadIdx === -1) {
              logger.warn({ id }, "Stream entry missing 'payload' field, skipping");
              lastId = id;
              await redis.set(lastIdKey, lastId);
              continue;
            }

            const raw = fields[payloadIdx + 1]!;
            let event: T;
            try {
              event = parse(raw);
            } catch (err) {
              logger.error({ id, err, raw }, "Failed to parse event payload, skipping");
              lastId = id;
              await redis.set(lastIdKey, lastId);
              continue;
            }

            try {
              await handle(event);
              lastId = id;
              await redis.set(lastIdKey, lastId);
            } catch (err) {
              logger.error({ id, err }, "Event handler failed, will retry");
              handlerFailed = true;
              break;
            }
          }

          if (handlerFailed) {
            await new Promise((r) => setTimeout(r, 1000));
            break;
          }
        }
      } catch (err) {
        if (stopped) break;
        logger.error({ err }, "XREAD failed, retrying in 2s");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    logger.info("Stream consumer stopped");
  }

  void loop();

  return async () => {
    stopped = true;
    await redis.quit();
  };
}
