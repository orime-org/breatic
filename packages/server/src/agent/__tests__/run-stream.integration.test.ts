// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A run's resumable stream against a real Redis, Redis failing on purpose
 * (inner#1717).
 *
 * `resumable-stream` 2.2.13 calls several of its Redis operations inside
 * `.then(async ...)` with no catch, so one failure there is an unhandled
 * rejection, and Node 24 ends the whole process on one. The publisher and
 * subscriber it is handed are guarded at exactly those call sites; these cases
 * fail each of them once and check the process heard no unhandled rejection,
 * the producer's stream still ran to its end, and a stream that cannot be set
 * up still fails where its caller can see it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const { errors } = vi.hoisted(() => ({ errors: [] as unknown[] }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: {
      error: (...args: unknown[]) => errors.push(args),
      warn: () => {},
      info: () => {},
      debug: () => {},
    },
  };
});

import crypto from "node:crypto";
import { createRedisClient, env, getRedis, initCore, type Redis } from "@breatic/core";
import { createRunStreams } from "@server/agent/run-stream.js";

let publisherClient: Redis;
let subscriberClient: Redis;
const unhandled: unknown[] = [];
/**
 * Record an unhandled rejection.
 * @param reason - What was rejected.
 */
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeAll(async () => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
  publisherClient = createRedisClient(env.REDIS_URL, { name: "run-stream-test-pub" });
  subscriberClient = createRedisClient(env.REDIS_URL, { name: "run-stream-test-sub" });
  await Promise.all([publisherClient.connect(), subscriberClient.connect()]);
  process.on("unhandledRejection", onUnhandled);
});

afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
  await Promise.all([publisherClient.quit(), subscriberClient.quit()]);
});

afterEach(() => {
  errors.length = 0;
  unhandled.length = 0;
});

/**
 * A client that rejects one chosen call, once, and passes everything else on.
 * @param client - The real client.
 * @param fail - Which call to fail: its method and a test on its arguments.
 * @param fail.method - The method.
 * @param fail.when - Whether this call is the one.
 * @returns The client, and whether the failure has fired.
 */
function failingOnce(
  client: Redis,
  fail: { method: string; when: (args: unknown[]) => boolean },
): { client: Redis; fired: () => boolean } {
  let done = false;
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== fail.method || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => {
        if (!done && fail.when(args)) {
          done = true;
          return Promise.reject(new Error(`injected ${fail.method} failure`));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { client: proxy, fired: () => done };
}

/**
 * A stream that says each piece after a short pause, then ends.
 * @param pieces - What it says.
 * @returns The stream.
 */
function slow(pieces: string[]): ReadableStream<string> {
  let i = 0;
  return new ReadableStream<string>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 40));
      if (i < pieces.length) controller.enqueue(pieces[i++]!);
      else controller.close();
    },
  });
}

/**
 * Read a stream to its end.
 * @param stream - The stream.
 * @returns Everything it said.
 */
async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/**
 * Let pending callbacks and timers run.
 * @param ms - How long.
 */
async function settleFor(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("a run's stream", () => {
  it("keeps its sentinel under the deployment's prefix, for at most a day (ST-22)", async () => {
    const streams = createRunStreams(publisherClient, subscriberClient);
    const runId = crypto.randomUUID();
    const produced = await streams.createNewResumableStream(runId, () => slow(["a", "b"]));
    const key = `${env.REDIS_KEY_PREFIX}:chat-stream:sentinel:${runId}`;
    expect(await getRedis().get(key)).toBe("1");
    const ttl = await getRedis().ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(86_400);
    await readAll(produced!);
  });

  it("survives a chunk publish failing while a reader is attached (ST-15)", async () => {
    const pub = failingOnce(publisherClient, {
      method: "publish",
      when: (args) => String(args[0]).includes(":chunk:"),
    });
    const streams = createRunStreams(pub.client, subscriberClient);
    const runId = crypto.randomUUID();
    const produced = await streams.createNewResumableStream(runId, () => slow(["a", "b", "c", "d"]));
    const attached = await streams.resumeExistingStream(runId);
    expect(attached).toBeTruthy();
    const [all] = await Promise.all([readAll(produced!), attached ? readAll(attached).catch(() => "") : ""]);
    await settleFor(300);
    expect(pub.fired()).toBe(true);
    expect(all).toBe("abcd");
    expect(unhandled).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("survives writing the finished sentinel failing (ST-16)", async () => {
    const pub = failingOnce(publisherClient, {
      method: "set",
      when: (args) => args[1] === "DONE",
    });
    const streams = createRunStreams(pub.client, subscriberClient);
    const runId = crypto.randomUUID();
    const produced = await streams.createNewResumableStream(runId, () => slow(["a", "b"]));
    expect(await readAll(produced!)).toBe("ab");
    await settleFor(300);
    expect(pub.fired()).toBe(true);
    expect(unhandled).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("survives unsubscribing failing when the stream ends (ST-17)", async () => {
    const sub = failingOnce(subscriberClient, { method: "unsubscribe", when: () => true });
    const streams = createRunStreams(publisherClient, sub.client);
    const runId = crypto.randomUUID();
    const produced = await streams.createNewResumableStream(runId, () => slow(["a", "b"]));
    expect(await readAll(produced!)).toBe("ab");
    await settleFor(300);
    expect(sub.fired()).toBe(true);
    expect(unhandled).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("still fails where the caller sees it when the stream cannot be set up (ST-20)", async () => {
    const sub = failingOnce(subscriberClient, { method: "subscribe", when: () => true });
    const streams = createRunStreams(publisherClient, sub.client);
    await expect(streams.createNewResumableStream(crypto.randomUUID(), () => slow(["a"]))).rejects.toThrow(/injected subscribe/);
    const pub = failingOnce(publisherClient, { method: "set", when: (args) => args[1] === "1" });
    const again = createRunStreams(pub.client, subscriberClient);
    await expect(again.createNewResumableStream(crypto.randomUUID(), () => slow(["a"]))).rejects.toThrow(/injected set/);
    await settleFor(100);
    expect(unhandled).toEqual([]);
  });

  it("still attaches to a live producer when reading the sentinel fails (ST-18)", async () => {
    const streams = createRunStreams(publisherClient, subscriberClient);
    const runId = crypto.randomUUID();
    const produced = await streams.createNewResumableStream(runId, () => slow(["a", "b", "c"]));
    const pub = failingOnce(publisherClient, { method: "get", when: () => true });
    const reader = createRunStreams(pub.client, subscriberClient);
    const attached = await reader.resumeExistingStream(runId);
    expect(attached).toBeTruthy();
    const [, seen] = await Promise.all([readAll(produced!), readAll(attached!)]);
    expect(pub.fired()).toBe(true);
    expect(seen).toBe("abc");
    expect(unhandled).toEqual([]);
  });
});
