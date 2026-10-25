// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { alphaManifestKeyFor, alphaPackedKeyFor, videoPresentationKeyFor } from '@breatic/shared';
import { writeAlphaPacked } from '@ingest/video-presentation-packed.js';
import type { AlphaPackedIdentity, VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import type { PresentationStateTestObject } from './helpers/presentation-state-object.js';

const original = { width: 95, height: 63, duration: 2.4 };
const geometry = { packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };
const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);

/**
 * Construct a complete actual-storage attempt using the approved odd-pixel geometry.
 * @param encoded - Whether a verified encoder has already reported its geometry.
 * @returns Actual durable owner, source admission and private capability.
 * @throws {Error} When real test storage cannot retain the source or admission.
 */
async function fixture(encoded = true): Promise<{
  owner: DurableObjectStub<PresentationStateTestObject>; admission: VideoPresentationAdmission; identity: AlphaPackedIdentity;
}> {
  const key = `video/alpha-write-${crypto.randomUUID()}.mov`;
  await env.BUCKET.put(key, new Uint8Array([1, 2, 3, 4]));
  const admission: VideoPresentationAdmission = { storageKey: key, sourceFingerprint: 'a'.repeat(64), jobId: crypto.randomUUID(), deadlineAt: 1900000000000,
    original, contentType: 'video/quicktime', knownAlpha: true, actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
    packedURL: `https://assets.example.test/${alphaPackedKeyFor(key)}`, manifestURL: `https://assets.example.test/${alphaManifestKeyFor(key)}`,
    limits: { maxSourceBytes: 1024, maxPackedBytes: 1024, crf: 18, preset: 'medium', probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 65536 },
    pricing: { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 }, prices: { vcpu_second_usd: 1, memory_gib_second_usd: 1, disk_gb_second_usd: 1 } } };
  const owner = env.PRESENTATION_STATE_TEST.get(env.PRESENTATION_STATE_TEST.idFromName(key));
  await owner.accept(admission);
  const prepared = await owner.prepare(admission);
  expect(prepared.token).toEqual(expect.any(String));
  const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
  expect(await owner.report({ ...identity, kind: 'probe', classification: 'confirmed_alpha', original,
    evidence: { codecName: 'prores', pixelFormat: 'yuva444p12le', pixelAlpha: 1, alphaMode: null, formatName: 'mov,mp4,m4a,3gp,3g2,mj2', videoStreamIndex: 0 } })).toBe(true);
  if (encoded) expect(await owner.report({ ...identity, kind: 'encoded', ...geometry })).toBe(true);
  return { owner, admission, identity };
}

/**
 * Retain exact bytes in a real Worker-readable stream.
 * @param value - Complete fixture bytes.
 * @returns A one-shot stream of those bytes.
 * @throws {never} No storage work starts here.
 */
function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } });
}

/**
 * Replace a failed accepted attempt without altering the canonical source.
 * @param value - Current actual-storage fixture.
 * @returns Its explicitly accepted new private capability.
 * @throws {Error} When storage or admission fails.
 */
async function replace(value: Awaited<ReturnType<typeof fixture>>): Promise<AlphaPackedIdentity> {
  const current = await value.owner.read(value.admission.storageKey, value.admission.sourceFingerprint);
  await value.owner.advance(value.identity, { ...current.presentation!, state: 'failed', error: 'expired' });
  const replacement = { ...value.admission, repair: true, jobId: crypto.randomUUID(), deadlineAt: value.admission.deadlineAt + 10000 };
  await value.owner.accept(replacement);
  const prepared = await value.owner.prepare(replacement);
  const identity = { sourceFingerprint: replacement.sourceFingerprint, jobId: replacement.jobId, deadlineAt: replacement.deadlineAt, token: prepared.token! };
  expect(await value.owner.report({ ...identity, kind: 'probe', classification: 'confirmed_alpha', original,
    evidence: { codecName: 'prores', pixelFormat: 'yuva444p12le', pixelAlpha: 1, alphaMode: null, formatName: 'mov', videoStreamIndex: 0 } })).toBe(true);
  expect(await value.owner.report({ ...identity, kind: 'encoded', ...geometry })).toBe(true);
  return identity;
}

