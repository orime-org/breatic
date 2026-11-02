// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * S6c wiring: the presentation Durable Object store over the seven pure
 * transitions (inner#1306, test plan §89; frames-split design §7.1–§7.4 write
 * points and arbitration). Runs over real workerd Durable Object storage and real
 * R2; no container starts.
 *
 * Write points under test: the candidate is written only through
 * `advancePresentationCandidate`; P only through `commitPresentationVersion`,
 * which conditionally replaces the R2 current descriptor (R0) before the DO copy;
 * L ready only through `commitLedger`, failed only through `failLedger`; Tp comes
 * before any ledger write and decides the one writer per toolInputId; archiving a
 * job hands writing over in the same transaction; only the latest chunk attempt
 * moves its chunk.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor, videoSourceLedgerKeyFor } from '@breatic/shared';
import { VideoPresentationStore, type VideoPresentationAdmission, type SourceLedgerDeclaration, type SourceLedgerWriteClaim } from '@ingest/video-presentation-store.js';
import { digest, LEDGER_LIMITS, ORIGINAL, PRICING, tableKeyFor } from './helpers/source-ledger-fixture.js';

type Route = 'identity' | 'copy' | 'dispatch_copy' | 'encode' | 'reuse';
interface Identity { storageKey: string; sourceFingerprint: string; jobId: string; deadlineAt: number; token: string }
interface Candidate { state: string; archived: boolean; jobId: string | null; route: Route | null; stage: string | null; toolInputId: string | null; pinned: boolean; failure: string | null; autoRepairs: number }
type Selection = { kind: 'unknown' } | { kind: 'ready' | 'invalid'; version: { versionId: string; toolInputId: string } };
type Instance = { kind: 'absent' } | { kind: 'pending'; writer: string; writerArchived: boolean; waiters: string[] } | { kind: 'ready'; receipt: string } | { kind: 'failed-transient' | 'failed-content'; code: string };
interface Chunk { state: string; attempt: number; retries: number; failure: string | null }
interface MachineView { candidate: Candidate; archive: Candidate[]; selected: Selection; ledgers: Record<string, Instance>; chunks: Record<string, Chunk> }
interface Bundle { versionId: string; toolInputId: string; descriptor: Record<string, unknown> }
type ChunkUnit = { kind: 'presentation-chunk'; chunk: number } | { kind: 'presentation-stitch' } | { kind: 'presentation-copy' };
type ChunkReport = { kind: 'Sub' } | { kind: 'Done'; attempt: number; usage: number } | { kind: 'Fail'; attempt: number; code: string; usage: number | null };
interface MachineStore {
  admitPresentation: (admission: VideoPresentationAdmission & { policy: { chunkRetries: number; maxAutoRepairs: number } }) => Promise<MachineView>;
  startPresentation: (identity: Omit<Identity, 'token'>, now: number) => Promise<{ token: string | null; view: MachineView }>;
  planPresentation: (identity: Identity, plan: { route: Route; toolInputId: string; planSha256: string }) => Promise<{ writer: boolean; view: MachineView }>;
  advanceStage: (identity: Identity, stage: string) => Promise<boolean>;
  reportChunk: (identity: Identity, unit: ChunkUnit, report: ChunkReport) => Promise<boolean>;
  verifyPresentation: (identity: Identity, bundle: Bundle) => Promise<MachineView>;
  failPresentation: (identity: Identity, code: string) => Promise<MachineView>;
  claimSourceLedger: (identity: Identity, toolInputId: string, declaration: SourceLedgerDeclaration) => Promise<SourceLedgerWriteClaim | null>;
  commitLedger: (identity: Identity, toolInputId: string, owner: string, measured: Measured) => Promise<boolean>;
  failLedger: (identity: Identity, toolInputId: string, code: string) => Promise<boolean>;
  readPresentationMachine: (storageKey: string, sourceFingerprint: string) => Promise<MachineView>;
}
interface Measured { etag: string; size: number; sha256: string; table: { etag: string; size: number; sha256: string } }

const H = 'a'.repeat(64);
const T = 'c'.repeat(64);
const T2 = 'b'.repeat(64);
const PLAN = 'd'.repeat(64);
const D = 1_900_000_000_000;
const NOW = 1_800_000_000_000;
// Config initial values (design §5.4 配置初值), frozen into the admission.
const POLICY = { chunkRetries: 3, maxAutoRepairs: 3 };
const TABLE = new TextEncoder().encode(JSON.stringify({ sourceFingerprint: H, toolInputId: T, planSha256: PLAN, presentation: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] } }));
const FULL = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, sourceFingerprint: H, toolInputId: T, planSha256: PLAN }));
const DECLARATION: SourceLedgerDeclaration = { producerVersion: 2, byteLength: FULL.length, table: { byteLength: TABLE.length, frameCount: 3 } };

