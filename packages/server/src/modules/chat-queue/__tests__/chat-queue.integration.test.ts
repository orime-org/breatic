// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The per-conversation run queue against a real Redis (inner#1717).
 *
 * Every operation is one Lua script, so whether it is atomic, and what it
 * leaves in the five keys, only shows on a server that runs it. Each case uses
 * a fresh conversation id, puts every key it reads in place first, and checks
 * the keys straight off Redis; an assertion that a key "did not change" takes
 * a snapshot of all five before and after.
 *
 * The queue cap is lowered to 3 and the id memory to 60 s so the limits are
 * reachable here; neither is the shipped value, so a number written into the
 * code instead of read from the config shows up.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const { QUEUE_MAX, IDS_TTL_MS, LEASE_MS } = vi.hoisted(() => ({
  QUEUE_MAX: 3,
  IDS_TTL_MS: 60_000,
  LEASE_MS: 60_000,
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...(actual.getAgentConfig as () => Record<string, unknown>)(),
      chat_queue_max: QUEUE_MAX,
      chat_queue_ids_ttl_ms: IDS_TTL_MS,
      chat_run_lease_ms: LEASE_MS,
    }),
  };
});

import crypto from "node:crypto";
import { createRedisClient, env, getRedis, initCore, type Redis } from "@breatic/core";
import { createChatQueue, type ChatQueue, type QueueItem } from "@server/modules/chat-queue/chat-queue.service.js";

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
});

/** The five keys of one conversation. */
interface Keys {
  active: string;
  queue: string;
  taken: string;
  ids: string;
  awaiting: string;
}

/**
 * The key names of a conversation.
 * @param c - Conversation id.
 * @returns Its five keys.
 */
function keysOf(c: string): Keys {
  return {
    active: `chat:active:${c}`,
    queue: `chat:queue:${c}`,
    taken: `chat:taken:${c}`,
    ids: `chat:queue-ids:${c}`,
    awaiting: `chat:awaiting:${c}`,
  };
}

/**
 * A queue item with the given id.
 * @param id - Message id.
 * @returns The item.
 */
function item(id: string): QueueItem {
  return {
    id,
    sentAt: "2026-11-12T08:00:00.000Z",
    userId: "u-1",
    acceptLanguage: "ja",
    message: `words of ${id}`,
    attached_chips: [],
  };
}

/**
 * The ids of a list of items.
 * @param items - Items.
 * @returns Their ids, in order.
 */
function ids(items: readonly QueueItem[]): string[] {
  return items.map((i) => i.id);
}

/** A fresh conversation with its keys. */
function fresh(): { c: string; k: Keys } {
  const c = crypto.randomUUID();
  return { c, k: keysOf(c) };
}

/**
 * Read a list key as item ids.
 * @param key - The list.
 * @returns The ids, in order.
 */
async function listIds(key: string): Promise<string[]> {
  const raw = await getRedis().lrange(key, 0, -1);
  return raw.map((r) => (JSON.parse(r) as QueueItem).id);
}

/**
 * Put items into a list key.
 * @param key - The list.
 * @param list - Items in order.
 */
async function putList(key: string, list: readonly string[]): Promise<void> {
  if (list.length === 0) return;
  await getRedis().rpush(key, ...list.map((id) => JSON.stringify(item(id))));
}

/**
 * Type, content and remaining life of each of the five keys.
 * @param k - The keys.
 * @returns A comparable snapshot.
 */
async function snapshot(k: Keys): Promise<Record<string, unknown>> {
  const r = getRedis();
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(k)) {
    const type = await r.type(key);
    let content: unknown = null;
    if (type === "string") content = await r.get(key);
    else if (type === "list") content = await r.lrange(key, 0, -1);
    else if (type === "set") content = (await r.smembers(key)).sort();
    else if (type === "zset") content = await r.zrange(key, 0, -1);
    const pttl = await r.pttl(key);
    // A live TTL moves between two reads; only whether there is one counts.
    out[name] = { type, content, ttl: pttl > 0 ? "set" : pttl };
  }
  return out;
}

