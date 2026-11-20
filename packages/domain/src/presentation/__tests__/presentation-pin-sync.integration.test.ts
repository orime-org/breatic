// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Candidate and selected pins from the worker's prepare answer (S6e E4-3, inner#1306 test plan §90; frames-split
 * design §7.15 candidate 与 selected 行, 唯一写点「处理 P 提交与候选阶段事件的 worker」).
 *
 * On each pickup the presentation worker hands its job id and the DO's prepare answer to one domain function,
 * `syncPresentationPins`. It acquires the job's `candidate` pin (the candidate's own work objects under the plan's
 * toolInputId), acquires or moves the canonical key's `selected` pin to the selected version (its playback file,
 * manifest and edit file), and releases the
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
import { videoCarrierRouteStages, videoContainerJobId } from "@breatic/shared/mini-tools";
import * as domain from "@domain/index.js";
import { editKeyOf, presentedSource, type PresentedSource } from "../../../../server/src/__tests__/integration/presentation-fixtures.js";

type Sync = (jobId: string, answer: shared.VideoPresentationPrepareAnswer) => Promise<void>;
let pg: ReturnType<typeof createPgClient>;
let publicUrl: (key: string) => string;
const ACTOR = "6061c056-f758-47c1-9527-8495ecba60e3";
/** The source's colour inputs the plan's probe facts carry. */
const COLOR = { matrix: "bt601", transfer: "bt709", primaries: "bt470bg", range: "tv", chromaLocation: "left" };
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
 * @param edit - Whether the selected version's tools read an edit file.
 * @returns It.
 */
async function world(edit = false): Promise<World> {
  const key = `video/pin-sync/${randomUUID()}.mp4`;
  const source = await presentedSource(randomBytes(32).toString("hex"), key, publicUrl, { edit });
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
    sourceBinding: { storageKey: w.key, sourceFingerprint: w.source.bundle.sourceFingerprint }, presentation: null,
    preparation: { targetPolicyVersion: 1, jobId: w.job, stage: "encode", failure: null },
    capability: { token: "token", deadlineAt: Date.now() + 3_600_000 },
    plan: {
      route: "encode", stages: videoCarrierRouteStages("encode"), toolInputId, planSha256,
      content: w.source.bundle.plan, display: w.source.bundle.display,
      source: { color: COLOR, keyframes: w.source.bundle.toolSource.keyframes, editTier: null, alpha: false }, editStorageKey: null,
    },
    work: { kind: "encode", chunks: [{ start: 0, end: 1011 }] },
    units: { [`video-presentation:${w.job}:chunk:0`]: { state: "done", attempt: 1, attempts: [{ attempt: 1, jobId: w.chunk, state: "done", usageRecorded: true }] } },
    // §91 D3b-1: the frozen carrier encode parameters.
    frozen: { pricing: { basic: { ...price, containerClass: "MediaContainer" }, standard4: price }, actorUserId: ACTOR, projectId: null, carrier: { crf: 18, preset: "medium", maxShortSide: 1080 }, edit: { crf: 15, preset: "medium" } },
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
  it("SY01 a granted plan acquires the job's candidate pin under its toolInputId on its work objects", async () => {
    const w = await world(); const t = w.source.presentationRef.source.toolInputId;
    await sync()(w.job, answer(w));
    const [row] = await live(w.job);
    expect(row).toMatchObject({ holder_kind: "candidate", tool_input_id: t, version_id: null });
    expect(row!.keys).toEqual([shared.videoPresentationWorkKeyFor(w.key, w.chunk)]);
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
    const w = await world();
    await sync()(w.job, answer(w));
    await sync()(w.job, answer(w, { capability: null, plan: null, work: { kind: "none" } }));
    expect(await live(w.job)).toEqual([]);
    expect(await queued(w.key)).toEqual([shared.videoPresentationWorkKeyFor(w.key, w.chunk)]);
  });
});

