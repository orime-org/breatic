// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation pins and `derived` reclaim registration (S6e E4, inner#1306 test plan §90 E4-3, E4-4, E4-8; frames-split
 * design §7.15 钉住行、唯一写点、事件表与不变量).
 *
 * The pin service is the only writer of `presentation_pins` and `presentation_pin_objects`; it is also where a released
 * key is registered for offline reclaim as a `derived` queue row, and only when no live pin references it any more.
 * Invariants checked here (§7.15 不变量):
 *   - a key is pinned exactly when a live row references it (`isKeyPinned`);
 *   - `Rel` soft-deletes and registers each key that lost its last live reference, once; a key still referenced by
 *     another live pin is not registered;
 *   - `Acq` of the same holder and toolInputId is idempotent;
 *   - one live `selected` row per canonical key; moving it to t' registers L(t) only when nothing else pins it, and
 *     keeping t (only the carrier changed) releases nothing of L;
 *   - the P descriptor pointer and the source object are never registered.
 *
 * Service and field names are the test author's choices recorded in §90 (open to veto).
 */
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, db, initCore, loadLocales, type DbTx } from "@breatic/core";
import * as domain from "@domain/index.js";

type HolderKind = "execution" | "analysis" | "prepared" | "candidate";
interface PinService {
  acquire(pin: { holderKind: HolderKind; holderId: string; toolInputId: string; preparedKey?: string; objectKeys: string[] }): Promise<void>;
  select(pin: { canonicalKey: string; toolInputId: string; versionId: string; objectKeys: string[] }): Promise<void>;
  release(holder: { holderKind: HolderKind; holderId: string }): Promise<void>;
  isKeyPinned(storageKey: string): Promise<boolean>;
}

let pg: ReturnType<typeof createPgClient>;
const T = "c".repeat(64);
const T2 = "b".repeat(64);

beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", UPLOAD_BASE_URL: "https://assets.example.test" });
  loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "presentation-pins", max: 4 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/**
 * The pin service, read at call time so a missing export fails each case on its own.
 * @returns It.
 */
function pins(): PinService {
  const service = (domain as Record<string, unknown>).presentationPinService as PinService | undefined;
  expect(service, "presentationPinService is exported from @breatic/domain").toBeTypeOf("object");
  return service!;
}

/**
 * A fresh source with the keys of its ledgers, descriptor pointer and work objects.
 * @returns Keys.
 */
function source(): { key: string; full: (t: string) => string; table: (t: string) => string; descriptor: string; work: (job: string) => string } {
  const key = `video/pins/${randomUUID()}.mp4`;
  return { key, full: (t) => `${key}.video-source-ledger.${t}.json`, table: (t) => `${key}.video-presentation-table.${t}.json`,
    descriptor: `${key}.video-presentation.v1.json`, work: (job) => `${key}.${job}` };
}

/**
 * The `derived` queue rows of a source, by key.
 * @param prefix - The source key.
 * @returns Sorted keys.
 */
async function queued(prefix: string): Promise<string[]> {
  const rows = await pg<{ storage_key: string; kind: string; kept_storage_key: string | null; studio_id: string | null }[]>`
    SELECT storage_key,kind,kept_storage_key,studio_id FROM storage_reclaim_queue WHERE starts_with(storage_key, ${prefix}) ORDER BY storage_key`;
  for (const row of rows) expect(row).toMatchObject({ kind: "derived", kept_storage_key: null, studio_id: null });
  return rows.map((row) => row.storage_key);
}

/**
 * The live pin rows of a holder.
 * @param holderId - The holder.
 * @returns Rows with their keys.
 */
async function live(holderId: string): Promise<{ holder_kind: string; tool_input_id: string; prepared_key: string | null; version_id: string | null; keys: string[] }[]> {
  return pg`SELECT p.holder_kind,p.tool_input_id,p.prepared_key,p.version_id,
      coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL), '{}') AS keys
    FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
    WHERE p.holder_id=${holderId} AND p.deleted_at IS NULL GROUP BY p.id ORDER BY p.tool_input_id`;
}

