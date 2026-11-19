// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation pins on the frame grid (inner#1306 test plan §66 P01, P02, P04; frames-split design §7.15 钉住行、事件表、不变量,
 * §10.12 rows for `0115_presentation_pins.sql`, `presentation-pin.repo.ts`, `presentation-pin.service.ts`,
 * `storage-reclaim.repo.ts`).
 *
 * What changes from the ledger pins:
 *   - a `candidate` row is keyed by (holder kind, holder id) alone: its `tool_input_id` may be null and one candidate job
 *     has one live row whatever toolInputId it records;
 *   - `Add` appends one object key to the holder's existing row (the same row, no soft-deleted copy);
 *   - `Mv` of the `selected` row replaces its object set as a whole, in place: a canonical key has exactly one selected row,
 *     its toolInputId and versionId updated on it; an object both bundles share is never registered;
 *   - a `derived` reclaim row carries its canonical key in `kept_storage_key` (required for `derived` rows).
 *
 * Names the design leaves open and this file proposes: `presentationPinService.add(holder, keys, tx?)` for `Add`, and
 * `acquire` taking `toolInputId: null` for a candidate.
 */
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, initCore, loadLocales } from "@breatic/core";
import * as domain from "@domain/index.js";

type HolderKind = "execution" | "analysis" | "prepared" | "candidate";
interface PinService {
  acquire(pin: { holderKind: HolderKind; holderId: string; toolInputId: string | null; preparedKey?: string; objectKeys: string[] }): Promise<void>;
  add(holder: { holderKind: HolderKind; holderId: string }, keys: string[]): Promise<void>;
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
  pg = createPgClient(inject("DATABASE_URL"), { name: "frame-grid-pins", max: 4 });
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/**
 * The pin service, read at call time so a missing member fails each case on its own.
 * @returns It.
 */
function pins(): PinService {
  const service = (domain as Record<string, unknown>).presentationPinService as PinService | undefined;
  expect(service, "presentationPinService is exported from @breatic/domain").toBeTypeOf("object");
  return service!;
}

/**
 * The `Add` event of the pin service.
 * @returns It.
 */
function add(): PinService["add"] {
  const fn = (pins() as unknown as Record<string, unknown>).add;
  expect(fn, "presentationPinService.add (the Add event) exists").toBeTypeOf("function");
  return fn as PinService["add"];
}

/**
 * A fresh canonical key and the key of one of its derived objects.
 * @returns Keys.
 */
function source(): { key: string; object: (name: string) => string } {
  const key = `video/grid-pins/${randomUUID()}.mp4`;
  return { key, object: (name) => `${key}.${name}` };
}

/**
 * Every pin row of a holder, live or released, with its keys.
 * @param holderId - The holder.
 * @returns The rows.
 */
async function rows(holderId: string): Promise<{ id: string; holder_kind: string; tool_input_id: string | null; version_id: string | null; live: boolean; keys: string[] }[]> {
  return pg`SELECT p.id,p.holder_kind,p.tool_input_id,p.version_id,p.deleted_at IS NULL AS live,
      coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL), '{}') AS keys
    FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
    WHERE p.holder_id=${holderId} GROUP BY p.id ORDER BY p.created_at,p.id`;
}

/**
 * The `derived` queue rows of a canonical key's objects.
 * @param prefix - The canonical key.
 * @returns Each row's key and kept (canonical) key, sorted.
 */
async function queued(prefix: string): Promise<{ storage_key: string; kept_storage_key: string | null }[]> {
  return pg`SELECT storage_key,kept_storage_key FROM storage_reclaim_queue WHERE kind='derived' AND starts_with(storage_key, ${prefix}) ORDER BY storage_key`;
}

describe("Add and the candidate row (§66 P01; design §7.15 钉住行)", () => {
  it("P01: a candidate pin records no toolInputId and is one live row for its job", async () => {
    const s = source(); const job = `pres-${randomUUID()}`;
    await pins().acquire({ holderKind: "candidate", holderId: job, toolInputId: null, objectKeys: [s.object("edit.mp4")] });
    expect((await rows(job)).map(({ holder_kind, tool_input_id, live, keys }) => ({ holder_kind, tool_input_id, live, keys })))
      .toEqual([{ holder_kind: "candidate", tool_input_id: null, live: true, keys: [s.object("edit.mp4")] }]);
  });

  it("P01: Add appends a new object key to the holder's existing row, without replacing the row", async () => {
    const s = source(); const job = `pres-${randomUUID()}`;
    await pins().acquire({ holderKind: "candidate", holderId: job, toolInputId: null, objectKeys: [s.object("chunk-0.mp4")] });
    const [before] = await rows(job);
    await add()({ holderKind: "candidate", holderId: job }, [s.object("chunk-1.mp4")]);
    await add()({ holderKind: "candidate", holderId: job }, [s.object("chunk-1.mp4")]);
    const after = await rows(job);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before!.id, live: true, keys: [s.object("chunk-0.mp4"), s.object("chunk-1.mp4")] });
    expect(await pins().isKeyPinned(s.object("chunk-1.mp4"))).toBe(true);
  });