let q: ChatQueue;

beforeAll(() => {
  q = createChatQueue(getRedis());
});

describe("enqueue", () => {
  it("opens a run when nothing is running, and records the id (RQ-01)", async () => {
    const { c, k } = fresh();
    const out = await q.enqueue(c, item("m1"));
    expect(out.status).toBe("start");
    if (out.status !== "start") return;
    expect(out.runId).toEqual(expect.any(String));
    expect(out.runId.length).toBeGreaterThan(0);
    expect(await getRedis().get(k.active)).toBe(out.runId);
    expect(await listIds(k.queue)).toEqual(["m1"]);
    expect(await getRedis().sismember(k.ids, "m1")).toBe(1);
    const ttl = await getRedis().pttl(k.ids);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IDS_TTL_MS);
    expect(ids(out.queue)).toEqual(["m1"]);
  });

  it("queues behind a running run (RQ-02)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1"]);
    const out = await q.enqueue(c, item("m2"));
    expect(out.status).toBe("queued");
    expect(await getRedis().get(k.active)).toBe("R1");
    expect(await listIds(k.queue)).toEqual(["m1", "m2"]);
    expect(ids(out.queue)).toEqual(["m1", "m2"]);
  });

  it("closes a waiting card and opens a run (RQ-03)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.awaiting, "T1");
    await putList(k.queue, ["m1"]);
    const out = await q.enqueue(c, item("m2"));
    expect(out.status).toBe("start");
    if (out.status !== "start") return;
    expect(await getRedis().exists(k.awaiting)).toBe(0);
    expect(await getRedis().get(k.active)).toBe(out.runId);
    expect(await listIds(k.queue)).toEqual(["m1", "m2"]);
  });

  it("leaves a card alone while a run is going (RQ-04)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await getRedis().set(k.awaiting, "T1");
    const out = await q.enqueue(c, item("m2"));
    expect(out.status).toBe("queued");
    expect(await getRedis().get(k.awaiting)).toBe("T1");
    expect(await getRedis().get(k.active)).toBe("R1");
  });

  it("answers duplicate for an id it has seen, without opening a run (RQ-05)", async () => {
    const { c, k } = fresh();
    await getRedis().sadd(k.ids, "m1");
    await putList(k.queue, ["m0"]);
    const out = await q.enqueue(c, item("m1"));
    expect(out.status).toBe("duplicate");
    expect(await listIds(k.queue)).toEqual(["m0"]);
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(ids(out.queue)).toEqual(["m0"]);
  });

  it("answers full at the cap and keeps everything as it was (RQ-06)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["a", "b", "c"]);
    const out = await q.enqueue(c, item("m4"));
    expect(out.status).toBe("full");
    expect(await listIds(k.queue)).toEqual(["a", "b", "c"]);
    expect(await getRedis().sismember(k.ids, "m4")).toBe(0);
    expect(await getRedis().get(k.active)).toBe("R1");
  });

  it("checks for a duplicate before the cap (RQ-07)", async () => {
    const { c, k } = fresh();
    await putList(k.queue, ["a", "b", "c"]);
    await getRedis().sadd(k.ids, "m4");
    const out = await q.enqueue(c, item("m4"));
    expect(out.status).toBe("duplicate");
  });

  it("renews the id memory on every enqueue (RQ-08)", async () => {
    const { c, k } = fresh();
    await getRedis().sadd(k.ids, "m0");
    await getRedis().pexpire(k.ids, 1000);
    await q.enqueue(c, item("m1"));
    const ttl = await getRedis().pttl(k.ids);
    expect(ttl).toBeGreaterThan(1000);
    expect(ttl).toBeLessThanOrEqual(IDS_TTL_MS);
  });

  it("does not renew the id memory on a duplicate (RQ-08b)", async () => {
    const { c, k } = fresh();
    await getRedis().sadd(k.ids, "m0");
    await getRedis().pexpire(k.ids, 1000);
    const out = await q.enqueue(c, item("m0"));
    expect(out.status).toBe("duplicate");
    expect(await getRedis().pttl(k.ids)).toBeLessThanOrEqual(1000);
    expect(await getRedis().smembers(k.ids)).toEqual(["m0"]);
  });

  it("never gives the queue a lifetime (RQ-09)", async () => {
    const { c, k } = fresh();
    await q.enqueue(c, item("m1"));
    const out = await q.enqueue(c, item("m2"));
    expect(out.status).toBe("queued");
    await q.remove(c, "m1");
    expect(await getRedis().pttl(k.queue)).toBe(-1);
  });
});

