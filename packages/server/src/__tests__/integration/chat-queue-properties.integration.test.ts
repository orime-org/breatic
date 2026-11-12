// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Properties of the per-conversation chat queue on a real Redis (inner#1717,
 * PB-01 to PB-04, PB-06 and PB-07 of the test spec).
 *
 * Each case runs a random sequence against one fresh conversation. Its
 * operations are sends (new ids and ids already used), claims, card answers
 * (`resume`, then `giveBack` when the answer is refused), stale or random run
 * ids calling the run-only scripts, take-backs, crashes and a delete; between
 * any two of them the run holding the conversation takes one step. The
 * runner follows `runIt` in `src/agent/chat-run.ts` step for step (head,
 * forget what a stored reply answered, head again, the opening row, drains,
 * the reply, ack, settle) against an in-memory store whose opening write
 * returns the existing row for an id it already holds. A crash drops the
 * runner and deletes `active`, which is what a lease running out looks like.
 * After the sequence, claims and the runner go on until no work is left.
 *
 * The facts the properties read are kept beside Redis, never derived from
 * it: which ids were accepted, taken back or cleared, and what the store
 * holds. The queue cap is 3, so a send is refused as full.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

const { QUEUE_MAX } = vi.hoisted(() => ({ QUEUE_MAX: 3 }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentConfig: () => ({
      ...(actual.getAgentConfig as () => Record<string, unknown>)(),
      chat_queue_max: QUEUE_MAX,
    }),
  };
});

import crypto from "node:crypto";
import fc from "fast-check";
import { getRedis, initCore } from "@breatic/core";
import { createChatQueue, type ChatQueue, type QueueItem, type RunEnding } from "@server/modules/chat-queue/chat-queue.service.js";

const NUM_RUNS = 200;

let q: ChatQueue;

/** How often each branch was reached over every case, so a property that never reaches one shows up. */
const seen = new Map<string, number>();

/**
 * Count one visit to a branch.
 * @param branch - Its name.
 */
function tally(branch: string): void {
  seen.set(branch, (seen.get(branch) ?? 0) + 1);
}

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // Already initialised by a sibling suite in this worker.
  }
  q = createChatQueue(getRedis());
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
  return { id, sentAt: "2026-11-12T08:00:00.000Z", userId: "u-1", acceptLanguage: "en", message: `words of ${id}` };
}

/**
 * The ids of some items.
 * @param list - Items.
 * @returns Their ids, in order.
 */
function idsOf(list: readonly QueueItem[]): string[] {
  return list.map((i) => i.id);
}

/**
 * Read a list key as item ids.
 * @param key - The list.
 * @returns The ids, in order.
 */
async function listIds(key: string): Promise<string[]> {
  return (await getRedis().lrange(key, 0, -1)).map((r) => (JSON.parse(r) as QueueItem).id);
}

/**
 * Type, content and whether a TTL is set, of each of the five keys.
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
    const pttl = await r.pttl(key);
    out[name] = { type, content, ttl: pttl > 0 ? "set" : pttl };
  }
  return out;
}

/** The message store a run writes to: opening rows and replies, as the conversation's rows would hold them. */
class FakeStore {
  /** Each opening row's turn, by message id. */
  readonly users = new Map<string, number>();
  /** Every reply in the order written, with the ids of the messages it holds as `user-message` parts. */
  readonly replies: Array<{ turn: number; fragments: string[] }> = [];
  /** How many times each message id was stored, as a row or a part. */
  readonly count = new Map<string, number>();
  private lastTurn = 0;

  /**
   * Note one more stored copy of a message.
   * @param id - Message id.
   */
  private bump(id: string): void {
    this.count.set(id, (this.count.get(id) ?? 0) + 1);
  }

  /**
   * Write an opening row; an id that already has one gets that row back.
   * @param id - Message id.
   * @returns The row's turn.
   */
  writeOpening(id: string): number {
    const had = this.users.get(id);
    if (had !== undefined) return had;
    this.lastTurn += 1;
    this.users.set(id, this.lastTurn);
    this.bump(id);
    return this.lastTurn;
  }

