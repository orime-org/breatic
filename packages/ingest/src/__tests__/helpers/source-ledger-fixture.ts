// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import * as sharedModule from '@breatic/shared';
import { alphaManifestKeyFor, alphaPackedKeyFor, videoSourceLedgerKeyFor } from '@breatic/shared';
import type { VideoSourceLedgerReceiptV2 } from '@shared/upload/video-source-ledger-types.js';
import type { AlphaPackedIdentity, AlphaPackedReceipt, SourceLedgerDeclaration, SourceLedgerWriteClaim, VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import type { PresentationStateTestObject } from '@ingest/__tests__/helpers/presentation-state-object.js';

export const ORIGINAL = { width: 95, height: 63, duration: 2.4 };
// inner#1306 §77: six budgets, no frame-count ceiling.
export const LEDGER_LIMITS = { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216,
  isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 };
export const PRICING = { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 },
  prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } };
/** The compact table every fixture ledger presents: three frames of 1/25 s from zero. */
export const TABLE = { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] };
export const TABLE_FRAMES = 3;
export interface LedgerFixture {
  owner: DurableObjectStub<PresentationStateTestObject>;
  admission: VideoPresentationAdmission;
  identity: AlphaPackedIdentity;
  /** The full v2 ledger JSON. */
  bytes: Uint8Array;
  /** The compact presentation table JSON written with it. */
  tableBytes: Uint8Array;
  /** One producer write: the table bytes, then the ledger bytes. */
  body: Uint8Array;
  declaration: SourceLedgerDeclaration;
}
/** Ledger and table measurements a producer write reports to the store. */
export interface MeasuredPair extends AlphaPackedReceipt { table: AlphaPackedReceipt }

/**
 * The registered key of the compact table; a missing export fails the case that reaches it.
 * @param key - Registered storage key.
 * @returns The table key.
 * @throws {Error} When shared does not export the derivation.
 */
export function tableKeyFor(key: string): string {
  const derive = (sharedModule as Record<string, unknown>).videoSourceLedgerTableKeyFor;
  expect(typeof derive).toBe('function');
  return (derive as (value: string) => string)(key);
}

/** Bind a minimal v2 ledger to the actual accepted fixture identity. @throws {never} Never. */
export function bytesFor(identity: AlphaPackedIdentity): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, sourceFingerprint: identity.sourceFingerprint, producerVersion: 2,
    attempt: { jobId: identity.jobId, deadlineAt: identity.deadlineAt }, presentation: TABLE,
    source: { timeBase: { numerator: '1', denominator: '1000' }, runs: [{ start: 0, count: 3, step: 40 }] }, videoEdits: null, audioEdits: null }));
}

/** Concatenate the producer's one write body. @throws {never} Never. */
function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0); out.set(second, first.length);
  return out;
}

/**
 * Everything one producer attempt writes for this identity.
 * @param identity - The accepted attempt.
 * @returns Ledger, table, the joined body and the declaration.
 * @throws {never} Never.
 */
function written(identity: AlphaPackedIdentity): Pick<LedgerFixture, 'bytes' | 'tableBytes' | 'body' | 'declaration'> {
  const bytes = bytesFor(identity);
  const tableBytes = new TextEncoder().encode(JSON.stringify(TABLE));
  return { bytes, tableBytes, body: concat(tableBytes, bytes),
    declaration: { producerVersion: 2, byteLength: bytes.length, table: { byteLength: tableBytes.length, frameCount: TABLE_FRAMES } } };
}