  it("P01: Add to an execution holder appends to its row in place", async () => {
    const s = source(); const task = randomUUID();
    await pins().acquire({ holderKind: "execution", holderId: task, toolInputId: T, objectKeys: [s.object("edit.mp4")] });
    await add()({ holderKind: "execution", holderId: task }, [s.object("track_join.json")]);
    const after = await rows(task);
    expect(after.map(({ live, keys }) => ({ live, keys }))).toEqual([{ live: true, keys: [s.object("edit.mp4"), s.object("track_join.json")] }]);
  });
});

describe("Mv replaces the selected set as a whole, in place (§66 P01; design §7.15 Mv 列)", () => {
  it("P01: a canonical key has exactly one selected row; Mv updates its version and replaces its object set", async () => {
    const s = source();
    const v1 = [s.object("play-v1.mp4"), s.object("manifest-v1.json"), s.object("edit.mp4")];
    const v2 = [s.object("play-v2.mp4"), s.object("edit.mp4")];
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: v1 });
    await pins().select({ canonicalKey: s.key, toolInputId: T2, versionId: "f".repeat(64), objectKeys: v2 });
    const all = await rows(s.key);
    expect(all.map(({ holder_kind, tool_input_id, version_id, live, keys }) => ({ holder_kind, tool_input_id, version_id, live, keys })))
      .toEqual([{ holder_kind: "selected", tool_input_id: T2, version_id: "f".repeat(64), live: true, keys: [...v2].sort() }]);
  });

  it("P01: the objects the old bundle alone held are registered with their canonical key; a shared edit file is not", async () => {
    const s = source();
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "e".repeat(64), objectKeys: [s.object("play-v1.mp4"), s.object("edit.mp4")] });
    await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: "f".repeat(64), objectKeys: [s.object("play-v2.mp4"), s.object("edit.mp4")] });
    expect(await queued(s.key)).toEqual([{ storage_key: s.object("play-v1.mp4"), kept_storage_key: s.key }]);
    expect(await pins().isKeyPinned(s.object("edit.mp4"))).toBe(true);
  });
});

describe("pin table structure after 0115 is changed in place (§66 P04; design §7.15, §10.12 0115 row)", () => {
  it("P04: presentation_pins.tool_input_id is nullable", async () => {
    const [column] = await pg<{ is_nullable: string }[]>`SELECT is_nullable FROM information_schema.columns
      WHERE table_name='presentation_pins' AND column_name='tool_input_id'`;
    expect(column).toEqual({ is_nullable: "YES" });
  });

  it("P04: two live candidate rows of one job violate the (holder kind, holder id) unique key, whatever their toolInputIds", async () => {
    const job = `pres-${randomUUID()}`;
    await pg`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id) VALUES ('candidate',${job},${T})`;
    await expect(pg`INSERT INTO presentation_pins (holder_kind,holder_id,tool_input_id) VALUES ('candidate',${job},${T2})`).rejects.toMatchObject({ code: "23505" });
  });

  it("P04: a derived reclaim row requires its canonical key in kept_storage_key", async () => {
    const key = `video/grid-pins/${randomUUID()}.mp4.orphan`;
    await expect(pg`INSERT INTO storage_reclaim_queue (storage_key,kind) VALUES (${key},'derived')`).rejects.toMatchObject({ code: "23514" });
  });
});