/**
 * Run work against a real store bound to the Durable Object of one storage key.
 * @param key - The storage key naming the object.
 * @param work - The work, given the store.
 * @returns The work's result.
 */
async function withStore<R>(key: string, work: (store: MachineStore) => Promise<R>): Promise<R> {
  const stub = env.PRESENTATION_STATE_TEST.get(env.PRESENTATION_STATE_TEST.idFromName(key));
  return runInDurableObject(stub, async (_instance, state) => {
    const store = new VideoPresentationStore(state.storage, env.BUCKET, (inner) => state.blockConcurrencyWhile(inner)) as unknown as Partial<MachineStore>;
    for (const name of ['admitPresentation', 'startPresentation', 'planPresentation', 'commitLedger', 'failLedger', 'readPresentationMachine'] as const) {
      expect(store[name], `${name} is a VideoPresentationStore method`).toBeTypeOf('function');
    }
    return work(store as MachineStore);
  });
}

/**
 * A fresh source with its stored original object.
 * @returns The storage key.
 */
async function source(): Promise<string> {
  const key = `video/machine-${crypto.randomUUID()}.mp4`;
  await env.BUCKET.put(key, new Uint8Array([1, 2, 3, 4]));
  return key;
}

/**
 * An admission of one job for a source.
 * @param key - The storage key.
 * @param jobId - The job.
 * @returns The admission with the frozen retry caps.
 */
function admission(key: string, jobId: string): VideoPresentationAdmission & { policy: typeof POLICY } {
  return {
    storageKey: key, sourceFingerprint: H, jobId, deadlineAt: D, original: ORIGINAL, contentType: 'video/mp4', knownAlpha: false,
    actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null, pricing: PRICING,
    limits: { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536, sourceLedger: { ...LEDGER_LIMITS } },
    sourceLedgerURL: `https://assets.example.test/${videoSourceLedgerKeyFor(key)}`, sourceLedgerTableURL: `https://assets.example.test/${tableKeyFor(key)}`,
    policy: POLICY,
  };
}

/**
 * Admit and start one job, returning its identity with the granted token.
 * @param store - The store.
 * @param key - The storage key.
 * @param jobId - The job.
 * @returns The identity.
 */
async function started(store: MachineStore, key: string, jobId: string): Promise<Identity> {
  await store.admitPresentation(admission(key, jobId));
  const { token } = await store.startPresentation({ storageKey: key, sourceFingerprint: H, jobId, deadlineAt: D }, NOW);
  expect(token).toEqual(expect.any(String));
  return { storageKey: key, sourceFingerprint: H, jobId, deadlineAt: D, token: token! };
}

/**
 * Write both ledger objects under a claim, as the producer's one PUT does.
 * @param claim - The claim.
 * @param jobId - The writing job.
 * @returns The measurements the store checks.
 */
async function putLedger(claim: SourceLedgerWriteClaim, jobId: string): Promise<Measured> {
  const metadata = { httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: jobId, sourceLedgerClaimOwner: claim.owner } };
  const table = await env.BUCKET.put(claim.table.key, TABLE, { onlyIf: claim.table.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.table.priorETag }, ...metadata });
  const full = await env.BUCKET.put(claim.key, FULL, { onlyIf: claim.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.priorETag }, ...metadata });
  if (table === null || full === null) throw new Error('Expected the conditional writer to win');
  return { etag: full.etag, size: full.size, sha256: await digest(FULL), table: { etag: table.etag, size: table.size, sha256: await digest(TABLE) } };
}

/**
 * A complete published bundle for the toolInputId.
 * @param versionId - The version.
 * @param toolInputId - The toolInputId.
 * @returns The bundle.
 */
function bundle(versionId: string, toolInputId = T): Bundle {
  return { versionId, toolInputId, descriptor: { schemaVersion: 1, sourceFingerprint: H, versionId, toolInputId, planSha256: PLAN } };
}

