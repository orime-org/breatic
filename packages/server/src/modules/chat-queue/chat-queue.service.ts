// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One run per conversation, and the messages waiting for it (inner#1717).
 *
 * A conversation has at most one Agent run at a time, named by the run id in
 * `chat:active:{c}`. Messages sent while it runs wait in `chat:queue:{c}`;
 * each step of the run moves what waits into `chat:taken:{c}` and hands it to
 * the model, and the taken list is dropped only once the reply that answers
 * them is stored. A run that dies keeps its taken messages, and whichever
 * instance opens the next run reads them first, so a sent message is answered
 * or withdrawn and never silently lost.
 *
 * Every operation is one Lua script: deciding who runs and moving messages
 * between the lists has to happen in one step, or two instances (or a send
 * racing the end of a run) each see the conversation free and both, or
 * neither, start a run. Keys carry no deployment prefix, like the other plain
 * DB 0 keys.
 */

import crypto from "node:crypto";
import { getAgentConfig, getRedis, type Redis } from "@breatic/core";

/** One message waiting for, or taken by, a run; the send request as restored, plus who sent it. */
export interface QueueItem {
  id: string;
  sentAt: string;
  userId: string;
  acceptLanguage: string;
  [field: string]: unknown;
}

/** What a send did. */
export type EnqueueResult =
  | { status: "start"; runId: string; queue: QueueItem[] }
  | { status: "queued" | "duplicate" | "full"; queue: QueueItem[] };

/** What a sync found, or the run it opened. */
export type ClaimResult =
  | { status: "start"; runId: string; queue: QueueItem[] }
  | { status: "running" | "awaiting" | "idle"; queue: QueueItem[] };

/** How a run ended, which decides what happens to its conversation next. */
export type RunEnding =
  | { kind: "done" | "stopped" | "failed" | "step_limit" }
  | { kind: "unsaved" }
  | { kind: "awaiting"; toolCallId: string }
  | { kind: "shutdown" };

/** The queue operations, bound to one Redis connection. */
export interface ChatQueue {
  enqueue(conversationId: string, item: QueueItem): Promise<EnqueueResult>;
  claim(conversationId: string): Promise<ClaimResult>;
  resume(conversationId: string, runId: string): Promise<"start" | "busy">;
  head(conversationId: string, runId: string): Promise<QueueItem[]>;
  drain(conversationId: string, runId: string): Promise<QueueItem[]>;
  forget(conversationId: string, runId: string, ids: readonly string[]): Promise<QueueItem[]>;
  ack(conversationId: string, runId: string): Promise<void>;
  remove(conversationId: string, id: string): Promise<"removed" | "taken" | "gone">;
  settle(conversationId: string, runId: string, ending: RunEnding): Promise<string | null>;
  renew(conversationId: string, runId: string): Promise<boolean>;
  clear(conversationId: string): Promise<void>;
}

/** Appends a list's items to a reply table. Shared head of every script that answers with the queue. */
const APPEND = `
local function append(out, key)
  for _, v in ipairs(redis.call('lrange', key, 0, -1)) do table.insert(out, v) end
  return out
end`;

/** KEYS active, queue, ids, awaiting; ARGV id, item, max, idsTtlMs, newRunId, leaseMs. */
const ENQUEUE = `${APPEND}
if redis.call('sismember', KEYS[3], ARGV[1]) == 1 then return append({'duplicate', ''}, KEYS[2]) end
if redis.call('llen', KEYS[2]) >= tonumber(ARGV[3]) then return append({'full', ''}, KEYS[2]) end
redis.call('rpush', KEYS[2], ARGV[2])
redis.call('sadd', KEYS[3], ARGV[1])
redis.call('pexpire', KEYS[3], ARGV[4])
if redis.call('exists', KEYS[1]) == 1 then return append({'queued', ''}, KEYS[2]) end
redis.call('del', KEYS[4])
redis.call('set', KEYS[1], ARGV[5], 'PX', ARGV[6])
return append({'start', ARGV[5]}, KEYS[2])`;