/** Create actual unique R2 and DO state without starting a media container. @throws {Error} When actual storage/admission fails. */
export async function fixture(options: { requested?: boolean; deadlineAt?: number; knownAlpha?: boolean } = {}): Promise<LedgerFixture> {
  const key = `video/source-ledger-${crypto.randomUUID()}.webm`;
  await env.BUCKET.put(key, new Uint8Array([1, 2, 3, 4]));
  const admission: VideoPresentationAdmission = { storageKey: key, sourceFingerprint: 'a'.repeat(64), jobId: crypto.randomUUID(),
    deadlineAt: options.deadlineAt ?? 1900000000000, original: ORIGINAL, contentType: 'video/webm', knownAlpha: options.knownAlpha ?? false,
    actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null, pricing: PRICING,
    packedURL: `https://assets.example.test/${alphaPackedKeyFor(key)}`, manifestURL: `https://assets.example.test/${alphaManifestKeyFor(key)}`,
    limits: { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium',
      probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536,
      ...(options.requested === false ? {} : { sourceLedger: { ...LEDGER_LIMITS } }) },
    ...(options.requested === false ? {} : { sourceLedgerURL: `https://assets.example.test/${videoSourceLedgerKeyFor(key)}`,
      sourceLedgerTableURL: `https://assets.example.test/${tableKeyFor(key)}` }),
  };
  const owner = env.PRESENTATION_STATE_TEST.get(env.PRESENTATION_STATE_TEST.idFromName(key));
  await owner.accept(admission);
  const prepared = await owner.prepare(admission);
  expect(prepared.token).toEqual(expect.any(String));
  const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
  return { owner, admission, identity, ...written(identity) };
}

/** Expose complete bytes, keeping cancellation-observed sources live until demand. @throws {never} Never. */
export function stream(bytes: Uint8Array, canceled?: () => void): ReadableStream<Uint8Array> {
  if (canceled === undefined) return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  let emitted = false;
  return new ReadableStream({
    pull(controller) {
      if (emitted) { controller.close(); return; }
      emitted = true;
      controller.enqueue(bytes);
    },
    cancel() { canceled(); },
  }, { highWaterMark: 0 });
}

/** Compute an independent standard SHA over literal input, not through the production hash helper. @throws {Error} When the platform digest fails. */
export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Persist both claimed objects using actual conditional R2 semantics. @throws {Error} When either write is not the actual winner. */
export async function putClaim(value: LedgerFixture, claim: SourceLedgerWriteClaim): Promise<MeasuredPair> {
  const metadata = { httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: value.identity.jobId, sourceLedgerClaimOwner: claim.owner } };
  const table = await env.BUCKET.put(claim.table.key, value.tableBytes, { onlyIf: claim.table.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.table.priorETag }, ...metadata });
  const written = await env.BUCKET.put(claim.key, value.bytes, { onlyIf: claim.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.priorETag }, ...metadata });
  if (written === null || table === null) throw new Error('Expected actual conditional winner');
  return { etag: written.etag, size: written.size, sha256: await digest(value.bytes), table: { etag: table.etag, size: table.size, sha256: await digest(value.tableBytes) } };
}

/** Exact public v2 receipt for the actual ledger bytes and the fixture's table under their true original producer. @throws {Error} When the platform digest fails. */
export async function receipt(value: LedgerFixture, measured: AlphaPackedReceipt): Promise<VideoSourceLedgerReceiptV2> {
  return { schemaVersion: 2, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 2,
    attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt }, url: value.admission.sourceLedgerURL!,
    etag: measured.etag, size: measured.size, sha256: measured.sha256, contentType: 'application/json',
    table: { url: value.admission.sourceLedgerTableURL!, sha256: await digest(value.tableBytes), size: value.tableBytes.length, frameCount: TABLE_FRAMES } };
}

/** Replace only terminal original work through the existing explicit repair admission. @throws {Error} When actual admission fails. */
export async function replacement(value: LedgerFixture, deadlineAt = value.admission.deadlineAt + 10000): Promise<LedgerFixture> {
  await value.owner.fail(value.identity, 'expired');
  const admission = { ...value.admission, repair: true, jobId: crypto.randomUUID(), deadlineAt };
  await value.owner.accept(admission);
  const prepared = await value.owner.prepare(admission);
  expect(prepared.token).toEqual(expect.any(String));
  const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
  return { ...value, admission, identity, ...written(identity) };
}