describe("selected pin (design §7.15 selected, Mv)", () => {
  it("SY04 publishing the candidate pins the version's edit file on the selected row and releases the candidate's work objects", async () => {
    const w = await world(true); const t = w.source.presentationRef.source.toolInputId; const edit = editKeyOf(w.key);
    await sync()(w.job, answer(w));
    await sync()(w.job, answer(w, { presentation: w.source.bundle }));
    expect(await live(w.job)).toEqual([]);
    const [selected] = await live(w.key);
    expect(selected).toMatchObject({ holder_kind: "selected", tool_input_id: t, version_id: w.source.versionId });
    expect(selected!.keys).toEqual([edit]);
    expect(await queued(w.key)).toEqual([shared.videoPresentationWorkKeyFor(w.key, w.chunk)]);
  });

  it("SY05 a later answer selecting another toolInputId moves the one selected row and registers the old edit file", async () => {
    const w = await world(true); const old = editKeyOf(w.key);
    const other = "f".repeat(64); const versionId = "b".repeat(64);
    const otherEdit = shared.videoPresentationWorkKeyFor(w.key, "video-presentation:other-job:edit.mp4");
    await sync()(w.job, answer(w, { presentation: w.source.bundle, capability: null, plan: null, work: { kind: "none" } }));
    const moved = { ...w.source.bundle, versionId, toolInputId: other,
      toolSource: { ...w.source.bundle.toolSource, edit: { ...w.source.bundle.toolSource.edit!, storageKey: otherEdit, url: publicUrl(otherEdit) } } };
    await sync()(`pres-${randomUUID()}`, answer(w, { presentation: moved, capability: null, plan: null, work: { kind: "none" } }));
    const rows = await live(w.key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holder_kind: "selected", tool_input_id: other, version_id: versionId, keys: [otherEdit] });
    expect(await queued(w.key)).toEqual([old]);
  });

  it("SY06 the P descriptor pointer and the identity carrier (the source itself) are never pinned objects nor registered", async () => {
    const w = await world();
    await sync()(w.job, answer(w));
    await sync()(w.job, answer(w, { presentation: w.source.bundle }));
    await sync()(w.job, answer(w, { presentation: { ...w.source.bundle, versionId: "b".repeat(64), toolInputId: "f".repeat(64) }, capability: null, plan: null, work: { kind: "none" } }));
    const descriptor = shared.videoPresentationKeyFor(w.key);
    expect(await queued(w.key)).not.toContain(descriptor);
    expect(await queued(w.key)).not.toContain(w.key);
    const [refs] = await pg<{ n: number }[]>`SELECT count(*)::int AS n FROM presentation_pin_objects WHERE storage_key IN (${descriptor}, ${w.key})`;
    expect(refs!.n).toBe(0);
  });
});