/** KEYS active, awaiting, taken, queue; ARGV newRunId, leaseMs. */
const CLAIM = `${APPEND}
if redis.call('exists', KEYS[1]) == 1 then return append({'running', ''}, KEYS[4]) end
if redis.call('exists', KEYS[2]) == 1 then return append({'awaiting', ''}, KEYS[4]) end
if redis.call('llen', KEYS[3]) == 0 and redis.call('llen', KEYS[4]) == 0 then return append({'idle', ''}, KEYS[4]) end
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
return append({'start', ARGV[1]}, KEYS[4])`;

/** KEYS active, awaiting; ARGV runId, leaseMs. */
const RESUME = `
if redis.call('exists', KEYS[1]) == 1 then return 'busy' end
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('del', KEYS[2])
return 'start'`;

/** KEYS active, taken, queue; ARGV runId. */
const HEAD = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return {} end
if redis.call('llen', KEYS[2]) > 0 then return redis.call('lrange', KEYS[2], 0, -1) end
local first = redis.call('lpop', KEYS[3])
if not first then return {} end
redis.call('rpush', KEYS[2], first)
return {first}`;

/** KEYS active, taken, queue; ARGV runId. */
const DRAIN = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return {} end
local items = redis.call('lrange', KEYS[3], 0, -1)
if #items == 0 then return {} end
redis.call('rpush', KEYS[2], unpack(items))
redis.call('del', KEYS[3])
return items`;

/** KEYS active, taken; ARGV runId, then the ids to drop. */
const FORGET = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return {} end
local drop = {}
for i = 2, #ARGV do drop[ARGV[i]] = true end
local keep = {}
for _, v in ipairs(redis.call('lrange', KEYS[2], 0, -1)) do
  if not drop[cjson.decode(v).id] then table.insert(keep, v) end
end
redis.call('del', KEYS[2])
if #keep > 0 then redis.call('rpush', KEYS[2], unpack(keep)) end
return keep`;

/** KEYS active, taken; ARGV runId. */
const ACK = `
if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[2]) end
return 1`;

/** KEYS queue, taken; ARGV id. */
const REMOVE = `
for _, v in ipairs(redis.call('lrange', KEYS[1], 0, -1)) do
  if cjson.decode(v).id == ARGV[1] then
    redis.call('lrem', KEYS[1], 1, v)
    return 'removed'
  end
end
for _, v in ipairs(redis.call('lrange', KEYS[2], 0, -1)) do
  if cjson.decode(v).id == ARGV[1] then return 'taken' end
end
return 'gone'`;

/** KEYS active, awaiting, queue; ARGV runId, kind, toolCallId, newRunId, leaseMs. */
const SETTLE = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return false end
local kind = ARGV[2]
if kind == 'awaiting' then redis.call('set', KEYS[2], ARGV[3]) end
if kind == 'unsaved' or kind == 'awaiting' or kind == 'shutdown' or redis.call('llen', KEYS[3]) == 0 then
  redis.call('del', KEYS[1])
  return false
end
redis.call('set', KEYS[1], ARGV[4], 'PX', ARGV[5])
return ARGV[4]`;