  /**
   * Write a reply into a turn.
   * @param turn - The turn it answers.
   * @param fragments - The ids of the messages it took in, in order.
   */
  writeReply(turn: number, fragments: readonly string[]): void {
    this.replies.push({ turn, fragments: [...fragments] });
    for (const f of fragments) this.bump(f);
  }

  /**
   * What `takenStatus` in the message repository answers for taken ids.
   * @param ids - The taken ids.
   * @returns The answered ids, and each unanswered opening row's turn.
   */
  takenStatus(ids: readonly string[]): { answered: Set<string>; unansweredRows: Map<string, number> } {
    const answered = new Set<string>();
    const unansweredRows = new Map<string, number>();
    let newest: { turn: number; fragments: string[] } | undefined;
    for (const r of this.replies) if (newest === undefined || r.turn >= newest.turn) newest = r;
    for (const id of ids) if (newest?.fragments.includes(id) === true) answered.add(id);
    for (const id of ids) {
      const turn = this.users.get(id);
      if (turn === undefined) continue;
      if (this.replies.some((r) => r.turn === turn)) answered.add(id);
      else if (!answered.has(id)) unansweredRows.set(id, turn);
    }
    return { answered, unansweredRows };
  }

  /**
   * The stored user messages in conversation order: each turn's opening row, then its replies' parts in order.
   * @returns Message ids.
   */
  order(): string[] {
    const out: string[] = [];
    for (let turn = 1; turn <= this.lastTurn; turn += 1) {
      for (const [id, t] of this.users) if (t === turn) out.push(id);
      for (const r of this.replies) if (r.turn === turn) out.push(...r.fragments);
    }
    return out;
  }
}

/** How a runner's turn ends: reply not stored, stopped at a questionnaire, shutdown, or any other end. */
type EndingKind = "done" | "failed" | "unsaved" | "awaiting" | "shutdown";
const ENDINGS: readonly EndingKind[] = ["done", "failed", "unsaved", "awaiting", "shutdown"];

/** Where a runner is in `runIt`; each position is one queue call or one store write. */
type At = "head" | "forget" | "head2" | "emptyAck" | "emptySettle" | "open" | "run" | "ack" | "settle";

/** One instance running the conversation's run. */
interface Runner {
  runId: string;
  at: At;
  taken: string[];
  answered: string[];
  also: string[];
  drained: string[];
  turn: number;
  ending: EndingKind;
}

/** One case's conversation, its runner and the facts the properties read. */
interface World {
  c: string;
  k: Keys;
  store: FakeStore;
  runner: Runner | null;
  /** Run ids that no longer hold the conversation. */
  stale: string[];
  used: string[];
  accepted: string[];
  withdrawn: Set<string>;
  cleared: Set<string>;
  /** The conversation was deleted: no more sends reach it. */
  closed: boolean;
  cardTurn: Map<string, number>;
  cards: number;
  /** A start was handed out while a runner held the conversation. */
  doubleStarts: number;
}

/** A property's id. */
type Pb = "PB-01" | "PB-02" | "PB-03" | "PB-04" | "PB-06" | "PB-07";

/** One generated operation. */
type Op =
  | { t: "send" }
  | { t: "resend"; pick: number }
  | { t: "claim" }
  | { t: "resume"; pick: number }
  | { t: "step"; pick: number }
  | { t: "stale"; call: "head" | "drain" | "ack" | "settle" | "forget"; pick: number; random: boolean }
  | { t: "remove"; pick: number; unknown: boolean }
  | { t: "crash" }
  | { t: "clear" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 12, arbitrary: fc.constant<Op>({ t: "send" }) },
  { weight: 6, arbitrary: fc.nat().map((pick): Op => ({ t: "resend", pick })) },
  { weight: 4, arbitrary: fc.constant<Op>({ t: "claim" }) },
  { weight: 3, arbitrary: fc.nat().map((pick): Op => ({ t: "resume", pick })) },
  { weight: 20, arbitrary: fc.nat().map((pick): Op => ({ t: "step", pick })) },
  {
    weight: 6,
    arbitrary: fc
      .record({ call: fc.constantFrom("head" as const, "drain" as const, "ack" as const, "settle" as const, "forget" as const), pick: fc.nat(), random: fc.boolean() })
      .map((r): Op => ({ t: "stale", ...r })),
  },
  { weight: 4, arbitrary: fc.record({ pick: fc.nat(), unknown: fc.boolean() }).map((r): Op => ({ t: "remove", ...r })) },
  { weight: 4, arbitrary: fc.constant<Op>({ t: "crash" }) },
  { weight: 1, arbitrary: fc.constant<Op>({ t: "clear" }) },
);