describe("Acq, Rel and Chk (design §7.15 事件表)", () => {
  it("PN01 an execution pin records its holder, toolInputId and every referenced key; a repeated Acq is idempotent", async () => {
    const s = source(); const task = randomUUID();
    const objectKeys = [s.full(T), s.table(T)];
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys });
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys });
    expect(await live(task)).toEqual([{ holder_kind: "execution", tool_input_id: T, prepared_key: null, version_id: null, keys: [...objectKeys].sort() }]);
    for (const key of objectKeys) expect(await pins().isKeyPinned(key)).toBe(true);
    expect(await pins().isKeyPinned(s.full(T2))).toBe(false);
  });

  it("PN02 Rel soft-deletes the rows and registers each key that lost its last live reference as derived", async () => {
    const s = source(); const task = randomUUID();
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    await pins().release({ holderKind: "execution", holderId: task });
    expect(await live(task)).toEqual([]);
    const [kept] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM presentation_pins WHERE holder_id=${task} AND deleted_at IS NOT NULL`;
    expect(kept!.n).toBe(1);
    expect(await pins().isKeyPinned(s.full(T))).toBe(false);
    expect(await queued(s.key)).toEqual([s.full(T), s.table(T)].sort());
    await pins().release({ holderKind: "execution", holderId: task });
    expect(await queued(s.key)).toEqual([s.full(T), s.table(T)].sort());
  });

  it("PN03 a key still referenced by another live pin is not registered when one holder releases it", async () => {
    const s = source(); const a = randomUUID(); const b = randomUUID();
    await pins().acquire({ holderKind: "execution", holderId: a, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    await pins().acquire({ holderKind: "analysis", holderId: b, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    await pins().release({ holderKind: "execution", holderId: a });
    expect(await queued(s.key)).toEqual([]);
    expect(await pins().isKeyPinned(s.full(T))).toBe(true);
    await pins().release({ holderKind: "analysis", holderId: b });
    expect(await queued(s.key)).toEqual([s.full(T), s.table(T)].sort());
  });

  it("PN04 a prepared pin names its prepared key; releasing one kind of a holder leaves its other kind live", async () => {
    const s = source(); const task = randomUUID(); const prepared = s.work(`${task}:prep:0:a1`);
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    await pins().acquire({ holderKind: "prepared", holderId: task, toolInputId: T, preparedKey: prepared, objectKeys: [prepared] });
    expect((await live(task)).map((row) => [row.holder_kind, row.prepared_key])).toEqual(expect.arrayContaining([["execution", null], ["prepared", prepared]]));
    await pins().release({ holderKind: "prepared", holderId: task });
    expect(await queued(s.key)).toEqual([prepared]);
    expect(await pins().isKeyPinned(s.full(T))).toBe(true);
  });
});

describe("the selected pin (design §7.15 selected 行与 Mv)", () => {
  it("PN05 the first selection acquires one row for the canonical key with its version", async () => {
    const s = source(); const carrier = s.work("carrier-v1.mp4");
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: [s.full(T), s.table(T), carrier] });
    expect(await live(s.key)).toEqual([{ holder_kind: "selected", tool_input_id: T, prepared_key: null, version_id: "e".repeat(64), keys: [s.full(T), s.table(T), carrier].sort() }]);
  });

  it("PN06 moving to t' keeps one live row and registers L(t) and the old version's objects when nothing else pins them", async () => {
    const s = source(); const oldCarrier = s.work("carrier-v1.mp4"); const newCarrier = s.work("carrier-v2.mp4");
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: [s.full(T), s.table(T), oldCarrier] });
    await pins().select({ canonicalKey: s.key, toolInputId: T2, versionId: "f".repeat(64), objectKeys: [s.full(T2), s.table(T2), newCarrier] });
    expect(await live(s.key)).toEqual([{ holder_kind: "selected", tool_input_id: T2, prepared_key: null, version_id: "f".repeat(64), keys: [s.full(T2), s.table(T2), newCarrier].sort() }]);
    expect(await queued(s.key)).toEqual([oldCarrier, s.full(T), s.table(T)].sort());
  });

  it("PN07 moving while an execution still pins L(t) registers only the old version's own objects", async () => {
    const s = source(); const task = randomUUID(); const oldCarrier = s.work("carrier-v1.mp4");
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: [s.full(T), s.table(T), oldCarrier] });
    await pins().select({ canonicalKey: s.key, toolInputId: T2, versionId: "f".repeat(64), objectKeys: [s.full(T2), s.table(T2)] });
    expect(await queued(s.key)).toEqual([oldCarrier]);
  });

  it("PN08 a new version of the same toolInputId (only the carrier changed) releases nothing of L", async () => {
    const s = source(); const oldCarrier = s.work("carrier-v1.mp4"); const newCarrier = s.work("carrier-v2.mp4");
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: [s.full(T), s.table(T), oldCarrier] });
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "f".repeat(64), objectKeys: [s.full(T), s.table(T), newCarrier] });
    expect(await queued(s.key)).toEqual([oldCarrier]);
    expect(await pins().isKeyPinned(s.full(T))).toBe(true);
  });

  it("PN09 the descriptor pointer and the source object are never pinned objects nor registered, whatever the caller passes", async () => {
    const s = source();
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: [s.full(T), s.table(T), s.descriptor, s.key] });
    await pins().select({ canonicalKey: s.key, toolInputId: T2, versionId: "f".repeat(64), objectKeys: [s.full(T2), s.table(T2), s.descriptor, s.key] });
    expect(await queued(s.key)).toEqual([s.full(T), s.table(T)].sort());
    const [refs] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM presentation_pin_objects WHERE storage_key IN (${s.descriptor}, ${s.key})`;
    expect(refs!.n).toBe(0);
  });

  it("PN10 two concurrent first selections of one canonical key leave one live row", async () => {
    const s = source();
    await Promise.allSettled([
      pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: [s.full(T)] }),
      pins().select({ canonicalKey: s.key, toolInputId: T2, versionId: "f".repeat(64), objectKeys: [s.full(T2)] }),
    ]);
    expect(await live(s.key)).toHaveLength(1);
  });
});

