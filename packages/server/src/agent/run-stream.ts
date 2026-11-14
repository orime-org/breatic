// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a run's answer streams, so any page can read it from the start
 * (inner#1717).
 *
 * `resumable-stream` keeps every frame a run writes and replays them to each
 * reader that attaches, on any instance, through Redis. It calls some of its
 * Redis operations inside `.then(async ...)` with no catch (2.2.13
 * `dist/runtime.js:90-94`, `:117-141`, `:254-255`): one failure there is an
 * unhandled rejection, and Node 24 ends the process on one. So the publisher
 * and subscriber handed to it catch exactly those calls -- a publish, an
 * unsubscribe, writing the finished sentinel -- log them and carry on, and a
 * failed read of the sentinel answers "still running", which keeps the ack
 * timer and the done watchdog from throwing or closing a live reader. The two
 * calls a new stream awaits before it exists, the request subscription and the
 * running sentinel, still throw, so a stream that cannot be set up fails
 * where its run can see it.
 */
import { createResumableStreamContext } from "resumable-stream/generic";
import type { Publisher, ResumableStreamContext, Subscriber } from "resumable-stream/generic";
import { createRedisClient, env, getRedis, logger, type Redis } from "@breatic/core";

/** What the library writes into a stream's sentinel once the stream is finished. */
const DONE = "DONE";

/** What a sentinel reads while the stream is still running. */
const RUNNING = "1";

/**
 * Log a Redis call the library would have left unhandled.
 * @param err - What Redis threw.
 * @param op - Which call.
 * @param target - The key or channel.
 */
function logSwallowed(err: unknown, op: string, target: string): void {
  logger.error({ err, op, target }, "chat_stream_redis_failed");
}

/**
 * The publisher the library writes through, with its unguarded calls caught.
 * @param client - A DB 0 connection.
 * @returns The publisher.
 */
export function guardedPublisher(client: Redis): Publisher {
  return {
    connect: () => Promise.resolve(),
    publish: (channel, message) =>
      client.publish(channel, message).catch((err: unknown) => {
        logSwallowed(err, "publish", channel);
        return 0;
      }),
    set: (key, value, options) => {
      const written = options?.EX === undefined ? client.set(key, value) : client.set(key, value, "EX", options.EX);
      if (value !== DONE) return written;
      return written.catch((err: unknown) => {
        logSwallowed(err, "set", key);
        return null;
      });
    },
    get: (key) =>
      client.get(key).catch((err: unknown) => {
        logSwallowed(err, "get", key);
        return RUNNING;
      }),
    incr: (key) => client.incr(key),
  };
}

/** A subscriber that also lets the server's own channels share its connection. */
export interface ChatSubscriber extends Subscriber {
  /** Listen on a channel of our own; resolves once subscribed. */
  listen(channel: string, callback: (message: string) => void): Promise<void>;
}

const subscribers = new WeakMap<Redis, ChatSubscriber>();

/**
 * The subscriber on a dedicated connection, with its unguarded call caught.
 * One per connection: the connection's message event is shared by every channel.
 * @param client - A connection used only for subscribing.
 * @returns The subscriber.
 */
export function guardedSubscriber(client: Redis): ChatSubscriber {
  const held = subscribers.get(client);
  if (held !== undefined) return held;
  const handlers = new Map<string, (message: string) => void>();
  client.on("message", (channel: string, message: string) => handlers.get(channel)?.(message));
  /**
   * Subscribe a channel to a callback.
   * @param channel - The channel.
   * @param callback - What hears it.
   */
  const subscribe = async (channel: string, callback: (message: string) => void): Promise<void> => {
    handlers.set(channel, callback);
    await client.subscribe(channel);
  };
  const made: ChatSubscriber = {
    connect: () => Promise.resolve(),
    subscribe,
    listen: subscribe,
    unsubscribe: (channel) => {
      handlers.delete(channel);
      return client.unsubscribe(channel).catch((err: unknown) => {
        logSwallowed(err, "unsubscribe", channel);
        return 0;
      });
    },
  };
  subscribers.set(client, made);
  return made;
}

/**
 * The resumable streams on two given connections.
 * @param publisherClient - A DB 0 connection to write through.
 * @param subscriberClient - A connection used only for subscribing.
 * @returns The streams.
 */
export function createRunStreams(publisherClient: Redis, subscriberClient: Redis): ResumableStreamContext {
  return createResumableStreamContext({
    keyPrefix: `${env.REDIS_KEY_PREFIX}:chat-stream`,
    waitUntil: null,
    publisher: guardedPublisher(publisherClient),
    subscriber: guardedSubscriber(subscriberClient),
  });
}

let subscriberClient: Redis | null = null;
let shared: ResumableStreamContext | null = null;

/**
 * The connection the chat runs subscribe on: stream requests and stop signals.
 * @returns The connection.
 */
export function getChatSubscriberRedis(): Redis {
  subscriberClient ??= createRedisClient(env.REDIS_URL, { name: "chat-subscriber" });
  return subscriberClient;
}

/**
 * Quit the subscribing connection, on shutdown.
 * @returns Resolves once it is closed.
 */
export async function closeChatSubscriberRedis(): Promise<void> {
  const client = subscriberClient;
  subscriberClient = null;
  shared = null;
  if (client !== null) await client.quit().catch(() => client.disconnect());
}

/**
 * The resumable streams every run writes to and every page reads from.
 * @returns The streams.
 */
export function runStreams(): ResumableStreamContext {
  shared ??= createRunStreams(getRedis(), getChatSubscriberRedis());
  return shared;
}

/**
 * The shared subscriber, for the server's own channels.
 * @returns The subscriber.
 */
export function chatSubscriber(): ChatSubscriber {
  return guardedSubscriber(getChatSubscriberRedis());
}