describe("claim", () => {
  it("opens a run for a waiting queue (RQ-10)", async () => {
    const { c, k } = fresh();
    await putList(k.queue, ["m1"]);
    const out = await q.claim(c);
    expect(out.status).toBe("start");
    if (out.status !== "start") return;
    expect(await getRedis().get(k.active)).toBe(out.runId);
  });

  it("opens a run for messages a dead run left taken (RQ-11)", async () => {
    const { c, k } = fresh();
    await putList(k.taken, ["x"]);
    const out = await q.claim(c);
    expect(out.status).toBe("start");
    expect(await getRedis().exists(k.active)).toBe(1);
  });

  it("does nothing when there is no work (RQ-12)", async () => {
    const { c, k } = fresh();
    const out = await q.claim(c);
    expect(out.status).toBe("idle");
    expect(out.queue).toEqual([]);
    expect(await getRedis().exists(k.active)).toBe(0);
  });

  it("does not open a run while a card waits (RQ-13)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.awaiting, "T1");
    await putList(k.queue, ["m1"]);
    const out = await q.claim(c);
    expect(out.status).toBe("awaiting");
    expect(await getRedis().exists(k.active)).toBe(0);
  });

  it("does not open a second run (RQ-14)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1"]);
    const out = await q.claim(c);
    expect(out.status).toBe("running");
    expect(await getRedis().get(k.active)).toBe("R1");
  });
});

describe("resume", () => {
  it("takes the conversation for a card answer (RQ-15)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.awaiting, "T1");
    expect(await q.resume(c, "R2")).toEqual({ status: "start", awaiting: "T1" });
    expect(await getRedis().get(k.active)).toBe("R2");
    expect(await getRedis().exists(k.awaiting)).toBe(0);
  });

  it("answers that no card was waiting when none was (RQ-15b)", async () => {
    const { c } = fresh();
    expect(await q.resume(c, "R2")).toEqual({ status: "start", awaiting: null });
  });

  it("answers busy while a run is going (RQ-16)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await getRedis().set(k.awaiting, "T1");
    expect(await q.resume(c, "R2")).toEqual({ status: "busy" });
    expect(await getRedis().get(k.active)).toBe("R1");
    expect(await getRedis().get(k.awaiting)).toBe("T1");
  });
});

describe("giveBack", () => {
  it("frees the conversation and puts the card back when nothing waits (RQ-16c)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.awaiting, "T1");
    await q.resume(c, "R2");
    expect(await q.giveBack(c, "R2", "T1")).toBeNull();
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await getRedis().get(k.awaiting)).toBe("T1");
  });

  it("frees the conversation and leaves no card when none was waiting (RQ-16d)", async () => {
    const { c, k } = fresh();
    await q.resume(c, "R2");
    expect(await q.giveBack(c, "R2", null)).toBeNull();
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await getRedis().exists(k.awaiting)).toBe(0);
  });

  it("hands the conversation to a new run for messages sent meanwhile, and the card stays closed (RQ-16e)", async () => {
    for (const list of ["queue", "taken"] as const) {
      const { c, k } = fresh();
      await getRedis().set(k.awaiting, "T1");
      await q.resume(c, "R2");
      await putList(k[list], ["m1"]);
      const next = await q.giveBack(c, "R2", "T1");
      expect(next).toEqual(expect.any(String));
      expect(next).not.toBe("R2");
      expect(await getRedis().get(k.active)).toBe(next);
      expect(await getRedis().exists(k.awaiting)).toBe(0);
    }
  });

  it("leaves another run's conversation alone (RQ-16f)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    const before = await snapshot(k);
    expect(await q.giveBack(c, "R2", "T1")).toBeNull();
    expect(await snapshot(k)).toEqual(before);
  });
});