describe('packed pre-write authorization and physical publication (inner#1306)', () => {
  it('refuses byte writes before complete encoder verification and keeps canonical bytes unchanged', async () => {
    const { owner, admission, identity } = await fixture(false);
    expect(await owner.claimPacked(identity, bytes.length)).toBe(null);
    expect(await env.BUCKET.get(alphaPackedKeyFor(admission.storageKey))).toBe(null);
    expect(Array.from(new Uint8Array(await (await env.BUCKET.get(admission.storageKey))!.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('grants only one physical writer for one accepted attempt', async () => {
    const { owner, identity } = await fixture();
    const claims = await Promise.all([owner.claimPacked(identity, bytes.length), owner.claimPacked(identity, bytes.length)]);
    expect(claims.filter(claim => claim !== null)).toHaveLength(1);
  });

  it('rejects a replaced capability before it can claim any packed bytes', async () => {
    const value = await fixture();
    await replace(value);
    expect(await value.owner.claimPacked(value.identity, bytes.length)).toBe(null);
    expect(await env.BUCKET.get(alphaPackedKeyFor(value.admission.storageKey))).toBe(null);
  });

  it('publishes the complete actual bytes before the owned manifest and ready descriptor', async () => {
    const { owner, admission, identity } = await fixture();
    expect(await writeAlphaPacked({ bucket: env.BUCKET, owner, identity, body: stream(bytes), byteLength: bytes.length })).toEqual({ ok: true, status: 200 });
    const packed = await env.BUCKET.get(alphaPackedKeyFor(admission.storageKey));
    expect(Array.from(new Uint8Array(await packed!.arrayBuffer()))).toEqual(Array.from(bytes));
    expect(packed!.httpMetadata?.contentType).toBe('video/mp4');
    expect(await (await env.BUCKET.get(alphaManifestKeyFor(admission.storageKey)))!.json()).toEqual({ schemaVersion: 1, sourceFingerprint: identity.sourceFingerprint,
      packedURL: admission.packedURL, ...geometry });
    const current = await owner.read(admission.storageKey, identity.sourceFingerprint);
    expect(current.presentation).toMatchObject({ state: 'alpha_ready', original, alpha: { manifestURL: admission.manifestURL } });
    expect(current.attempt).toMatchObject({ jobId: identity.jobId, status: 'completed' });
    expect(await (await env.BUCKET.get(videoPresentationKeyFor(admission.storageKey)))!.json()).toEqual(current.presentation);
    expect(Array.from(new Uint8Array(await (await env.BUCKET.get(admission.storageKey))!.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('fails ready presentation when its actual packed receipt changes despite the same MIME and byte count', async () => {
    const { owner, admission, identity } = await fixture();
    expect(await writeAlphaPacked({ bucket: env.BUCKET, owner, identity, body: stream(bytes), byteLength: bytes.length })).toEqual({ ok: true, status: 200 });
    const key = alphaPackedKeyFor(admission.storageKey);
    const previous = await env.BUCKET.head(key);
    const changed = bytes.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    const overwritten = await env.BUCKET.put(key, changed, { httpMetadata: { contentType: 'video/mp4' } });
    expect(overwritten.etag).not.toBe(previous!.etag);
    expect(overwritten.size).toBe(previous!.size);
    const current = await owner.read(admission.storageKey, identity.sourceFingerprint);
    expect(current.presentation).toMatchObject({ state: 'failed', error: 'presentation_missing', original });
    expect(current.attempt).toMatchObject({ status: 'failed', error: 'presentation_missing' });
    expect(current.manifest).toBeUndefined();
    expect(Array.from(new Uint8Array(await (await env.BUCKET.get(admission.storageKey))!.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it.each(['jobId', 'sourceFingerprint', 'deadlineAt', 'token'] as const)('refuses altered %s before reserving a writer', async (field) => {
    const { owner, admission, identity } = await fixture();
    const altered = { ...identity, [field]: field === 'deadlineAt' ? identity.deadlineAt + 1 : field === 'sourceFingerprint' ? 'b'.repeat(64) : 'not-the-accepted-owner' };
    const before = await owner.read(admission.storageKey, identity.sourceFingerprint);
    expect(await owner.claimPacked(altered, bytes.length)).toBe(null);
    expect(await owner.read(admission.storageKey, identity.sourceFingerprint)).toEqual(before);
    expect(await env.BUCKET.get(alphaPackedKeyFor(admission.storageKey))).toBe(null);
    expect(await owner.claimPacked(identity, bytes.length)).not.toBe(null);
  });

  it('refuses truncated streams without publishing a manifest or readiness', async () => {
    const { owner, admission, identity } = await fixture();
    await expect(writeAlphaPacked({ bucket: env.BUCKET, owner, identity, body: stream(bytes.slice(0, 4)), byteLength: bytes.length })).rejects.toThrow();
    expect(await env.BUCKET.get(alphaManifestKeyFor(admission.storageKey))).toBe(null);
    expect((await owner.read(admission.storageKey, identity.sourceFingerprint)).presentation?.state).toBe('alpha_pending');
  });

  it('fences an already claimed old stream against the actual version written by its replacement', async () => {
    const value = await fixture();
    const old = await value.owner.claimPacked(value.identity, bytes.length);
    expect(old).not.toBe(null);
    const fresh = await replace(value);
    expect(await writeAlphaPacked({ bucket: env.BUCKET, owner: value.owner, identity: fresh, body: stream(bytes), byteLength: bytes.length })).toEqual({ ok: true, status: 200 });
    const before = await env.BUCKET.head(old!.key);
    const late = await env.BUCKET.put(old!.key, new Uint8Array([9, 9, 9]), { onlyIf: old!.etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: old!.etag } });
    expect(late).toBe(null);
    expect((await env.BUCKET.head(old!.key))!.etag).toBe(before!.etag);
    expect(await value.owner.completePacked(value.identity, old!.owner, { etag: before!.etag, size: bytes.length, sha256: 'b'.repeat(64) })).toBe(false);
    expect((await value.owner.read(value.admission.storageKey, fresh.sourceFingerprint)).presentation?.attempt?.jobId).toBe(fresh.jobId);
  });

  it('retains the original measured platform usage when a failed report publishes its descriptor', async () => {
    const { owner, admission, identity } = await fixture();
    await owner.report({ ...identity, kind: 'finished', usage: { wallMs: 1000, cpuUsec: 10 }, error: 'packed_clock_mismatch' });
    const snapshot = await owner.read(admission.storageKey, identity.sourceFingerprint);
    expect(snapshot.presentation).toMatchObject({ state: 'failed', error: 'packed_clock_mismatch' });
    expect(snapshot.usageFact).toMatchObject({ jobId: identity.jobId, actorUserId: admission.actorUserId, projectId: null, usage: { wallMs: 1000, cpuUsec: 10 }, pricing: admission.pricing });
  });

  it('accepts an archived late expense without reviving its replaced source attempt', async () => {
    const value = await fixture();
    const fresh = await replace(value);
    const before = await value.owner.read(value.admission.storageKey, fresh.sourceFingerprint);
    expect(await value.owner.report({ ...value.identity, kind: 'finished', usage: { wallMs: 250, cpuUsec: 10 } })).toBe(true);
    expect(await value.owner.read(value.admission.storageKey, fresh.sourceFingerprint)).toEqual(before);
    expect((await value.owner.snapshotFor(value.identity)).usageFact).toMatchObject({ jobId: value.identity.jobId, usage: { wallMs: 250, cpuUsec: 10 } });
  });
});

describe('registered metadata constraints before truthful presentation (inner#1306)', () => {
  it('refuses a partial known display width that contradicts the trusted probe', async () => {
    const value = await fixture(false);
    const current = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    await value.owner.advance(value.identity, { ...current.presentation!, state: 'failed', error: 'expired' });
    const admission = { ...value.admission, original: null, registeredMetadata: { width: 95, height: null, duration: null }, repair: true, jobId: crypto.randomUUID() };
    await value.owner.accept(admission);
    const prepared = await value.owner.prepare(admission);
    const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
    await value.owner.report({ ...identity, kind: 'probe', classification: 'confirmed_opaque', original: { width: 96, height: 63, duration: 2.4 },
      evidence: { codecName: 'h264', pixelFormat: 'yuv420p', pixelAlpha: 0, alphaMode: null, formatName: 'mov', videoStreamIndex: 0 } });
    const snapshot = await value.owner.read(admission.storageKey, admission.sourceFingerprint);
    expect(snapshot.presentation).toBe(null);
    expect(snapshot.attempt).toMatchObject({ status: 'failed', error: 'metadata_mismatch' });
  });

  it.each([[1.323333, 'native'], [1.324333, 'failed']] as const)('compares trusted duration %s with numeric(12,3) registered 1.323', async (duration, state) => {
    const value = await fixture(false);
    const current = await value.owner.read(value.admission.storageKey, value.identity.sourceFingerprint);
    await value.owner.advance(value.identity, { ...current.presentation!, state: 'failed', error: 'expired' });
    const admission = { ...value.admission, original: { ...original, duration: 1.323 }, registeredMetadata: { width: 95, height: 63, duration: 1.323 }, repair: true, jobId: crypto.randomUUID() };
    await value.owner.accept(admission);
    const prepared = await value.owner.prepare(admission);
    const identity = { sourceFingerprint: admission.sourceFingerprint, jobId: admission.jobId, deadlineAt: admission.deadlineAt, token: prepared.token! };
    await value.owner.report({ ...identity, kind: 'probe', classification: 'confirmed_opaque', original: { ...original, duration },
      evidence: { codecName: 'h264', pixelFormat: 'yuv420p', pixelAlpha: 0, alphaMode: null, formatName: 'mov', videoStreamIndex: 0 } });
    const snapshot = await value.owner.read(admission.storageKey, admission.sourceFingerprint);
    expect(snapshot.presentation?.state).toBe(state);
    expect(snapshot.attempt?.status).toBe(state === 'native' ? 'completed' : 'failed');
  });
});
