// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `Drop`: a stitch's chunks leave the pin of whoever recorded the stitch (inner#1306 test plan §65.2 V08; frames-split
 * design §7.15 钉住行事件 `Drop` column, 唯一写点 and 回收队列 rows, §7.1.1).
 *
 * In the transaction that records a stitch receipt, the chunk keys it used are removed from the holder's child rows —
 * an execution, an analysis, or a presentation `candidate` (the DO's candidate stitch, done by the worker that handles
 * the stitch stage event) — and each chunk no live pin references any more is registered as a `derived` reclaim row;
 * the stitch result stays pinned; a repeated `Drop` is idempotent. The service's existing write point for the execution
 * and analysis holders is `retire`; the candidate holder is the new case.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, db, initCore, loadLocales, type DbTx } from "@breatic/core";
import * as domain from "@domain/index.js";

type Holder = { holderKind: "execution" | "analysis" | "candidate"; holderId: string };
interface PinService {
  acquire(pin: Holder & { toolInputId: string; objectKeys: string[] }): Promise<void>;
  retire(holder: Holder, keys: readonly string[], tx: DbTx): Promise<void>;
  isKeyPinned(storageKey: string): Promise<boolean>;
}

let pg: ReturnType<typeof createPgClient>;
const T = "c".repeat(64);

beforeAll(() => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", UPLOAD_BASE_URL: "https://assets.example.test" });
  loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "presentation-pin-drop", max: 2 });
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
 * The `derived` queue rows under a prefix.
 * @param prefix - The source key.
 * @returns Sorted keys.
 */
async function queued(prefix: string): Promise<string[]> {
  const rows = await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE kind='derived' AND starts_with(storage_key, ${prefix}) ORDER BY storage_key`;
  return rows.map((row) => row.storage_key);
}

describe("V08 Drop on the presentation candidate holder (design §7.15)", () => {
  it("V08 the candidate's stitch drops its edit chunks: unpinned and registered once; the stitched edit file stays pinned", async () => {
    const key = `video/pin-drop/${randomUUID()}.mp4`;
    const job = randomUUID();
    const chunks = [0, 1, 2].map((n) => `${key}.video-presentation:${job}:edit:${String(n)}:a1`);
    const stitched = `${key}.video-presentation:${job}:edit-stitch:a1`;
    await pins().acquire({ holderKind: "candidate", holderId: job, toolInputId: T, objectKeys: [...chunks, stitched] });
    await db.transaction(async (tx) => { await pins().retire({ holderKind: "candidate", holderId: job }, chunks, tx); });
    await db.transaction(async (tx) => { await pins().retire({ holderKind: "candidate", holderId: job }, chunks, tx); });
    for (const chunk of chunks) expect(await pins().isKeyPinned(chunk)).toBe(false);
    expect(await pins().isKeyPinned(stitched)).toBe(true);
    expect(await queued(key)).toEqual([...chunks].sort());
  });

  it("V08 a chunk another live pin still references is dropped from the candidate but not registered", async () => {
    const key = `video/pin-drop/${randomUUID()}.mp4`;
    const job = randomUUID();
    const chunk = `${key}.video-presentation:${job}:chunk:0:a1`;
    await pins().acquire({ holderKind: "candidate", holderId: job, toolInputId: T, objectKeys: [chunk] });
    await pins().acquire({ holderKind: "execution", holderId: randomUUID(), toolInputId: T, objectKeys: [chunk] });
    await db.transaction(async (tx) => { await pins().retire({ holderKind: "candidate", holderId: job }, [chunk], tx); });
    expect(await pins().isKeyPinned(chunk)).toBe(true);
    expect(await queued(key)).toEqual([]);
  });
});