describe("head", () => {
  it("gives nothing to a run that does not hold the conversation (RQ-17)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1"]);
    const before = await snapshot(k);
    expect(await q.head(c, "R2")).toEqual([]);
    expect(await snapshot(k)).toEqual(before);
  });

  it("gives back everything taken before, unchanged (RQ-18)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.taken, ["x", "y"]);
    await putList(k.queue, ["m1"]);
    expect(ids(await q.head(c, "R1"))).toEqual(["x", "y"]);
    expect(await listIds(k.taken)).toEqual(["x", "y"]);
    expect(await listIds(k.queue)).toEqual(["m1"]);
  });

  it("moves the first queued message to taken (RQ-19)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1", "m2"]);
    expect(ids(await q.head(c, "R1"))).toEqual(["m1"]);
    expect(await listIds(k.taken)).toEqual(["m1"]);
    expect(await listIds(k.queue)).toEqual(["m2"]);
  });

  it("gives nothing when nothing waits (RQ-20)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    expect(await q.head(c, "R1")).toEqual([]);
    expect(await getRedis().exists(k.taken)).toBe(0);
  });
});

describe("drain", () => {
  it("moves the whole queue behind what is taken (RQ-21)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.taken, ["x"]);
    await putList(k.queue, ["m1", "m2"]);
    expect(ids(await q.drain(c, "R1"))).toEqual(["m1", "m2"]);
    expect(await getRedis().exists(k.queue)).toBe(0);
    expect(await listIds(k.taken)).toEqual(["x", "m1", "m2"]);
  });

  it("gives nothing to a run that does not hold the conversation (RQ-22)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1"]);
    const before = await snapshot(k);
    expect(await q.drain(c, "R2")).toEqual([]);
    expect(await snapshot(k)).toEqual(before);
  });
});

describe("ack", () => {
  it("drops what was taken and nothing else (RQ-23)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.taken, ["x"]);
    await putList(k.queue, ["m1"]);
    await q.ack(c, "R1");
    expect(await getRedis().exists(k.taken)).toBe(0);
    expect(await listIds(k.queue)).toEqual(["m1"]);
    expect(await getRedis().get(k.active)).toBe("R1");
  });

  it("leaves another run's taken alone (RQ-24)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R2");
    await putList(k.taken, ["x"]);
    await q.ack(c, "R1");
    expect(await listIds(k.taken)).toEqual(["x"]);
  });
});

describe("remove", () => {
  it("takes a waiting message out of the queue (RQ-25)", async () => {
    const { c, k } = fresh();
    await putList(k.queue, ["m1", "m2", "m3"]);
    expect(await q.remove(c, "m2")).toBe("removed");
    expect(await listIds(k.queue)).toEqual(["m1", "m3"]);
  });

  it("answers taken for a message a run already has (RQ-26)", async () => {
    const { c, k } = fresh();
    await putList(k.queue, ["m1"]);
    await putList(k.taken, ["m2"]);
    expect(await q.remove(c, "m2")).toBe("taken");
    expect(await listIds(k.taken)).toEqual(["m2"]);
    expect(await listIds(k.queue)).toEqual(["m1"]);
  });

  it("answers gone for a message that is nowhere (RQ-27)", async () => {
    const { c, k } = fresh();
    await putList(k.queue, ["m1"]);
    const before = await snapshot(k);
    expect(await q.remove(c, "m9")).toBe("gone");
    expect(await snapshot(k)).toEqual(before);
  });
});

