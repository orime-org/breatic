// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared harness for the presentation store tests (inner#1306, test plan §66; frames-split design §7.1–§7.3).
 * It builds the production `VideoPresentationStore` inside the test Durable Object over real storage and real R2, and
 * reaches the store's event methods through the interface the design names: `accept` (Ad), `prepare` (St), `report` (Ev),
 * `fail` (Er), `read`, `acknowledgeUsage`, `planPresentation` (the plan fact), `advanceStage` (Sg) and `reportChunk`.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { videoPresentationKeyFor } from '@breatic/shared';
import { VideoPresentationStore, type VideoPresentationAdmission } from '@ingest/video-presentation-store.js';

export type Route = 'encode' | 'edit' | 'reuse_edit' | 'reuse';
export interface Identity { storageKey: string; sourceFingerprint: string; jobId: string; deadlineAt: number; token: string }
export interface Candidate { state: string; archived: boolean; jobId: string | null; deadlineAt: number | null; route: Route | null; stage: string | null; toolInputId: string | null; pinned: boolean; failure: string | null; autoRepairs: number }
export type Selection = { kind: 'unknown' } | { kind: 'ready' | 'invalid'; version: { versionId: string; toolInputId: string } };
export interface Chunk { state: string; attempt: number; retries: number; failure: string | null }
export interface UsageFact { wallMs: number; cpuUsec: number | null; acknowledged: boolean }
export interface MachineView { candidate: Candidate; archive: Candidate[]; selected: Selection; presentation: Record<string, unknown> | null; chunks: Record<string, Chunk>; usage: Record<string, UsageFact> }
export interface Bundle { versionId: string; toolInputId: string; descriptor: Record<string, unknown> }
export type ChunkUnit = { kind: 'presentation-count' } | { kind: 'presentation-chunk'; chunk: number } | { kind: 'presentation-stitch' }
  | { kind: 'presentation-edit'; chunk: number } | { kind: 'presentation-edit-stitch' };
export type ChunkReport = { kind: 'Sub' } | { kind: 'Done'; attempt: number; usage: number; receipts?: Record<string, unknown>[]; count?: Record<string, unknown> }
  | { kind: 'Fail'; attempt: number; code: string; usage: number | null };
export type Fact = { kind: 'verified'; bundle: Bundle } | { kind: 'finished'; usage: { wallMs: number; cpuUsec: number | null } };
/** Admission (design §3.5, §5.1): both frozen prices, the target policy version and the frozen retry caps. */
export type Admission = Omit<VideoPresentationAdmission, 'pricing'> & {
  pricing: typeof PRICING; targetPolicyVersion: number; policy: { chunkRetries: number }; encoding: typeof ENCODING; publicBaseURL: string;
  probe: { sampleFrames: number; singleFrameDurationMs: number; maxFps: number };
};
export interface MachineStore {
  accept: (admission: Admission) => Promise<MachineView>;
  prepare: (identity: Omit<Identity, 'token'>, now: number) => Promise<{ token: string | null; view: MachineView }>;
  report: (identity: Identity, fact: Fact) => Promise<MachineView>;
  fail: (identity: Identity, code: string) => Promise<MachineView>;
  read: (storageKey: string, sourceFingerprint: string) => Promise<MachineView>;
  acknowledgeUsage: (identity: Identity) => Promise<MachineView>;
  planPresentation: (identity: Identity, plan: { route: Route; toolInputId: string | null; planSha256: string }, facts?: Record<string, unknown>) => Promise<{ accepted: boolean; view: MachineView }>;
  advanceStage: (identity: Identity, stage: string) => Promise<boolean>;
  reportChunk: (identity: Identity, unit: ChunkUnit, report: ChunkReport) => Promise<boolean>;
  publishReuse: (identity: Identity) => Promise<boolean>;
}

