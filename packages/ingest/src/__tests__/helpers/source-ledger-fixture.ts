// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import { alphaManifestKeyFor, alphaPackedKeyFor, videoSourceLedgerKeyFor, type VideoSourceLedgerReceipt } from '@breatic/shared';
import type { AlphaPackedIdentity, AlphaPackedReceipt, SourceLedgerDeclaration, SourceLedgerWriteClaim, VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import type { PresentationStateTestObject } from '@ingest/__tests__/helpers/presentation-state-object.js';
import { SOURCE_LEDGER_LITERAL } from '@ingest/__tests__/helpers/source-ledger-literal.js';

export const ORIGINAL = { width: 95, height: 63, duration: 2.4 };
export const LEDGER_LIMITS = { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, maxPhysicalFrames: 100000,
  maxOccurrences: 100000, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 };
export const PRICING = { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 },
  prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } };
export interface LedgerFixture {
  owner: DurableObjectStub<PresentationStateTestObject>;
  admission: VideoPresentationAdmission;
  identity: AlphaPackedIdentity;
  bytes: Uint8Array;
  declaration: SourceLedgerDeclaration;
}

/** Bind copied independent ledger values to the actual accepted fixture identity. @throws {never} Never. */
export function bytesFor(identity: AlphaPackedIdentity): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ...SOURCE_LEDGER_LITERAL, sourceFingerprint: identity.sourceFingerprint,
    attempt: { jobId: identity.jobId, deadlineAt: identity.deadlineAt } }));
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
    ...(options.requested === false ? {} : { sourceLedgerURL: `https://assets.example.test/${videoSourceLedgerKeyFor(key)}` }),
  };
  const owner = env.PRESENTATION_STATE_TEST.get(env.PRESENTATION_STATE_TEST.idFromName(key));
  await owner.accept(admission);
  const prepared = await owner.prepare(admission);
  expect(prepared.token).toEqual(expect.any(String));
  const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
  const bytes = bytesFor(identity);
  return { owner, admission, identity, bytes, declaration: { producerVersion: 1, strategy: 'iso_unedited_rate_one', byteLength: bytes.length, physicalFrameCount: 3, occurrenceCount: 3 } };
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

/** Persist one complete claimed object using actual conditional R2 semantics. @throws {Error} When the write is not the actual winner. */
export async function putClaim(value: LedgerFixture, claim: SourceLedgerWriteClaim): Promise<AlphaPackedReceipt> {
  const written = await env.BUCKET.put(claim.key, value.bytes, {
    onlyIf: claim.priorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: claim.priorETag },
    httpMetadata: { contentType: 'application/json' }, customMetadata: { sourceLedgerJobId: value.identity.jobId, sourceLedgerClaimOwner: claim.owner },
  });
  if (written === null) throw new Error('Expected actual conditional winner');
  return { etag: written.etag, size: written.size, sha256: await digest(value.bytes) };
}

/** Exact public receipt for actual bytes under their true original producer. @throws {never} Never. */
export function receipt(value: LedgerFixture, measured: AlphaPackedReceipt): VideoSourceLedgerReceipt {
  return { schemaVersion: 1, sourceFingerprint: value.identity.sourceFingerprint, producerVersion: 1, strategy: 'iso_unedited_rate_one',
    attempt: { jobId: value.identity.jobId, deadlineAt: value.identity.deadlineAt }, url: value.admission.sourceLedgerURL!,
    etag: measured.etag, size: measured.size, sha256: measured.sha256, contentType: 'application/json', physicalFrameCount: 3, occurrenceCount: 3 };
}

/** Replace only terminal original work through the existing explicit repair admission. @throws {Error} When actual admission fails. */
export async function replacement(value: LedgerFixture, deadlineAt = value.admission.deadlineAt + 10000): Promise<LedgerFixture> {
  await value.owner.fail(value.identity, 'expired');
  const admission = { ...value.admission, repair: true, jobId: crypto.randomUUID(), deadlineAt };
  await value.owner.accept(admission);
  const prepared = await value.owner.prepare(admission);
  expect(prepared.token).toEqual(expect.any(String));
  const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
  const bytes = bytesFor(identity);
  return { ...value, admission, identity, bytes, declaration: { ...value.declaration, byteLength: bytes.length } };
}
