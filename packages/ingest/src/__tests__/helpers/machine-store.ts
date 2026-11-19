// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared harness for the S6c presentation store tests (inner#1306, test plan §89).
 * It builds the production `VideoPresentationStore` inside the test Durable
 * Object over real storage and real R2, and reaches the store's event methods
 * through the interface the design names: `accept` (Ad), `prepare` (St),
 * `report` (Ev), `fail` (Er), `read`, `acknowledgeUsage`, `planPresentation`
 * (Tp), `advanceStage` (Sg), `reportChunk` and the ledger write points
 * `claimSourceLedger`, `commitLedger`, `failLedger`.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { videoPresentationKeyFor } from '@breatic/shared';
import { VideoPresentationStore, type VideoPresentationAdmission, type SourceLedgerDeclaration, type SourceLedgerWriteClaim } from '@ingest/video-presentation-store.js';
import { digest, ENCODING, fullKeyFor, LEDGER_LIMITS, ORIGINAL, PRICING, tableKeyFor } from './source-ledger-fixture.js';

export type Route = 'identity' | 'copy' | 'dispatch_copy' | 'encode' | 'reuse';
export interface Identity { storageKey: string; sourceFingerprint: string; jobId: string; deadlineAt: number; token: string }
export interface Candidate { state: string; archived: boolean; jobId: string | null; deadlineAt: number | null; route: Route | null; stage: string | null; toolInputId: string | null; pinned: boolean; failure: string | null; autoRepairs: number }
export type Selection = { kind: 'unknown' } | { kind: 'ready' | 'invalid'; version: { versionId: string; toolInputId: string } };
export type Instance = { kind: 'absent' } | { kind: 'pending'; writer: string; writerArchived: boolean; waiters: string[] } | { kind: 'ready'; receipt: unknown } | { kind: 'failed-transient' | 'failed-content'; code: string };
export interface Chunk { state: string; attempt: number; retries: number; failure: string | null }
export interface UsageFact { wallMs: number; cpuUsec: number | null; acknowledged: boolean }
export interface MachineView { candidate: Candidate; archive: Candidate[]; selected: Selection; ledgers: Record<string, Instance>; chunks: Record<string, Chunk>; usage: Record<string, UsageFact> }
export interface Bundle { versionId: string; toolInputId: string; descriptor: Record<string, unknown> }
export type ChunkUnit = { kind: 'presentation-chunk'; chunk: number } | { kind: 'presentation-stitch' } | { kind: 'presentation-copy' };
export type ChunkReport = { kind: 'Sub' } | { kind: 'Done'; attempt: number; usage: number } | { kind: 'Fail'; attempt: number; code: string; usage: number | null };
export type Fact = { kind: 'verified'; bundle: Bundle } | { kind: 'finished'; usage: { wallMs: number; cpuUsec: number | null } };
export interface Measured { etag: string; size: number; sha256: string; table: { etag: string; size: number; sha256: string } }
/** S6c admission (design §3.5, §5.1): both frozen prices, the target policy version and the frozen retry caps. */
export type Admission = Omit<VideoPresentationAdmission, 'pricing'> & {
  pricing: typeof PRICING; targetPolicyVersion: number; policy: { chunkRetries: number; maxAutoRepairs: number }; encoding: typeof ENCODING; publicBaseURL: string;
  probe: { sampleFrames: number; singleFrameDurationMs: number; identityFormats: Record<string, unknown>[] };
};
export interface MachineStore {
  accept: (admission: Admission) => Promise<MachineView>;
  prepare: (identity: Omit<Identity, 'token'>, now: number) => Promise<{ token: string | null; view: MachineView }>;
  report: (identity: Identity, fact: Fact) => Promise<MachineView>;
  fail: (identity: Identity, code: string) => Promise<MachineView>;
  read: (storageKey: string, sourceFingerprint: string) => Promise<MachineView>;
  acknowledgeUsage: (identity: Identity) => Promise<MachineView>;
  planPresentation: (identity: Identity, plan: { route: Route; toolInputId: string; planSha256: string }) => Promise<{ writer: boolean; view: MachineView }>;
  advanceStage: (identity: Identity, stage: string) => Promise<boolean>;
  reportChunk: (identity: Identity, unit: ChunkUnit, report: ChunkReport) => Promise<boolean>;
  claimSourceLedger: (identity: Identity, toolInputId: string, declaration: SourceLedgerDeclaration) => Promise<SourceLedgerWriteClaim | null>;
  commitLedger: (identity: Identity, toolInputId: string, owner: string, measured: Measured) => Promise<boolean>;
  failLedger: (identity: Identity, toolInputId: string, code: string) => Promise<boolean>;
  releaseSourceLedger: (identity: Identity, toolInputId: string, owner: string) => Promise<void>;
}
/** The ledger writer's port as `writeVideoSourceLedger` and the edge handler call it. */
export type LedgerPort = Pick<MachineStore, 'claimSourceLedger' | 'commitLedger' | 'releaseSourceLedger'>;