describe("forget", () => {
  it("drops the named ids and keeps the order of the rest (RQ-27b)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.taken, ["x", "y", "z"]);
    await putList(k.queue, ["m1"]);
    expect(ids(await q.forget(c, "R1", ["y"]))).toEqual(["x", "z"]);
    expect(await listIds(k.taken)).toEqual(["x", "z"]);
    expect(await listIds(k.queue)).toEqual(["m1"]);
    expect(await getRedis().get(k.active)).toBe("R1");
  });

  it("can empty what was taken (RQ-27c)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.taken, ["x", "y"]);
    expect(await q.forget(c, "R1", ["x", "y"])).toEqual([]);
    expect(await getRedis().llen(k.taken)).toBe(0);
  });

  it("ignores an id that was not taken (RQ-27d)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.taken, ["x"]);
    expect(ids(await q.forget(c, "R1", ["w"]))).toEqual(["x"]);
    expect(await listIds(k.taken)).toEqual(["x"]);
  });

  it("does nothing for a run that does not hold the conversation (RQ-27e)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R2");
    await putList(k.taken, ["x", "y"]);
    const before = await snapshot(k);
    expect(await q.forget(c, "R1", ["x"])).toEqual([]);
    expect(await snapshot(k)).toEqual(before);
  });
});

describe("settle", () => {
  const OTHER = ["done", "stopped", "failed", "step_limit"] as const;

  it("leaves another run's conversation alone, whatever the ending (RQ-28)", async () => {
    for (const ending of [
      { kind: "unsaved" },
      { kind: "awaiting", toolCallId: "T1" },
      { kind: "shutdown" },
      { kind: "done" },
    ] as const) {
      const { c, k } = fresh();
      await getRedis().set(k.active, "R2");
      await putList(k.queue, ["m1"]);
      await putList(k.taken, ["x"]);
      const before = await snapshot(k);
      expect(await q.settle(c, "R1", ending)).toBeNull();
      expect(await snapshot(k)).toEqual(before);
    }
  });

  it("frees the conversation without opening a run when the reply was not stored (RQ-29)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1"]);
    await putList(k.taken, ["x"]);
    expect(await q.settle(c, "R1", { kind: "unsaved" })).toBeNull();
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await listIds(k.queue)).toEqual(["m1"]);
    expect(await listIds(k.taken)).toEqual(["x"]);
  });

  it("records the waiting card and keeps the queue (RQ-30)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1"]);
    expect(await q.settle(c, "R1", { kind: "awaiting", toolCallId: "T1" })).toBeNull();
    expect(await getRedis().get(k.awaiting)).toBe("T1");
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await listIds(k.queue)).toEqual(["m1"]);
  });

  it("frees the conversation on shutdown and keeps the work (RQ-31)", async () => {
    const { c, k } = fresh();
    await getRedis().set(k.active, "R1");
    await putList(k.queue, ["m1"]);
    await putList(k.taken, ["x"]);
    expect(await q.settle(c, "R1", { kind: "shutdown" })).toBeNull();
    expect(await getRedis().exists(k.active)).toBe(0);
    expect(await listIds(k.queue)).toEqual(["m1"]);
    expect(await listIds(k.taken)).toEqual(["x"]);
  });

  it("hands the conversation to a new run when work waits (RQ-32)", async () => {
    for (const kind of OTHER) {
      const { c, k } = fresh();
      await getRedis().set(k.active, "R1");
      await putList(k.queue, ["m1"]);
      const next = await q.settle(c, "R1", { kind });
      expect(next).toEqual(expect.any(String));
      expect(next).not.toBe("R1");
      expect(await getRedis().get(k.active)).toBe(next);
    }
  });

  it("frees the conversation when nothing waits (RQ-33)", async () => {
    for (const kind of OTHER) {
      const { c, k } = fresh();
      await getRedis().set(k.active, "R1");
      expect(await q.settle(c, "R1", { kind })).toBeNull();
      expect(await getRedis().exists(k.active)).toBe(0);
    }
  });
});