const opsArb = fc.array(opArb, { minLength: 1, maxLength: 60 });

/**
 * A fresh conversation with nothing in it.
 * @returns The case's world.
 */
function freshWorld(): World {
  const c = crypto.randomUUID();
  return {
    c,
    k: keysOf(c),
    store: new FakeStore(),
    runner: null,
    stale: [],
    used: [],
    accepted: [],
    withdrawn: new Set(),
    cleared: new Set(),
    closed: false,
    cardTurn: new Map(),
    cards: 0,
    doubleStarts: 0,
  };
}

/**
 * Take a run a start handed out, as the instance that got it does.
 * @param w - The world.
 * @param runId - The run.
 * @param card - The card's turn for a card's run; a run opened from the queue starts at its head.
 */
function adopt(w: World, runId: string, card?: number): void {
  if (w.runner !== null) w.doubleStarts += 1;
  w.runner = {
    runId,
    at: card === undefined ? "head" : "run",
    taken: [],
    answered: [],
    also: [],
    drained: [],
    turn: card ?? 0,
    ending: "done",
  };
}

/**
 * The run is over for its runner: its id goes stale.
 * @param w - The world.
 * @param r - The runner.
 */
function retire(w: World, r: Runner): void {
  w.stale.push(r.runId);
  w.runner = null;
}

/**
 * Advance the runner holding the conversation by one queue call or store write, as `runIt` and `afterTurn` do.
 * @param w - The world.
 * @param pick - Chooses between a drain and ending the turn, and how it ends.
 */
async function stepRunner(w: World, pick: number): Promise<void> {
  const r = w.runner;
  if (r === null) return;
  const { c } = w;
  switch (r.at) {
    case "head":
    case "head2": {
      const got = idsOf(await q.head(c, r.runId));
      if (got.length === 0) {
        r.at = "emptyAck";
        return;
      }
      if (r.at === "head") {
        const status = w.store.takenStatus(got);
        if (status.answered.size > 0) {
          r.answered = [...status.answered];
          tally("forget answered");
          r.at = "forget";
          return;
        }
      }
      r.taken = got;
      r.at = "open";
      return;
    }
    case "forget": {
      // One id that is not taken rides along; forget must ignore it.
      const got = idsOf(await q.forget(c, r.runId, [...r.answered, crypto.randomUUID()]));
      if (got.length === 0) {
        r.at = "head2";
        return;
      }
      r.taken = got;
      r.at = "open";
      return;
    }
    case "emptyAck":
      await q.ack(c, r.runId);
      r.at = "emptySettle";
      return;
    case "emptySettle": {
      // A message sent since the head opens the next run, as `runIt` does.
      const next = await q.settle(c, r.runId, { kind: "done" });
      retire(w, r);
      if (next !== null) {
        tally("empty settle opened next");
        adopt(w, next);
      }
      return;
    }
    case "open":
      if (w.store.users.has(r.taken[0]!)) tally("opening reused");
      r.turn = w.store.writeOpening(r.taken[0]!);
      r.also = r.taken.slice(1);
      r.at = "run";
      return;
    case "run": {
      if (pick % 3 === 0) {
        r.drained.push(...idsOf(await q.drain(c, r.runId)));
        return;
      }
      r.ending = ENDINGS[Math.floor(pick / 3) % ENDINGS.length]!;
      if (r.ending !== "unsaved") w.store.writeReply(r.turn, [...r.also, ...r.drained]);
      r.at = r.ending === "unsaved" ? "settle" : "ack";
      return;
    }
    case "ack":
      await q.ack(c, r.runId);
      r.at = "settle";
      return;
    case "settle": {
      let ending: RunEnding = { kind: r.ending === "awaiting" ? "done" : r.ending };
      if (r.ending === "awaiting") {
        const card = `card-${String(w.cards++)}`;
        w.cardTurn.set(card, r.turn);
        ending = { kind: "awaiting", toolCallId: card };
      }
      const next = await q.settle(c, r.runId, ending);
      tally(`ending ${r.ending}`);
      retire(w, r);
      if (next !== null) {
        tally("settle opened next");
        adopt(w, next);
      }
      return;
    }
  }
}