describe("release points of the candidate's own objects and of old versions (design §7.15 释放点; §90 E4-14)", () => {
  /**
   * One attempt record of a unit.
   * @param jobId - The attempt's job id.
   * @param attempt - Its number.
   * @param state - Its state.
   * @returns It.
   */
  function attemptOf(jobId: string, attempt: number, state: "pending" | "done" | "failed"): { attempt: number; jobId: string; state: string; usageRecorded: boolean } {
    return { attempt, jobId, state, usageRecorded: state !== "pending" };
  }

  /**
   * An object receipt under the source key.
   * @param w - The world.
   * @param name - The object's suffix.
   * @param contentType - Its type.
   * @returns The receipt.
   */
  function object(w: World, name: string, contentType: string): Record<string, unknown> {
    const storageKey = `${w.key}.${name}`;
    return { storageKey, url: publicUrl(storageKey), etag: `etag-${name}`, size: 100, sha256: "d".repeat(64), contentType };
  }

  /**
   * The selected version as an alpha-packed bundle with its own carrier and manifest.
   * @param w - The world.
   * @param versionId - Its version.
   * @param carrier - Its carrier receipt.
   * @param manifest - Its manifest receipt.
   * @returns The bundle.
   */
  function packed(w: World, versionId: string, carrier: Record<string, unknown>, manifest: Record<string, unknown>): Record<string, unknown> {
    return { ...w.source.bundle, versionId, playback: { kind: "alpha-packed", carrier, manifest } };
  }

  /**
   * An answer that only reports the selected version (no granted job).
   * @param w - The world.
   * @param presentation - The selected bundle.
   * @returns The parsed answer.
   */
  function selectedOnly(w: World, presentation: Record<string, unknown>): shared.VideoPresentationPrepareAnswer {
    return answer(w, { presentation, capability: null, plan: null, work: { kind: "none" }, units: {} });
  }

  it("SY07 a never-selected alpha candidate that is archived, failed or expired registers its own carrier and manifest (from the stitch's done receipts) and chunk outputs, but not the edit file the selected version still pins", async () => {
    const w = await world(true); const edit = editKeyOf(w.key);
    const carrier = shared.videoPresentationWorkKeyFor(w.key, w.stitch); const chunk = shared.videoPresentationWorkKeyFor(w.key, w.chunk);
    const manifest = `${w.key}.alpha-manifest-${randomUUID()}.json`;
    // Another version of the same toolInputId is selected, so its edit file stays pinned by the selected row.
    await sync()(`pres-${randomUUID()}`, selectedOnly(w, w.source.bundle));
    await sync()(w.job, answer(w, { units: {
      [`video-presentation:${w.job}:chunk:0`]: { state: "done", attempt: 1, attempts: [attemptOf(w.chunk, 1, "done")] },
      // §90 E4-15: the keys come from the role-tagged receipts the DO stored for the done stitch, not from a key rule.
      [`video-presentation:${w.job}:stitch`]: { state: "done", attempt: 1, attempts: [attemptOf(w.stitch, 1, "done")], receipts: [
        // §91 D3-3: an alpha-packed carrier receipt carries its packed geometry; the manifest is the DO's own.
        { role: "carrier", packing: "alpha-packed", storageKey: carrier, sha256: "d".repeat(64), sizeBytes: 100, contentType: "video/mp4",
          geometry: { packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } } },
        { role: "manifest", storageKey: manifest, sha256: "e".repeat(64), sizeBytes: 50, contentType: "application/json" },
      ] },
    } }));
    expect(await queued(w.key)).not.toContain(carrier);
    expect(await queued(w.key)).not.toContain(manifest);
    const [candidate] = await live(w.job);
    expect(candidate!.keys).toEqual(expect.arrayContaining([carrier, manifest]));
    await sync()(w.job, answer(w, { capability: null, plan: null, work: { kind: "none" } }));
    const rows = await queued(w.key);
    expect(rows).toEqual(expect.arrayContaining([carrier, manifest, chunk]));
    expect(rows).not.toContain(edit);
  });

  it("SY08 a superseded attempt's output is registered at once; the chunk outputs are registered when the stitch is committed, the stitched carrier is not", async () => {
    const w = await world();
    const a1 = videoContainerJobId({ kind: "presentation-chunk", jobId: w.job, chunk: 0, attempt: 1 });
    const a2 = videoContainerJobId({ kind: "presentation-chunk", jobId: w.job, chunk: 0, attempt: 2 });
    const key = (job: string): string => shared.videoPresentationWorkKeyFor(w.key, job);
    const chunkUnit = { state: "done", attempt: 2, attempts: [attemptOf(a1, 1, "failed"), attemptOf(a2, 2, "done")] };
    await sync()(w.job, answer(w, { units: { [`video-presentation:${w.job}:chunk:0`]: chunkUnit,
      [`video-presentation:${w.job}:stitch`]: { state: "open", attempt: 1, attempts: [attemptOf(w.stitch, 1, "pending")] } } }));
    expect(await queued(w.key)).toEqual([key(a1)]);
    await sync()(w.job, answer(w, { units: { [`video-presentation:${w.job}:chunk:0`]: chunkUnit,
      [`video-presentation:${w.job}:stitch`]: { state: "done", attempt: 1, attempts: [attemptOf(w.stitch, 1, "done")] } } }));
    expect(await queued(w.key)).toEqual([key(a1), key(a2)].sort());
    expect(await queued(w.key)).not.toContain(key(w.stitch));
  });

  it("SY09 when P changes version, the old version's carrier and manifest are registered and the new version's are pinned", async () => {
    const w = await world();
    const oldCarrier = object(w, "carrier-v1.mp4", "video/mp4"); const oldManifest = object(w, "manifest-v1.json", "application/json");
    const newCarrier = object(w, "carrier-v2.mp4", "video/mp4"); const newManifest = object(w, "manifest-v2.json", "application/json");
    await sync()(`pres-${randomUUID()}`, selectedOnly(w, packed(w, "b".repeat(64), oldCarrier, oldManifest)));
    expect(await queued(w.key)).toEqual([]);
    await sync()(`pres-${randomUUID()}`, selectedOnly(w, packed(w, "c".repeat(64), newCarrier, newManifest)));
    expect(await queued(w.key)).toEqual([oldCarrier.storageKey as string, oldManifest.storageKey as string].sort());
    const [selected] = await live(w.key);
    expect(selected!.keys).toEqual(expect.arrayContaining([newCarrier.storageKey as string, newManifest.storageKey as string]));
  });

  it("SY10 a new version that reuses the selected carrier and manifest (reuse route) registers neither", async () => {
    const w = await world();
    const carrier = object(w, "carrier-v1.mp4", "video/mp4"); const manifest = object(w, "manifest-v1.json", "application/json");
    await sync()(`pres-${randomUUID()}`, selectedOnly(w, packed(w, "b".repeat(64), carrier, manifest)));
    await sync()(`pres-${randomUUID()}`, selectedOnly(w, packed(w, "c".repeat(64), carrier, manifest)));
    expect(await queued(w.key)).toEqual([]);
    const rows = await live(w.key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version_id: "c".repeat(64) });
  });
});