export const H = 'a'.repeat(64);
export const T = 'c'.repeat(64);
export const T2 = 'b'.repeat(64);
export const PLAN = 'd'.repeat(64);
export const D = 1_900_000_000_000;
export const NOW = 1_800_000_000_000;
// Config initial values (design §5.4 配置初值), frozen into the admission.
export const POLICY = { chunkRetries: 3, maxAutoRepairs: 3 };
// The public base every derived object URL hangs off (inner 1c3a5892).
export const PUBLIC_BASE = 'https://assets.example.test';
export const SOURCE_BYTES = new Uint8Array([1, 2, 3, 4]);
export const TABLE = new TextEncoder().encode(JSON.stringify({ sourceFingerprint: H, toolInputId: T, planSha256: PLAN, presentation: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] } }));
export const FULL = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, sourceFingerprint: H, toolInputId: T, planSha256: PLAN }));
export const DECLARATION: SourceLedgerDeclaration = { producerVersion: 2, byteLength: FULL.length, table: { byteLength: TABLE.length, frameCount: 3 } };

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
    for (const name of ['planPresentation', 'advanceStage', 'reportChunk', 'commitLedger', 'failLedger'] as const) {
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
    limits: { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536, sourceLedger: { ...LEDGER_LIMITS } },
    // S6e (inner 1c3a5892): one frozen public base; ingest derives every object URL from it.
    publicBaseURL: PUBLIC_BASE,
    targetPolicyVersion: 1, policy: POLICY, encoding: ENCODING,
    // S6d D1 (§91 D-6): frozen probe sample count and single-frame duration.
    probe: { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }] },
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
 * Admit, start and plan one job: the job is then the writer of a new toolInputId.
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
 * Write both ledger objects under a claim, as the producer's one PUT does.
 * @param claim - The claim.
 * @param jobId - The writing job.
 * @param bodies - The table and full bytes.
 * @param bodies.table - The compact bytes.
 * @param bodies.full - The full bytes.
 * @returns The measurements the store checks.
 */
export async function putLedger(claim: SourceLedgerWriteClaim, jobId: string, bodies: { table: Uint8Array; full: Uint8Array } = { table: TABLE, full: FULL }): Promise<Measured> {
  const metadata = { httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: jobId, sourceLedgerClaimOwner: claim.owner } };
  const table = await env.BUCKET.put(claim.table.key, bodies.table, { onlyIf: claim.table.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.table.priorETag }, ...metadata });
  const full = await env.BUCKET.put(claim.key, bodies.full, { onlyIf: claim.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.priorETag }, ...metadata });
  if (table === null || full === null) throw new Error('Expected the conditional writer to win');
  return { etag: full.etag, size: full.size, sha256: await digest(bodies.full), table: { etag: table.etag, size: table.size, sha256: await digest(bodies.table) } };
}