export const H = 'a'.repeat(64);
export const T = 'c'.repeat(64);
export const T2 = 'b'.repeat(64);
// The default probe's plan (§3.2 item 2): 95x63, 25 fps from 0, no audio, BT.709, 8-bit PNG; P carries it (§3.2 item 6).
export const PLAN_CONTENT = {
  gridRulesVersion: 1, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, leadFrames: 0, gridEnd: null, singleFrameDurationMs: 5000 },
  toolSource: 'original' as 'original' | 'edit', audioTrack: null, display: { width: 95, height: 63 }, color: { matrix: 'bt709', toneMap: 'none' as const }, framePngBitDepth: 8 as const,
};
// sha256(canonical(PLAN_CONTENT)) and of the same plan read from an edit file, as literals so a reader's check is real.
export const PLAN = '74269c2a4cb840ce1b1037b46dc21d3dc2cec7b59d563887fdf6d7b2550540c1';
export const EDIT_PLAN = 'c306f80d69375ab0ab395f5bcce81048f458ec92888ecaf3f41524159e309c2c';
export const PRODUCER = '1'.repeat(64);
export const PROFILE = '2'.repeat(64);
export const D = 1_900_000_000_000;
export const NOW = 1_800_000_000_000;
// Config initial values (design §5.4 配置初值), frozen into the admission.
export const POLICY = { chunkRetries: 3 };
// The public base every derived object URL hangs off.
export const PUBLIC_BASE = 'https://assets.example.test';
export const SOURCE_BYTES = new Uint8Array([1, 2, 3, 4]);
export const ORIGINAL = { width: 95, height: 63, duration: 2.4 };
// The encoding parameters frozen at admission (design §3.2 item 1, §5.4 estimate row): the maintainer readings.
export const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: {
    startSeconds: 3, encodePixelsPerSecond: 248e6, tonemapPixelsPerSecond: 1170e6,
    decodeConvertPixelsPerSecond: {
      sdr_8bit: 910e6, sdr_10bit: 810e6, sdr_12bit: 690e6, sdr_alpha_layer: 600e6, sdr_prores: 820e6, sdr_dnx: 735e6, sdr_av1_8bit: 740e6, sdr_av1_10bit: 570e6,
      sdr_av1_12bit: 610e6, sdr_jpeg2000: 25e6, sdr_ffv1: 75e6, sdr_png: 340e6, sdr_other: 1080e6,
      edit_h264_intra_8bit_420: 1500e6, edit_h264_intra_10bit_420: 1200e6, edit_h264_intra_8bit_444: 1100e6, edit_h264_intra_10bit_444: 900e6, edit_prores: 950e6,
    },
    editEncodePixelsPerSecond: { edit_h264_intra_8bit_420: 300e6, edit_h264_intra_10bit_420: 250e6, edit_h264_intra_8bit_444: 200e6, edit_h264_intra_10bit_444: 180e6, edit_prores: 400e6 },
    aacEncodeSecondsPerSecond: 100,
  },
  edit: { crf: 15, preset: 'medium' as const, proresProfile: '4444', bytesPerPixel: 0.5, maxEditBytes: 10_000_000_000 },
  carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
// Admission freezes the basic and the standard-4 prices together (design §3.5, §5.1).
export const PRICING = {
  basic: { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 }, prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } },
  standard4: { containerClass: 'MiniToolContainerStd4', size: { vcpu: 4, memory_gib: 12, disk_gb: 20 }, prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } },
};
// 2.4 s at 25 fps: 60 grid frames, all of them real.
export const DISPLAY = { width: 95, height: 63, fps: { numerator: 25, denominator: 1 }, frameCount: 60, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 60, leadFrames: 0, holdFrames: 0 };
export const KEYFRAMES = { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false };

/**
 * Compute an independent standard SHA over literal input, not through the production hash helper.
 * @param bytes - The bytes.
 * @returns The lowercase hex digest.
 */
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Run work against a real store bound to the Durable Object of one storage key.
 * @param key - The storage key naming the object.
 * @param work - The work, given the store.
 * @returns The work's result.
 */
export async function withStore<R>(key: string, work: (store: MachineStore) => Promise<R>): Promise<R> {
  const stub = env.PRESENTATION_STATE_TEST.get(env.PRESENTATION_STATE_TEST.idFromName(key));
  return runInDurableObject(stub, async (_instance, state) => {
    const store = new VideoPresentationStore(state.storage, env.BUCKET, (inner) => state.blockConcurrencyWhile(inner)) as unknown as Partial<MachineStore>;
    for (const name of ['planPresentation', 'advanceStage', 'reportChunk', 'publishReuse'] as const) {
      expect(store[name], `${name} is a VideoPresentationStore method`).toBeTypeOf('function');
    }
    return work(store as MachineStore);
  });
}