describe("pin and registration invariants over any event sequence (critical path: data integrity)", () => {
  type Op =
    | { kind: "acquire"; holder: number; t: number; keys: number[] }
    | { kind: "release"; holder: number }
    | { kind: "select"; t: number; version: number; keys: number[] };
  const keyIndex = fc.integer({ min: 0, max: 5 });
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("acquire" as const), holder: fc.integer({ min: 0, max: 2 }), t: fc.integer({ min: 0, max: 1 }), keys: fc.uniqueArray(keyIndex, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant("release" as const), holder: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("select" as const), t: fc.integer({ min: 0, max: 1 }), version: fc.integer({ min: 0, max: 2 }), keys: fc.uniqueArray(keyIndex, { maxLength: 3 }) }),
  );

  it("PN11 a key is pinned exactly when a live pin references it, and it is registered exactly when it lost its last reference", async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 8 }), async (ops) => {
      const s = source();
      const holders = [randomUUID(), randomUUID(), randomUUID()];
      const ts = [T, T2];
      const keys = Array.from({ length: 6 }, (_, i) => s.work(`object-${i}`));
      const held = new Map<string, Set<string>>();
      let selected: Set<string> | null = null;
      const expectedQueued = new Set<string>();
      const referenced = (): Set<string> => new Set([...[...held.values()].flatMap((set) => [...set]), ...(selected ?? [])]);
      for (const step of ops) {
        const before = referenced();
        if (step.kind === "acquire") {
          const id = `${holders[step.holder]}|${ts[step.t]}`;
          const objectKeys = step.keys.map((i) => keys[i]!);
          await pins().acquire({ holderKind: "execution", holderId: holders[step.holder]!, toolInputId: ts[step.t]!, objectKeys });
          held.set(id, new Set([...(held.get(id) ?? []), ...objectKeys]));
        } else if (step.kind === "release") {
          await pins().release({ holderKind: "execution", holderId: holders[step.holder]! });
          for (const id of [...held.keys()]) if (id.startsWith(`${holders[step.holder]}|`)) held.delete(id);
        } else {
          const objectKeys = step.keys.map((i) => keys[i]!);
          await pins().select({ canonicalKey: s.key, toolInputId: ts[step.t]!, versionId: String(step.version).repeat(64), objectKeys });
          selected = new Set(objectKeys);
        }
        const after = referenced();
        for (const key of before) if (!after.has(key)) expectedQueued.add(key);
        for (const key of keys) expect(await pins().isKeyPinned(key)).toBe(after.has(key));
      }
      expect(new Set(await queued(s.key))).toEqual(expectedQueued);
    }), { seed: 1306, numRuns: 25 });
  });
});