describe('W §7.1–§7.4 store persistence and write points', () => {
  it('W01 the candidate, its frozen route and pinned toolInputId persist across store instances', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const identity = await started(store, key, 'job-a');
      await store.planPresentation(identity, { route: 'encode', toolInputId: T, planSha256: PLAN });
    });
    const view = await withStore(key, (store) => store.readPresentationMachine(key, H));
    expect(view.candidate).toMatchObject({ state: 'building', jobId: 'job-a', route: 'encode', stage: 'plan', toolInputId: T, pinned: true });
    expect(view.selected).toEqual({ kind: 'unknown' });
    expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
  });

  it('W02 Tp comes before any ledger write: no claim before the plan, the writer gets one after', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const identity = await started(store, key, 'job-a');
      expect(await store.claimSourceLedger(identity, T, DECLARATION)).toBeNull();
      expect((await store.planPresentation(identity, { route: 'encode', toolInputId: T, planSha256: PLAN })).writer).toBe(true);
      expect(await store.claimSourceLedger(identity, T, DECLARATION)).toMatchObject({ key: videoSourceLedgerKeyFor(key), table: { key: tableKeyFor(key) } });
    });
  });

  it('W03 two concurrent plans of the same job make one writer and one claim', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const identity = await started(store, key, 'job-a');
      const plans = await Promise.all([
        store.planPresentation(identity, { route: 'encode', toolInputId: T, planSha256: PLAN }),
        store.planPresentation(identity, { route: 'encode', toolInputId: T, planSha256: PLAN }),
      ]);
      expect(plans.every((plan) => plan.writer)).toBe(true);
      const claims = await Promise.all([store.claimSourceLedger(identity, T, DECLARATION), store.claimSourceLedger(identity, T, DECLARATION)]);
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    });
  });

  it('W04 admitting a new job archives the old candidate and hands its writing over in the same transaction', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'encode', toolInputId: T, planSha256: PLAN });
      const view = await store.admitPresentation(admission(key, 'job-b'));
      expect(view.archive.map((record) => ({ jobId: record.jobId, archived: record.archived, pinned: record.pinned }))).toEqual([{ jobId: 'job-a', archived: true, pinned: false }]);
      expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: true, waiters: [] });
      const b = { ...a, jobId: 'job-b', token: (await store.startPresentation({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW)).token! };
      expect((await store.planPresentation(b, { route: 'encode', toolInputId: T, planSha256: PLAN })).writer).toBe(true);
      expect(await store.claimSourceLedger(a, T, DECLARATION)).toBeNull();
      expect(await store.claimSourceLedger(b, T, DECLARATION)).not.toBeNull();
    });
  });

  it('W05 commitLedger accepts only the writer\'s measured objects and turns the instance ready', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'encode', toolInputId: T, planSha256: PLAN });
      const claim = (await store.claimSourceLedger(a, T, DECLARATION))!;
      const measured = await putLedger(claim, 'job-a');
      expect(await store.commitLedger({ ...a, jobId: 'job-x' }, T, claim.owner, measured)).toBe(false);
      expect((await store.readPresentationMachine(key, H)).ledgers[T]!.kind).toBe('pending');
      expect(await store.commitLedger(a, T, claim.owner, measured)).toBe(true);
      expect((await store.readPresentationMachine(key, H)).ledgers[T]!.kind).toBe('ready');
    });
  });

  it.each(['too_long', 'packed_over_cap', 'packed_clock_mismatch'])('W06 failLedger never writes the candidate code %s into the instance', async (code) => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'encode', toolInputId: T, planSha256: PLAN });
      await store.failLedger(a, T, code);
      expect((await store.readPresentationMachine(key, H)).ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
    });
  });

  it('W07 a content ledger failure fails a verified candidate waiting on it with that code', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      // A selected version with another toolInputId makes the new candidate wait for its own ledger.
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'identity', toolInputId: T2, planSha256: PLAN });
      const claimA = (await store.claimSourceLedger(a, T2, DECLARATION))!;
      await store.commitLedger(a, T2, claimA.owner, await putLedger(claimA, 'job-a'));
      await store.verifyPresentation(a, bundle('e'.repeat(64), T2));
      await store.admitPresentation(admission(key, 'job-b'));
      const b = { ...a, jobId: 'job-b', token: (await store.startPresentation({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW)).token! };
      await store.planPresentation(b, { route: 'identity', toolInputId: T, planSha256: PLAN });
      const waiting = await store.verifyPresentation(b, bundle('f'.repeat(64)));
      expect(waiting.candidate.state).toBe('verified');
      expect(waiting.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T2 } });
      await store.failLedger(b, T, 'invalid_edit');
      const after = await store.readPresentationMachine(key, H);
      expect(after.ledgers[T]).toEqual({ kind: 'failed-content', code: 'invalid_edit' });
      expect(after.candidate).toMatchObject({ state: 'failed', failure: 'invalid_edit', pinned: false });
      expect(after.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T2 } });
    });
  });

  it('W08 a verified candidate waiting on its new ledger is published when commitLedger makes it ready', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'identity', toolInputId: T2, planSha256: PLAN });
      const claimA = (await store.claimSourceLedger(a, T2, DECLARATION))!;
      await store.commitLedger(a, T2, claimA.owner, await putLedger(claimA, 'job-a'));
      await store.verifyPresentation(a, bundle('e'.repeat(64), T2));
      await store.admitPresentation(admission(key, 'job-b'));
      const b = { ...a, jobId: 'job-b', token: (await store.startPresentation({ storageKey: key, sourceFingerprint: H, jobId: 'job-b', deadlineAt: D }, NOW)).token! };
      await store.planPresentation(b, { route: 'identity', toolInputId: T, planSha256: PLAN });
      await store.verifyPresentation(b, bundle('f'.repeat(64)));
      const claimB = (await store.claimSourceLedger(b, T, DECLARATION))!;
      expect(await store.commitLedger(b, T, claimB.owner, await putLedger(claimB, 'job-b'))).toBe(true);
      const after = await store.readPresentationMachine(key, H);
      expect(after.selected).toEqual({ kind: 'ready', version: { versionId: 'f'.repeat(64), toolInputId: T } });
      expect(JSON.parse(await (await env.BUCKET.get(videoPresentationKeyFor(key)))!.text()) as unknown).toEqual(bundle('f'.repeat(64)).descriptor);
    });
  });

  it('W09 commitPresentationVersion writes the current descriptor (R0) before the DO selection', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'identity', toolInputId: T, planSha256: PLAN });
      const view = await store.verifyPresentation(a, bundle('e'.repeat(64)));
      expect(view.selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T } });
      const stored = await env.BUCKET.get(videoPresentationKeyFor(key));
      expect(JSON.parse(await stored!.text()) as unknown).toEqual(bundle('e'.repeat(64)).descriptor);
    });
  });

  it('W10 an external change of the current descriptor makes the conditional replace fail and leaves the DO selection unknown', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'identity', toolInputId: T, planSha256: PLAN });
      await env.BUCKET.put(videoPresentationKeyFor(key), JSON.stringify({ foreign: true }));
      const view = await store.verifyPresentation(a, bundle('e'.repeat(64)));
      expect(view.selected).toEqual({ kind: 'unknown' });
      expect(JSON.parse(await (await env.BUCKET.get(videoPresentationKeyFor(key)))!.text()) as unknown).toEqual({ foreign: true });
    });
  });

  it('W11 an archived candidate records its verified facts but never publishes', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'identity', toolInputId: T, planSha256: PLAN });
      await store.admitPresentation(admission(key, 'job-b'));
      const view = await store.verifyPresentation(a, bundle('e'.repeat(64)));
      expect(view.archive.find((record) => record.jobId === 'job-a')).toMatchObject({ state: 'verified', archived: true });
      expect(view.selected).toEqual({ kind: 'unknown' });
      expect(await env.BUCKET.head(videoPresentationKeyFor(key))).toBeNull();
    });
  });

  it('W12 a candidate failure code fails the candidate and leaves its ledger instance alone', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'encode', toolInputId: T, planSha256: PLAN });
      const view = await store.failPresentation(a, 'too_long');
      expect(view.candidate).toMatchObject({ state: 'failed', failure: 'too_long', pinned: false });
      expect(view.ledgers[T]).toEqual({ kind: 'pending', writer: 'job-a', writerArchived: false, waiters: [] });
    });
  });

  it('W13 only the latest chunk attempt moves its chunk, and after chunk_retries 3 the candidate fails with the underlying code', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'encode', toolInputId: T, planSha256: PLAN });
      expect(await store.advanceStage(a, 'encode')).toBe(true);
      const unit = { kind: 'presentation-chunk' as const, chunk: 0 };
      await store.reportChunk(a, unit, { kind: 'Sub' });
      await store.reportChunk(a, unit, { kind: 'Fail', attempt: 1, code: 'resource_exhausted', usage: 2 });
      await store.reportChunk(a, unit, { kind: 'Done', attempt: 1, usage: 3 });
      let view = await store.readPresentationMachine(key, H);
      expect(view.chunks[`video-presentation:job-a:chunk:0`]).toMatchObject({ state: 'open', attempt: 2, retries: 2 });
      for (const attempt of [2, 3, 4]) await store.reportChunk(a, unit, { kind: 'Fail', attempt, code: 'invalid_edit', usage: null });
      view = await store.readPresentationMachine(key, H);
      expect(view.chunks[`video-presentation:job-a:chunk:0`]).toMatchObject({ state: 'failed', attempt: 4, retries: 0, failure: 'invalid_edit' });
      expect(view.candidate).toMatchObject({ state: 'failed', failure: 'invalid_edit' });
    });
  });

  it('W14 Sg outside the frozen route is refused and leaves the stored stage', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await started(store, key, 'job-a');
      await store.planPresentation(a, { route: 'copy', toolInputId: T, planSha256: PLAN });
      expect(await store.advanceStage(a, 'encode')).toBe(false);
      expect((await store.readPresentationMachine(key, H)).candidate.stage).toBe('plan');
    });
  });
});