/**
 * A fresh source with its stored original object.
 * @returns The storage key.
 */
export async function source(): Promise<string> {
  const key = `video/machine-${crypto.randomUUID()}.mp4`;
  await env.BUCKET.put(key, SOURCE_BYTES, { httpMetadata: { contentType: 'video/mp4' } });
  return key;
}

/**
 * An admission of one job for a source.
 * @param key - The storage key.
 * @param jobId - The job.
 * @param deadlineAt - The deadline.
 * @returns The admission with the frozen retry caps.
 */
export function admission(key: string, jobId: string, deadlineAt = D): Admission {
  return {
    storageKey: key, sourceFingerprint: H, jobId, deadlineAt, original: ORIGINAL, contentType: 'video/mp4', knownAlpha: false,
    actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null, pricing: PRICING,
    limits: { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 },
    publicBaseURL: PUBLIC_BASE, targetPolicyVersion: 1, policy: POLICY, encoding: ENCODING,
    probe: { sampleFrames: 1, singleFrameDurationMs: 5000, maxFps: 120 },
  };
}

/**
 * Admit and start one job, returning its identity with the granted token.
 * @param store - The store.
 * @param key - The storage key.
 * @param jobId - The job.
 * @param deadlineAt - The deadline.
 * @returns The identity.
 */
export async function started(store: MachineStore, key: string, jobId: string, deadlineAt = D): Promise<Identity> {
  await store.accept(admission(key, jobId, deadlineAt));
  const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId, deadlineAt }, Date.now());
  expect(token).toEqual(expect.any(String));
  return { storageKey: key, sourceFingerprint: H, jobId, deadlineAt, token: token! };
}

/**
 * Admit, start and plan one job. The carrier reuse route (`plan→publish`) is the one whose verified evidence publishes at
 * once, so the store cases that publish a fixture bundle directly plan it.
 * @param store - The store.
 * @param key - The storage key.
 * @param jobId - The job.
 * @param route - The frozen route.
 * @param toolInputId - The toolInputId.
 * @returns The identity.
 */
export async function planned(store: MachineStore, key: string, jobId: string, route: Route = 'encode', toolInputId = T): Promise<Identity> {
  const identity = await started(store, key, jobId);
  await store.planPresentation(identity, { route, toolInputId, planSha256: PLAN });
  return identity;
}

/**
 * A complete native bundle whose carrier is the original object as stored.
 * @param key - The storage key.
 * @param versionId - The version.
 * @param toolInputId - The toolInputId.
 * @returns The bundle.
 */
export async function bundle(key: string, versionId: string, toolInputId = T): Promise<Bundle> {
  const head = await env.BUCKET.head(key);
  const descriptor = {
    schemaVersion: 1, sourceFingerprint: H, versionId, toolInputId, planSha256: PLAN, policyVersion: 1, producerVersion: PRODUCER, profileVersion: PROFILE,
    original: ORIGINAL, display: DISPLAY, plan: PLAN_CONTENT,
    playback: { kind: 'native', carrier: { storageKey: key, url: `${PUBLIC_BASE}/${key}`, etag: head!.etag, size: head!.size, sha256: await digest(SOURCE_BYTES), contentType: 'video/mp4' }, displayRect: null },
    toolSource: { edit: null, keyframes: KEYFRAMES, sourceDecodeKey: 'sdr_8bit' },
  };
  return { versionId, toolInputId, descriptor };
}

/**
 * Read the current descriptor object as stored in R2.
 * @param key - The storage key.
 * @returns The parsed descriptor, or null when absent.
 */
export async function storedDescriptor(key: string): Promise<unknown> {
  const object = await env.BUCKET.get(videoPresentationKeyFor(key));
  return object === null ? null : JSON.parse(await object.text()) as unknown;
}