/**
 * Claim, write and commit the ledger of a planned writer.
 * @param store - The store.
 * @param identity - The writer.
 * @param toolInputId - The toolInputId.
 * @returns The committed measurements.
 */
export async function produceLedger(store: MachineStore, identity: Identity, toolInputId = T): Promise<Measured> {
  const claim = await store.claimSourceLedger(identity, toolInputId, DECLARATION);
  expect(claim).not.toBeNull();
  const measured = await putLedger(claim!, identity.jobId);
  expect(await store.commitLedger(identity, toolInputId, claim!.owner, measured)).toBe(true);
  return measured;
}

/**
 * A complete identity-route bundle whose carrier is the original object as stored.
 * @param key - The storage key.
 * @param versionId - The version.
 * @param toolInputId - The toolInputId.
 * @returns The bundle.
 */
export async function bundle(key: string, versionId: string, toolInputId = T): Promise<Bundle> {
  const head = await env.BUCKET.head(key);
  const descriptor = {
    schemaVersion: 1, sourceFingerprint: H, versionId, toolInputId, planSha256: PLAN, policyVersion: 1, producerVersion: 2, profileVersion: 1,
    original: ORIGINAL, display: { width: 95, height: 63, duration: { numerator: '12', denominator: '5' } },
    playback: { kind: 'native', carrier: { storageKey: key, url: `https://assets.example.test/${key}`, etag: head!.etag, size: head!.size, sha256: await digest(SOURCE_BYTES), contentType: 'video/mp4' }, displayRect: null },
    playbackClock: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] },
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

/**
 * A ledger port that reaches the store of one storage key on every call, as the DO RPC does.
 * @param key - The storage key.
 * @returns The port.
 */
export function ledgerPort(key: string): LedgerPort {
  return {
    claimSourceLedger: (identity, toolInputId, declaration) => withStore(key, (store) => store.claimSourceLedger(identity, toolInputId, declaration)),
    commitLedger: (identity, toolInputId, owner, measured) => withStore(key, (store) => store.commitLedger(identity, toolInputId, owner, measured)),
    releaseSourceLedger: (identity, toolInputId, owner) => withStore(key, (store) => store.releaseSourceLedger(identity, toolInputId, owner)),
  };
}

/**
 * The S6a receipt the store records when the ledger of T is committed.
 * @param key - The storage key.
 * @param jobId - The writing job.
 * @param measured - The committed measurements.
 * @returns The receipt.
 */
export async function expectedReceipt(key: string, jobId: string, measured: Measured): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 2, sourceFingerprint: H, toolInputId: T, planSha256: PLAN, producerVersion: 2, attempt: { jobId, deadlineAt: D },
    url: `https://assets.example.test/${fullKeyFor(key, T)}`, etag: measured.etag, size: measured.size, sha256: measured.sha256, contentType: 'application/json',
    table: { url: `https://assets.example.test/${tableKeyFor(key, T)}`, sha256: await digest(TABLE), size: TABLE.length, contentType: 'application/json', frameCount: 3 },
  };
}

/** One planned writer of T: its source key and identity. */
export interface LedgerCase { key: string; identity: Identity }

/**
 * A fresh source whose job a is the planned writer of T.
 * @param deadlineAt - The job's deadline.
 * @returns The case.
 */
export async function ledgerCase(deadlineAt = D): Promise<LedgerCase> {
  const key = await source();
  const identity = await withStore(key, async (store) => {
    await store.accept(admission(key, 'job-a', deadlineAt));
    const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt }, Date.now());
    const value = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt, token: token! };
    expect((await store.planPresentation(value, { route: 'encode', toolInputId: T, planSha256: PLAN })).writer).toBe(true);
    return value;
  });
  return { key, identity };
}

/** The one producer body: compact table bytes, then full ledger bytes. */
export const LEDGER_BODY = new Uint8Array([...TABLE, ...FULL]);