// inner#1306 test plan §97 D17-7 (b) (frames-split §7.15 唯一写点 and the execution holder row; §7.17 lip-sync note): the
// worker registers each lip-sync intermediate object (RLE, transform table, person video, stem, generation result) by
// appending its key to the run's `execution` pin child rows inside the registration transaction, through the repository's
// one writer `appendExecutionPinObjects(taskId, keys, tx)`; a later `Chk` keeps those keys, and releasing the execution pin
// registers them for reclaim with the ledgers.
describe("appending lip-sync intermediates to the execution pin (§97 D17-7)", () => {
  type Append = (taskId: string, keys: readonly string[], tx: DbTx) => Promise<void>;
  /**
   * The repository writer, read by name so this file compiles before it exists.
   * @returns It.
   */
  const append = async (): Promise<Append> => {
    const repo = await import("@domain/presentation/presentation-pin.repo.js") as Record<string, unknown>;
    expect(repo.appendExecutionPinObjects, "appendExecutionPinObjects is exported by the pin repository").toBeTypeOf("function");
    return repo.appendExecutionPinObjects as Append;
  };

  it("PA01 keys appended in the registration transaction are on the execution pin when it commits, and Chk keeps them", async () => {
    const s = source(); const task = randomUUID();
    const intermediates = [s.work(`${"a".repeat(64)}:70000000-0000-4000-8000-000000000001`), s.work(`${"b".repeat(64)}:70000000-0000-4000-8000-000000000002`)];
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    const write = await append();
    await db.transaction(async (tx) => { await write(task, intermediates, tx); });
    expect(await live(task)).toEqual([{ holder_kind: "execution", tool_input_id: T, prepared_key: null, version_id: null, keys: [s.full(T), s.table(T), ...intermediates].sort() }]);
    for (const key of intermediates) expect(await pins().isKeyPinned(key)).toBe(true);
    expect(await queued(s.key)).toEqual([]);
  });

  it("PA02 keys appended in a registration transaction that rolls back are not pinned", async () => {
    const s = source(); const task = randomUUID(); const key = s.work(`${"c".repeat(64)}:70000000-0000-4000-8000-000000000003`);
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    const write = await append();
    await expect(db.transaction(async (tx) => { await write(task, [key], tx); throw new Error("registration failed"); })).rejects.toThrow("registration failed");
    expect(await pins().isKeyPinned(key)).toBe(false);
  });

  it("PA03 releasing the execution pin registers the appended keys with the ledgers", async () => {
    const s = source(); const task = randomUUID(); const key = s.work(`${"d".repeat(64)}:70000000-0000-4000-8000-000000000004`);
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys: [s.full(T), s.table(T)] });
    const write = await append();
    await db.transaction(async (tx) => { await write(task, [key], tx); });
    await pins().release({ holderKind: "execution", holderId: task });
    expect(await queued(s.key)).toEqual([s.full(T), s.table(T), key].sort());
  });
});