/** KEYS active; ARGV runId, leaseMs. */
const RENEW = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('pexpire', KEYS[1], ARGV[2])
return 1`;

/**
 * The key names of one conversation.
 * @param c - Conversation id.
 * @returns Its five keys.
 */
function keysOf(c: string): { active: string; queue: string; taken: string; ids: string; awaiting: string } {
  return {
    active: `chat:active:${c}`,
    queue: `chat:queue:${c}`,
    taken: `chat:taken:${c}`,
    ids: `chat:queue-ids:${c}`,
    awaiting: `chat:awaiting:${c}`,
  };
}

/**
 * Parse the stored items of a list.
 * @param raw - JSON strings, as Redis holds them.
 * @returns The items.
 */
function items(raw: readonly string[]): QueueItem[] {
  return raw.map((r) => JSON.parse(r) as QueueItem);
}

/**
 * Bind the queue operations to a Redis connection.
 * @param redis - The DB 0 connection to run the scripts on.
 * @returns The operations.
 */
export function createChatQueue(redis: Redis): ChatQueue {
  /**
   * The lease a run holds its conversation for, as a script argument.
   * @returns Milliseconds, as text.
   */
  const leaseMs = (): string => String(getAgentConfig().chat_run_lease_ms);
  /**
   * A fresh run id.
   * @returns A uuid.
   */
  const newRunId = (): string => crypto.randomUUID();
  return {
    async enqueue(c, item) {
      const k = keysOf(c);
      const cfg = getAgentConfig();
      const [status, runId, ...queue] = (await redis.eval(
        ENQUEUE,
        4,
        k.active,
        k.queue,
        k.ids,
        k.awaiting,
        item.id,
        JSON.stringify(item),
        String(cfg.chat_queue_max),
        String(cfg.chat_queue_ids_ttl_ms),
        newRunId(),
        leaseMs(),
      )) as string[];
      if (status === "start") return { status, runId: runId!, queue: items(queue) };
      return { status: status as "queued" | "duplicate" | "full", queue: items(queue) };
    },
    async claim(c) {
      const k = keysOf(c);
      const [status, runId, ...queue] = (await redis.eval(
        CLAIM,
        4,
        k.active,
        k.awaiting,
        k.taken,
        k.queue,
        newRunId(),
        leaseMs(),
      )) as string[];
      if (status === "start") return { status, runId: runId!, queue: items(queue) };
      return { status: status as "running" | "awaiting" | "idle", queue: items(queue) };
    },
    async resume(c, runId) {
      const k = keysOf(c);
      return (await redis.eval(RESUME, 2, k.active, k.awaiting, runId, leaseMs())) as "start" | "busy";
    },
    async head(c, runId) {
      const k = keysOf(c);
      return items((await redis.eval(HEAD, 3, k.active, k.taken, k.queue, runId)) as string[]);
    },
    async drain(c, runId) {
      const k = keysOf(c);
      return items((await redis.eval(DRAIN, 3, k.active, k.taken, k.queue, runId)) as string[]);
    },
    async forget(c, runId, ids) {
      const k = keysOf(c);
      return items((await redis.eval(FORGET, 2, k.active, k.taken, runId, ...ids)) as string[]);
    },
    async ack(c, runId) {
      const k = keysOf(c);
      await redis.eval(ACK, 2, k.active, k.taken, runId);
    },
    async remove(c, id) {
      const k = keysOf(c);
      return (await redis.eval(REMOVE, 2, k.queue, k.taken, id)) as "removed" | "taken" | "gone";
    },
    async settle(c, runId, ending) {
      const k = keysOf(c);
      const toolCallId = ending.kind === "awaiting" ? ending.toolCallId : "";
      const next = (await redis.eval(
        SETTLE,
        3,
        k.active,
        k.awaiting,
        k.queue,
        runId,
        ending.kind,
        toolCallId,
        newRunId(),
        leaseMs(),
      )) as string | null;
      return next ?? null;
    },
    async renew(c, runId) {
      const k = keysOf(c);
      return (await redis.eval(RENEW, 1, k.active, runId, leaseMs())) === 1;
    },
    async clear(c) {
      const k = keysOf(c);
      await redis.del(k.active, k.queue, k.taken, k.ids, k.awaiting);
    },
  };
}

let shared: ChatQueue | null = null;

/**
 * The queue operations on the shared DB 0 connection.
 * @returns The operations.
 */
export function chatQueue(): ChatQueue {
  shared ??= createChatQueue(getRedis());
  return shared;
}
