// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor, type VideoPresentation } from '@breatic/shared';
import type { VideoPresentationAdmission } from '../video-presentation-store.js';
import type { PresentationStateTestObject } from './helpers/presentation-state-object.js';

/**
 * Give every test actual independent durable storage and an immutable source object.
 * @param original - Complete measurements or none before trusted probing.
 * @returns Its actual storage owner and first accepted request.
 * @throws {Error} When test R2 cannot store the canonical bytes.
 */
async function fixture(original: VideoPresentation['original'] | null = null): Promise<{
  owner: DurableObjectStub<PresentationStateTestObject>;
  input: VideoPresentationAdmission;
}> {
  const storageKey = `video/presentation-state-${crypto.randomUUID()}.webm`;
  await env.BUCKET.put(storageKey, new Uint8Array([1, 2, 3, 4]));
  return {
    owner: env.PRESENTATION_STATE_TEST.get(env.PRESENTATION_STATE_TEST.idFromName(storageKey)),
    input: { storageKey, sourceFingerprint: 'a'.repeat(64), jobId: `presentation-${crypto.randomUUID()}`,
      deadlineAt: 1900000000000, contentType: 'video/webm', original },
  };
}

describe('durable presentation attempt admission (inner#1306 §6.20)', () => {
  it('retains unknown media without publishing an invalid zero-sized descriptor', async () => {
    const { owner, input } = await fixture();
    expect(await owner.accept(input)).toEqual({ presentation: null, attempt: {
      jobId: input.jobId, deadlineAt: input.deadlineAt, status: 'accepted', usage: null,
    } });
    expect(await env.BUCKET.get(videoPresentationKeyFor(input.storageKey))).toBe(null);
    expect(Array.from(new Uint8Array(await (await env.BUCKET.get(input.storageKey))!.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('atomically replays one first accepted identity when two admissions overlap', async () => {
    const { owner, input } = await fixture();
    const other = { ...input, jobId: `${input.jobId}-later`, deadlineAt: input.deadlineAt + 10000 };
    const [first, second] = await Promise.all([owner.accept(input), owner.accept(other)]);
    expect(first.attempt).toEqual(second.attempt);
    expect([{ jobId: input.jobId, deadlineAt: input.deadlineAt, status: 'accepted', usage: null },
      { jobId: other.jobId, deadlineAt: other.deadlineAt, status: 'accepted', usage: null }]).toContainEqual(first.attempt);
  });

  it('persists a complete classifying descriptor without changing the canonical object', async () => {
    const { owner, input } = await fixture({ width: 95, height: 63, duration: 2.4 });
    const presentation: VideoPresentation = { schemaVersion: 1, sourceFingerprint: input.sourceFingerprint,
      original: input.original!, state: 'classifying', attempt: { jobId: input.jobId, deadlineAt: input.deadlineAt } };
    expect((await owner.accept(input)).presentation).toEqual(presentation);
    expect(await (await env.BUCKET.get(videoPresentationKeyFor(input.storageKey)))!.json()).toEqual(presentation);
    expect(Array.from(new Uint8Array(await (await env.BUCKET.get(input.storageKey))!.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('keeps the parent deadline when an in-flight repair supplies a newer proposed budget', async () => {
    const { owner, input } = await fixture();
    await owner.accept(input);
    expect((await owner.accept({ ...input, repair: true, jobId: 'replacement', deadlineAt: input.deadlineAt + 10000 })).attempt)
      .toEqual({ jobId: input.jobId, deadlineAt: input.deadlineAt, status: 'accepted', usage: null });
  });

  it('rejects a replaced failed attempt even when it finishes later', async () => {
    const { owner, input } = await fixture({ width: 95, height: 63, duration: 2.4 });
    const pending = (await owner.accept(input)).presentation!;
    await owner.advance(input, { ...pending, state: 'failed', error: 'expired' });
    const replacement = { ...input, repair: true, jobId: 'repair-new', deadlineAt: input.deadlineAt + 10000 };
    const newer = await owner.accept(replacement);
    expect(newer.attempt?.jobId).toBe('repair-new');
    expect(await owner.advance(input, { ...pending, state: 'native' })).toEqual(newer);
  });

  it('refuses alpha ready while its packed and manifest objects are absent', async () => {
    const { owner, input } = await fixture({ width: 95, height: 63, duration: 2.4 });
    const accepted = await owner.accept({ ...input, knownAlpha: true });
    expect(accepted.presentation).toEqual({ schemaVersion: 1, sourceFingerprint: input.sourceFingerprint,
      original: input.original, state: 'alpha_pending', attempt: { jobId: input.jobId, deadlineAt: input.deadlineAt } });
    const ready: VideoPresentation = { ...accepted.presentation!, state: 'alpha_ready', alpha: {
      manifestURL: 'https://assets.example.test/unwritten.alpha.v1.json',
    } };
    const result = await owner.advance(input, ready);
    expect(result.presentation).toEqual(accepted.presentation);
    expect(await (await env.BUCKET.get(videoPresentationKeyFor(input.storageKey)))!.json()).toEqual(accepted.presentation);
  });
});