/**
 * Send a message and note whether it was accepted.
 * @param w - The world.
 * @param id - Its id.
 */
async function sendId(w: World, id: string): Promise<void> {
  const out = await q.enqueue(w.c, item(id));
  tally(`enqueue ${out.status}`);
  if (out.status === "start" || out.status === "queued") w.accepted.push(id);
  if (out.status === "start") adopt(w, out.runId);
}

/**
 * Answer a card, as the answer route does: take the conversation, then run the answer or hand it back.
 * @param w - The world.
 * @param refuse - Whether the answer is refused even when a card waits.
 */
async function answerCard(w: World, refuse: boolean): Promise<void> {
  const runId = crypto.randomUUID();
  const held = await q.resume(w.c, runId);
  if (held.status === "busy") return;
  if (w.runner !== null) w.doubleStarts += 1;
  if (held.awaiting !== null && !refuse) {
    w.runner = null;
    tally("card run");
    adopt(w, runId, w.cardTurn.get(held.awaiting));
    return;
  }
  const next = await q.giveBack(w.c, runId, held.awaiting);
  w.stale.push(runId);
  tally(next === null ? "give back freed" : "give back opened run");
  if (next !== null) adopt(w, next);
}

/**
 * Apply one generated operation.
 * @param w - The world.
 * @param op - The operation.
 */
async function apply(w: World, op: Op): Promise<void> {
  const { c, k } = w;
  switch (op.t) {
    case "send": {
      const id = crypto.randomUUID();
      w.used.push(id);
      await sendId(w, id);
      return;
    }
    case "resend":
      if (w.used.length === 0) return;
      await sendId(w, w.used[op.pick % w.used.length]!);
      return;
    case "claim": {
      const out = await q.claim(c);
      if (out.status === "start") {
        tally("claim start");
        adopt(w, out.runId);
      }
      return;
    }
    case "resume":
      await answerCard(w, op.pick % 3 === 0);
      return;
    case "step":
      await stepRunner(w, op.pick);
      return;
    case "stale":
      await staleCall(w, op);
      return;
    case "remove": {
      const id = op.unknown || w.used.length === 0 ? crypto.randomUUID() : w.used[op.pick % w.used.length]!;
      const removed = await q.remove(c, id);
      tally(`remove ${removed}`);
      if (removed === "removed") w.withdrawn.add(id);
      return;
    }
    case "crash": {
      const holder = w.runner?.runId ?? null;
      if (holder === null) return;
      await getRedis().del(k.active);
      tally("crash");
      w.stale.push(holder);
      w.runner = null;
      return;
    }
    case "clear": {
      const left = [...(await listIds(k.queue)), ...(await listIds(k.taken))];
      for (const id of left) if ((w.store.count.get(id) ?? 0) === 0) w.cleared.add(id);
      await q.clear(c);
      if (w.runner !== null) retire(w, w.runner);
      w.closed = true;
      return;
    }
  }
}

/**
 * A run-only script called with a run id that does not hold the conversation: it must change nothing and hand nothing back (PB-03).
 * @param w - The world.
 * @param op - Which script, with which stale or random id.
 */
async function staleCall(w: World, op: Extract<Op, { t: "stale" }>): Promise<void> {
  const { c, k } = w;
  const runId = op.random || w.stale.length === 0 ? crypto.randomUUID() : w.stale[op.pick % w.stale.length]!;
  const before = await snapshot(k);
  let got: unknown;
  if (op.call === "head") got = await q.head(c, runId);
  else if (op.call === "drain") got = await q.drain(c, runId);
  else if (op.call === "ack") got = await q.ack(c, runId);
  else if (op.call === "forget") {
    const taken = await listIds(k.taken);
    got = await q.forget(c, runId, [...taken.filter((_, i) => (op.pick >> i) % 2 === 1), crypto.randomUUID()]);
  } else {
    const kind = ENDINGS[op.pick % ENDINGS.length]!;
    got = await q.settle(c, runId, kind === "awaiting" ? { kind, toolCallId: "stale-card" } : { kind });
  }
  const after = await snapshot(k);
  tally(`stale ${op.call}`);
  lastStale = {
    op,
    runId,
    unchanged: JSON.stringify(before) === JSON.stringify(after),
    nothing: got === undefined || got === null || (Array.isArray(got) && got.length === 0),
  };
}

