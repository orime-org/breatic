// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Candidate and selected pins from the worker's prepare answer (S6e E4-3, inner#1306 test plan §90; frames-split
 * design §7.15 candidate 与 selected 行, 唯一写点「处理 P 提交与候选阶段事件的 worker」).
 *
 * On each pickup the presentation worker hands its job id and the DO's prepare answer to one domain function,
 * `syncPresentationPins`. It acquires the job's `candidate` pin (L of the plan's toolInputId and the candidate's own
 * work objects), acquires or moves the canonical key's `selected` pin to the selected version, and releases the
 * candidate when it is published (the selected pin takes over), archived, failed or past its deadline (the answer
 * no longer grants it a capability). The offline recheck before deletion is the arbiter (§7.15 仲裁), so the order of
 * pin writes and DO reuse does not matter here. The P descriptor pointer and the source object are never registered.
 *
 * The function name and signature are the test author's choices recorded in §90 (open to veto).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createPgClient, getStorageAdapter, initCore, loadLocales } from "@breatic/core";
import * as shared from "@breatic/shared";
import { videoContainerJobId } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import { ledgerKeys, presentedSource, type PresentedSource } from "../../../../server/src/__tests__/integration/presentation-fixtures.js";

type Sync = (jobId: string, answer: shared.VideoPresentationPrepareAnswer) => Promise<void>;
let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;
const ACTOR = "6061c056-f758-47c1-9527-8495ecba60e3";
const price = { containerClass: "MiniToolContainerStd4", size: { vcpu: 4, memory_gib: 12, disk_gb: 20 }, prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 } };

beforeAll(async () => {
  initCore({ ...process.env, PAYMENT_ENABLED: "false", UPLOAD_BASE_URL: "https://assets.example.test" });
  loadLocales();
  pg = createPgClient(inject("DATABASE_URL"), { name: "presentation-pin-sync", max: 4 });
  const storage = await getStorageAdapter();
  publicUrl = (key) => storage.publicUrl(key);
});
afterAll(async () => { await pg.end(); initCore(process.env); });

/**
 * The function under test, read at call time.
 * @returns It.
 */
function sync(): Sync {
  const fn = (domain as Record<string, unknown>).syncPresentationPins;
  expect(fn, "syncPresentationPins is exported from @breatic/domain").toBeTypeOf("function");
  return fn as Sync;
}

interface World { key: string; job: string; source: PresentedSource; chunk: string; stitch: string }

/**
 * A registered source with a selectable version and one presentation job.
 * @returns It.
 */
async function world(): Promise<World> {
  const key = `video/pin-sync/${randomUUID()}.mp4`;
  const source = await presentedSource(randomBytes(32).toString("hex"), key, publicUrl);
  const job = `pres-${randomUUID()}`;
  return { key, job, source,
    chunk: videoContainerJobId({ kind: "presentation-chunk", jobId: job, chunk: 0, attempt: 1 }),
    stitch: videoContainerJobId({ kind: "presentation-stitch", jobId: job, attempt: 1 }) };
}

/**
 * A prepare answer; the default is a granted encode candidate of the source's toolInputId with one done chunk.
 * @param w - The world.
 * @param fields - What differs.
 * @returns The parsed answer.
 */
function answer(w: World, fields: Partial<Record<keyof shared.VideoPresentationPrepareAnswer, unknown>> = {}): shared.VideoPresentationPrepareAnswer {
  const { toolInputId, planSha256 } = w.source.presentationRef.source;
  return shared.videoPresentationPrepareAnswerSchema.parse({
    sourceBinding: { storageKey: w.key, sourceFingerprint: w.source.receipt.sourceFingerprint }, presentation: null,
    preparation: { targetPolicyVersion: 1, jobId: w.job, stage: "encode", failure: null }, ledger: null,
    capability: { token: "token", deadlineAt: Date.now() + 3_600_000 },
    plan: { route: "encode", stages: ["plan", "encode", "stitch", "publish"], toolInputId, planSha256 },
    work: { kind: "encode", chunks: [{ start: 0, end: 1011 }] },
    candidateLedger: { state: "ready", receipt: w.source.receipt, failure: null },
    units: { [`video-presentation:${w.job}:chunk:0`]: { state: "done", attempt: 1, attempts: [{ attempt: 1, jobId: w.chunk, state: "done", usageRecorded: true }] } },
    frozen: { pricing: { basic: { ...price, containerClass: "MediaContainer" }, standard4: price }, actorUserId: ACTOR, projectId: null },
    ...fields,
  });
}

/**
 * Live pins of a holder with their keys.
 * @param holderId - The holder.
 * @returns Rows.
 */
async function live(holderId: string): Promise<{ holder_kind: string; tool_input_id: string; version_id: string | null; keys: string[] }[]> {
  return pg`SELECT p.holder_kind,p.tool_input_id,p.version_id,
      coalesce(array_agg(o.storage_key ORDER BY o.storage_key) FILTER (WHERE o.storage_key IS NOT NULL), '{}') AS keys
    FROM presentation_pins p LEFT JOIN presentation_pin_objects o ON o.pin_id=p.id
    WHERE p.holder_id=${holderId} AND p.deleted_at IS NULL GROUP BY p.id`;
}