describe("pin and registration invariants with Add and Mv (§66 P02; critical path: data integrity)", () => {
  type Op =
    | { kind: "acquire"; holder: number; keys: number[] }
    | { kind: "add"; holder: number; keys: number[] }
    | { kind: "release"; holder: number }
    | { kind: "select"; version: number; keys: number[] };
  const keyIndex = fc.integer({ min: 0, max: 5 });
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("acquire" as const), holder: fc.integer({ min: 0, max: 2 }), keys: fc.uniqueArray(keyIndex, { maxLength: 3 }) }),
    fc.record({ kind: fc.constant("add" as const), holder: fc.integer({ min: 0, max: 2 }), keys: fc.uniqueArray(keyIndex, { minLength: 1, maxLength: 2 }) }),
    fc.record({ kind: fc.constant("release" as const), holder: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("select" as const), version: fc.integer({ min: 0, max: 2 }), keys: fc.uniqueArray(keyIndex, { maxLength: 3 }) }),
  );

  it("P02: a key is pinned exactly while some live row references it, it is registered exactly when it lost its last reference, and a selected change that keeps an object never registers it", async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { maxLength: 10 }), async (ops) => {
      const s = source();
      const holders = [randomUUID(), randomUUID(), randomUUID()];
      const keys = Array.from({ length: 6 }, (_, i) => s.object(`object-${i}`));
      const held = new Map<string, Set<string>>();
      let selected: Set<string> | null = null;
      const expectedQueued = new Set<string>();
      const referenced = (): Set<string> => new Set([...[...held.values()].flatMap((set) => [...set]), ...(selected ?? [])]);
      for (const step of ops) {
        const before = referenced();
        if (step.kind === "acquire") {
          const objectKeys = step.keys.map((i) => keys[i]!);
          await pins().acquire({ holderKind: "candidate", holderId: holders[step.holder]!, toolInputId: null, objectKeys });
          held.set(holders[step.holder]!, new Set([...(held.get(holders[step.holder]!) ?? []), ...objectKeys]));
        } else if (step.kind === "add") {
          // Add only appends to a holder that has acquired its row.
          if (!held.has(holders[step.holder]!)) continue;
          const objectKeys = step.keys.map((i) => keys[i]!);
          await add()({ holderKind: "candidate", holderId: holders[step.holder]! }, objectKeys);
          held.set(holders[step.holder]!, new Set([...held.get(holders[step.holder]!)!, ...objectKeys]));
        } else if (step.kind === "release") {
          await pins().release({ holderKind: "candidate", holderId: holders[step.holder]! });
          held.delete(holders[step.holder]!);
        } else {
          const objectKeys = step.keys.map((i) => keys[i]!);
          await pins().select({ canonicalKey: s.key, toolInputId: T, versionId: String(step.version).repeat(64), objectKeys });
          selected = new Set(objectKeys);
        }
        const after = referenced();
        for (const key of before) if (!after.has(key)) expectedQueued.add(key);
        for (const key of keys) expect(await pins().isKeyPinned(key)).toBe(after.has(key));
      }
      expect(new Set((await queued(s.key)).map((row) => row.storage_key))).toEqual(expectedQueued);
      const selectedRows = await rows(s.key);
      expect(selectedRows.length).toBe(selected === null ? 0 : 1);
    }), { seed: 1306, numRuns: 25 });
  });
});