let lastStale: { op: Op; runId: string; unchanged: boolean; nothing: boolean } | null = null;

/** Queue and taken lists read off Redis around a step. */
interface Lists {
  queue: string[];
  taken: string[];
  active: string | null;
}

/**
 * Read the lists a property checks.
 * @param k - The keys.
 * @returns The queue, the taken list and the run that holds the conversation.
 */
async function lists(k: Keys): Promise<Lists> {
  return { queue: await listIds(k.queue), taken: await listIds(k.taken), active: await getRedis().get(k.active) };
}

/**
 * Every id accepted, once each, in order of first acceptance.
 * @param w - The world.
 * @returns The ids.
 */
function acceptedOnce(w: World): string[] {
  return [...new Set(w.accepted)];
}

/**
 * Check one property after a step.
 * @param pb - Which property.
 * @param w - The world after the step.
 * @param before - The lists before the step.
 * @param after - The lists after it.
 * @param what - The step, for the message.
 * @throws {Error} When the property does not hold.
 */
function checkStep(pb: Pb, w: World, before: Lists, after: Lists, what: string): void {
  const stored = (id: string): number => w.store.count.get(id) ?? 0;
  switch (pb) {
    case "PB-01":
      for (const id of acceptedOnce(w)) {
        const inQueue = after.queue.filter((x) => x === id).length;
        const inTaken = after.taken.filter((x) => x === id).length;
        const places = [inQueue > 0, inTaken > 0, stored(id) > 0, w.withdrawn.has(id), w.cleared.has(id)].filter(Boolean).length;
        const takenAndStored = places === 2 && inTaken > 0 && stored(id) > 0;
        expect({ what, id, inQueue, inTaken, stored: stored(id), places, ok: (places === 1 || takenAndStored) && inQueue <= 1 && inTaken <= 1 }).toMatchObject({ ok: true });
        expect(stored(id), `${what}: ${id} stored more than once`).toBeLessThanOrEqual(1);
      }
      return;
    case "PB-02": {
      const order = w.store.order();
      expect({ what, order }).toEqual({ what, order: acceptedOnce(w).filter((id) => stored(id) > 0) });
      return;
    }
    case "PB-03":
      expect({ what, doubleStarts: w.doubleStarts }).toEqual({ what, doubleStarts: 0 });
      expect({ what, active: after.active }).toEqual({ what, active: w.runner?.runId ?? null });
      if (lastStale !== null) expect({ what, stale: lastStale }).toMatchObject({ stale: { unchanged: true, nothing: true } });
      return;
    case "PB-04":
      for (const id of before.taken) {
        if (after.taken.includes(id) || what.startsWith("clear")) continue;
        expect({ what, id, stored: stored(id) }, "a taken id was dropped before its reply was stored").toMatchObject({ stored: 1 });
      }
      if (what.startsWith("crash")) expect({ what, taken: after.taken }).toEqual({ what, taken: before.taken });
      return;
    case "PB-06":
      expect({ what, queue: after.queue }).toEqual({ what, queue: [...new Set(after.queue)] });
      for (const id of w.used) expect(stored(id), `${what}: ${id} stored more than once`).toBeLessThanOrEqual(1);
      return;
    case "PB-07":
      expect(after.queue.length, what).toBeLessThanOrEqual(QUEUE_MAX);
      return;
  }
}

/**
 * Run one step with the property checked around it.
 * @param pb - Which property.
 * @param w - The world.
 * @param what - The step, for the message.
 * @param run - The step.
 */
async function checked(pb: Pb, w: World, what: string, run: () => Promise<void>): Promise<void> {
  const before = await lists(w.k);
  lastStale = null;
  await run();
  checkStep(pb, w, before, await lists(w.k), what);
}