/**
 * Derived queue rows under a source.
 * @param key - The source key.
 * @returns Sorted keys.
 */
async function queued(key: string): Promise<string[]> {
  const rows = await pg<{ storage_key: string }[]>`SELECT storage_key FROM storage_reclaim_queue WHERE starts_with(storage_key, ${key}) ORDER BY storage_key`;
  return rows.map((row) => row.storage_key);
}

describe("candidate pin (design §7.15 candidate)", () => {
  it("SY01 a granted plan acquires the job's candidate pin on L of its toolInputId and its work objects", async () => {
    const w = await world(); const t = w.source.presentationRef.source.toolInputId; const l = ledgerKeys(w.key, t);
    await sync()(w.job, answer(w));
    const [row] = await live(w.job);
    expect(row).toMatchObject({ holder_kind: "candidate", tool_input_id: t, version_id: null });
    expect(row!.keys).toEqual(expect.arrayContaining([l.full, l.table, shared.videoPresentationWorkKeyFor(w.key, w.chunk)]));
  });

  it("SY02 the same answer twice changes nothing", async () => {
    const w = await world();
    await sync()(w.job, answer(w));
    const once = await live(w.job);
    await sync()(w.job, answer(w));
    expect(await live(w.job)).toEqual(once);
    expect(await queued(w.key)).toEqual([]);
  });

  it("SY03 a job the DO no longer grants releases its candidate and registers what nothing else pins", async () => {
    const w = await world(); const t = w.source.presentationRef.source.toolInputId; const l = ledgerKeys(w.key, t);
    await sync()(w.job, answer(w));
    await sync()(w.job, answer(w, { capability: null, plan: null, work: { kind: "none" }, candidateLedger: null }));
    expect(await live(w.job)).toEqual([]);
    expect(await queued(w.key)).toEqual(expect.arrayContaining([l.full, l.table, shared.videoPresentationWorkKeyFor(w.key, w.chunk)]));
  });
});

describe("selected pin (design §7.15 selected, Mv)", () => {
  it("SY04 publishing the candidate moves L to the selected pin and releases the candidate without registering L", async () => {
    const w = await world(); const t = w.source.presentationRef.source.toolInputId; const l = ledgerKeys(w.key, t);
    await sync()(w.job, answer(w));
    await sync()(w.job, answer(w, { presentation: w.source.bundle, ledger: { state: "ready", receipt: w.source.receipt, failure: null } }));
    expect(await live(w.job)).toEqual([]);
    const [selected] = await live(w.key);
    expect(selected).toMatchObject({ holder_kind: "selected", tool_input_id: t, version_id: w.source.versionId });
    expect(selected!.keys).toEqual(expect.arrayContaining([l.full, l.table]));
    expect(await queued(w.key)).not.toEqual(expect.arrayContaining([l.full]));
    expect(await queued(w.key)).not.toEqual(expect.arrayContaining([l.table]));
  });

  it("SY05 a later answer selecting another toolInputId moves the one selected row and registers the old L", async () => {
    const w = await world(); const t = w.source.presentationRef.source.toolInputId; const l = ledgerKeys(w.key, t);
    const other = "f".repeat(64); const versionId = "b".repeat(64);
    await sync()(w.job, answer(w, { presentation: w.source.bundle, capability: null, plan: null, work: { kind: "none" }, candidateLedger: null }));
    const moved = { ...w.source.bundle, versionId, toolInputId: other };
    const otherReceipt = { ...w.source.receipt, toolInputId: other, url: publicUrl(ledgerKeys(w.key, other).full), table: { ...w.source.receipt.table, url: publicUrl(ledgerKeys(w.key, other).table) } };
    await sync()(`pres-${randomUUID()}`, answer(w, { presentation: moved, ledger: { state: "ready", receipt: otherReceipt, failure: null }, capability: null, plan: null, work: { kind: "none" }, candidateLedger: null }));
    const rows = await live(w.key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holder_kind: "selected", tool_input_id: other, version_id: versionId });
    expect(await queued(w.key)).toEqual(expect.arrayContaining([l.full, l.table]));
  });

  it("SY06 the P descriptor pointer and the identity carrier (the source itself) are never pinned objects nor registered", async () => {
    const w = await world();
    await sync()(w.job, answer(w));
    await sync()(w.job, answer(w, { presentation: w.source.bundle, ledger: { state: "ready", receipt: w.source.receipt, failure: null } }));
    await sync()(w.job, answer(w, { presentation: { ...w.source.bundle, versionId: "b".repeat(64), toolInputId: "f".repeat(64) }, capability: null, plan: null, work: { kind: "none" }, candidateLedger: null, ledger: null }));
    const descriptor = shared.videoPresentationKeyFor(w.key);
    expect(await queued(w.key)).not.toContain(descriptor);
    expect(await queued(w.key)).not.toContain(w.key);
    const [refs] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM presentation_pin_objects WHERE storage_key IN (${descriptor}, ${w.key})`;
    expect(refs!.n).toBe(0);
  });
});