describe("clear", () => {
  it("drops every key of one conversation and no other (RQ-34)", async () => {
    const one = fresh();
    const two = fresh();
    for (const { k } of [one, two]) {
      await getRedis().set(k.active, "R1");
      await putList(k.queue, ["m1"]);
      await putList(k.taken, ["x"]);
      await getRedis().sadd(k.ids, "m1");
      await getRedis().set(k.awaiting, "T1");
    }
    const otherBefore = await snapshot(two.k);
    await q.clear(one.c);
    for (const key of Object.values(one.k)) expect(await getRedis().exists(key)).toBe(0);
    expect(await snapshot(two.k)).toEqual(otherBefore);
  });
});

describe("two instances at once", () => {
  let a: Redis;
  let b: Redis;
  let qa: ChatQueue;
  let qb: ChatQueue;

  beforeAll(async () => {
    a = createRedisClient(env.REDIS_URL, { name: "chat-queue-test-a" });
    b = createRedisClient(env.REDIS_URL, { name: "chat-queue-test-b" });
    await Promise.all([a.connect(), b.connect()]);
    qa = createChatQueue(a);
    qb = createChatQueue(b);
  });

  afterAll(async () => {
    await Promise.all([a.quit(), b.quit()]);
  });

  it("opens exactly one run when two sends race (RQ-35)", async () => {
    for (let i = 0; i < 100; i += 1) {
      const { c, k } = fresh();
      const [x, y] = await Promise.all([qa.enqueue(c, item("m1")), qb.enqueue(c, item("m2"))]);
      const statuses = [x.status, y.status].sort();
      expect(statuses).toEqual(["queued", "start"]);
      const started = x.status === "start" ? x : y;
      if (started.status !== "start") throw new Error("unreachable");
      expect(await getRedis().get(k.active)).toBe(started.runId);
      expect((await listIds(k.queue)).sort()).toEqual(["m1", "m2"]);
    }
  });

  it("never strands a message when a send races the end of a run (RQ-36)", async () => {
    for (let i = 0; i < 100; i += 1) {
      const { c, k } = fresh();
      await getRedis().set(k.active, "R1");
      const [next, sent] = await Promise.all([qa.settle(c, "R1", { kind: "done" }), qb.enqueue(c, item("m1"))]);
      const active = await getRedis().get(k.active);
      if (sent.status === "start") {
        expect(next).toBeNull();
        expect(active).toBe(sent.runId);
      } else {
        expect(sent.status).toBe("queued");
        expect(next).toEqual(expect.any(String));
        expect(active).toBe(next);
      }
      expect(await listIds(k.queue)).toEqual(["m1"]);
    }
  });

  it("puts a message in exactly one place when a step takes it as it is removed (RQ-37)", async () => {
    for (let i = 0; i < 100; i += 1) {
      const { c, k } = fresh();
      await getRedis().set(k.active, "R1");
      await putList(k.queue, ["m1", "m2"]);
      const [drained, removed] = await Promise.all([qa.drain(c, "R1"), qb.remove(c, "m1")]);
      const inDrain = ids(drained).includes("m1");
      const inTaken = (await listIds(k.taken)).includes("m1");
      if (removed === "removed") {
        expect(inDrain).toBe(false);
        expect(inTaken).toBe(false);
      } else {
        expect(removed).toBe("taken");
        expect(inDrain).toBe(true);
        expect(inTaken).toBe(true);
      }
    }
  });
});