/**
 * Go on after the sequence until no work is left: the runner finishes its run, claims open runs for what waits, a waiting card is answered, and a run id no runner took runs out.
 * @param pb - Which property.
 * @param w - The world.
 * @throws {Error} When the conversation never comes to rest.
 */
async function finish(pb: Pb, w: World): Promise<void> {
  if (w.closed) return;
  for (let i = 0; i < 500; i += 1) {
    if (w.runner !== null) {
      // pick 1: no drain, and the turn ends `done`.
      await checked(pb, w, `finish step ${w.runner.at}`, () => stepRunner(w, 1));
      continue;
    }
    const claimed = await q.claim(w.c);
    if (claimed.status === "start") {
      adopt(w, claimed.runId);
      continue;
    }
    if (claimed.status === "awaiting") {
      await checked(pb, w, "finish answer card", () => answerCard(w, false));
      continue;
    }
    expect(claimed.status, "claim says running while no runner holds the conversation").toBe("idle");
    return;
  }
  throw new Error("the conversation never came to rest");
}

/**
 * Check one property once no work is left.
 * @param pb - Which property.
 * @param w - The world.
 * @throws {Error} When the property does not hold.
 */
async function checkEnd(pb: Pb, w: World): Promise<void> {
  const end = await lists(w.k);
  const stored = (id: string): number => w.store.count.get(id) ?? 0;
  if (pb === "PB-01") {
    if (!w.closed) expect({ queue: end.queue, taken: end.taken }).toEqual({ queue: [], taken: [] });
    for (const id of acceptedOnce(w)) {
      const fates = [stored(id) === 1, w.withdrawn.has(id), w.cleared.has(id)].filter(Boolean).length;
      expect({ id, stored: stored(id), withdrawn: w.withdrawn.has(id), cleared: w.cleared.has(id), fates }).toMatchObject({ fates: 1 });
    }
  }
  if (pb === "PB-02") {
    expect(w.store.order()).toEqual(acceptedOnce(w).filter((id) => !w.withdrawn.has(id) && !w.cleared.has(id)));
  }
}

/**
 * Run a property over random sequences.
 * @param pb - Which property.
 */
async function property(pb: Pb): Promise<void> {
  await fc.assert(
    fc.asyncProperty(opsArb, async (ops) => {
      const w = freshWorld();
      for (const [i, op] of ops.entries()) {
        if (w.closed) break;
        await checked(pb, w, `${op.t}#${String(i)}${op.t === "step" ? ` at ${w.runner?.at ?? "-"}` : ""}`, () => apply(w, op));
      }
      await finish(pb, w);
      await checkEnd(pb, w);
      await q.clear(w.c);
    }),
    { numRuns: NUM_RUNS },
  );
}

describe("chat queue properties (inner#1717)", () => {
  it("puts every accepted message in exactly one place at every step, and stores it once in the end (PB-01)", async () => {
    await property("PB-01");
  }, 600_000);

  it("stores user messages in the order they were accepted, less those taken back (PB-02)", async () => {
    await property("PB-02");
  }, 600_000);

  it("lets only the run that holds the conversation act; a stale run id changes nothing (PB-03)", async () => {
    await property("PB-03");
  }, 600_000);

  it("drops a taken message only after the reply that holds it is stored, and keeps it across a crash (PB-04)", async () => {
    await property("PB-04");
  }, 600_000);

  it("keeps one queue entry and at most one stored copy for an id sent again (PB-06)", async () => {
    await property("PB-06");
  }, 600_000);

  it("never lets the queue grow past chat_queue_max (PB-07)", async () => {
    await property("PB-07");
  }, 600_000);

  it("reached every branch the properties are about across the cases above", () => {
    const branches = [
      "enqueue start", "enqueue queued", "enqueue duplicate", "enqueue full", "claim start", "forget answered",
      "opening reused", "empty settle opened next", "settle opened next", "card run", "give back freed", "give back opened run",
      "crash", "remove removed", "remove taken", "remove gone", "stale head", "stale drain", "stale ack", "stale settle",
      "stale forget", "ending done", "ending failed", "ending unsaved", "ending awaiting", "ending shutdown",
    ];
    expect(branches.filter((b) => (seen.get(b) ?? 0) === 0), JSON.stringify(Object.fromEntries(seen))).toEqual([]);
  });
});
