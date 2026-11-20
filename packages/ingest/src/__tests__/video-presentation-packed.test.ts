// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Carrier publication, usage and registered constraints over real storage and R2
 * (inner#1306, test plan §89 rewrite of the v1 packed cases; frames-split design
 * §7.2, §7.3, §7.6, §3.1).
 *
 * The presentation DO no longer grants packed byte writers: a packed carrier is
 * written by a standard-4 job under its own job token (§7.3), so the v1 claim,
 * single-writer and fencing cases of that writer move to the job store. What stays
 * here is what the DO itself decides: a bundle is selected only when every object
 * it names exists with the measured bytes (§7.2), usage is kept per original job
 * and an archived job's late expense never revives it (§7.6), and the published
 * original never contradicts the registered measurement (§3.1).
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { admission, bundle, digest, H, NOW, PLAN, source, storedDescriptor, T, withStore, type Bundle, type Identity, type MachineStore } from './helpers/machine-store.js';

/**
 * Store one object and return its measured small receipt.
 * @param key - The object key.
 * @param bytes - The bytes.
 * @param contentType - The type.
 * @returns The receipt as a descriptor names it.
 */
async function stored(key: string, bytes: Uint8Array, contentType: string): Promise<Record<string, unknown>> {
  const object = await env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  return { storageKey: key, url: `https://assets.example.test/${key}`, etag: object.etag, size: object.size, sha256: await digest(bytes), contentType };
}

/**
 * An alpha-packed bundle whose packed carrier and manifest are stored.
 * @param key - The source key.
 * @returns The bundle.
 */
async function alphaBundle(key: string): Promise<Bundle> {
  const base = await bundle(key, 'e'.repeat(64));
  const carrier = await stored(`${key}.job-a.packed.mp4`, new Uint8Array([9, 8, 7, 6, 5]), 'video/mp4');
  const manifest = await stored(`${key}.job-a.alpha.json`, new TextEncoder().encode(JSON.stringify({ packed: carrier })), 'application/json');
  return { ...base, descriptor: { ...base.descriptor, playback: { kind: 'alpha-packed', carrier, manifest } } };
}

/**
 * Admit, start and plan a publish-only (carrier reuse) route job with registered metadata.
 * @param store - The store.
 * @param key - The source key.
 * @param registered - The registered measurement.
 * @returns The identity.
 */
async function plannedWith(store: MachineStore, key: string, registered?: { width: number | null; height: number | null; duration: number | null }): Promise<Identity> {
  await store.accept({ ...admission(key, 'job-a'), ...(registered === undefined ? {} : { registeredMetadata: registered }) });
  const { token } = await store.prepare({ storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: admission(key, 'job-a').deadlineAt }, NOW);
  const identity = { storageKey: key, sourceFingerprint: H, jobId: 'job-a', deadlineAt: admission(key, 'job-a').deadlineAt, token: token! };
  await store.planPresentation(identity, { route: 'reuse', toolInputId: T, planSha256: PLAN });
  return identity;
}

describe('carrier publication (inner#1306 §7.2, §7.3)', () => {
  it('publishes an alpha-packed bundle only after its packed carrier and manifest are stored, then writes the descriptor', async () => {
    const key = await source();
    const published = await alphaBundle(key);
    await withStore(key, async (store) => {
      const a = await plannedWith(store, key);
      expect((await store.report(a, { kind: 'verified', bundle: published })).selected).toEqual({ kind: 'ready', version: { versionId: 'e'.repeat(64), toolInputId: T } });
    });
    expect(await storedDescriptor(key)).toEqual(published.descriptor);
  });

  it('refuses an alpha-packed bundle while its manifest object is absent', async () => {
    const key = await source();
    const published = await alphaBundle(key);
    await env.BUCKET.delete(`${key}.job-a.alpha.json`);
    await withStore(key, async (store) => {
      const a = await plannedWith(store, key);
      expect((await store.report(a, { kind: 'verified', bundle: published })).selected).toEqual({ kind: 'unknown' });
    });
    expect(await storedDescriptor(key)).toBeNull();
  });

  it('refuses a carrier whose stored bytes changed despite the same type and byte count', async () => {
    const key = await source();
    const published = await alphaBundle(key);
    await env.BUCKET.put(`${key}.job-a.packed.mp4`, new Uint8Array([1, 1, 1, 1, 1]), { httpMetadata: { contentType: 'video/mp4' } });
    await withStore(key, async (store) => {
      const a = await plannedWith(store, key);
      expect((await store.report(a, { kind: 'verified', bundle: published })).selected).toEqual({ kind: 'unknown' });
    });
  });
});

describe('usage of each original job (inner#1306 §7.6, mechanism unchanged)', () => {
  it('keeps the measured usage of a job that failed, and records its acknowledgement', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await plannedWith(store, key);
      await store.report(a, { kind: 'finished', usage: { wallMs: 120, cpuUsec: 7 } });
      await store.fail(a, 'packed_clock_mismatch');
      expect((await store.read(key, H)).usage['job-a']).toEqual({ wallMs: 120, cpuUsec: 7, acknowledged: false });
      expect((await store.acknowledgeUsage(a)).usage['job-a']).toEqual({ wallMs: 120, cpuUsec: 7, acknowledged: true });
    });
  });

  it('records an archived job\'s late expense without reviving it', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await plannedWith(store, key);
      await store.accept(admission(key, 'job-b'));
      const view = await store.report(a, { kind: 'finished', usage: { wallMs: 50, cpuUsec: null } });
      expect(view.usage['job-a']).toEqual({ wallMs: 50, cpuUsec: null, acknowledged: false });
      expect(view.candidate.jobId).toBe('job-b');
      expect(view.archive.find((record) => record.jobId === 'job-a')!.archived).toBe(true);
    });
  });
});

describe('registered measurement constraints (inner#1306 §3.1)', () => {
  it('does not select a version whose original width contradicts a known registered width', async () => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await plannedWith(store, key, { width: 96, height: null, duration: null });
      expect((await store.report(a, { kind: 'verified', bundle: await bundle(key, 'e'.repeat(64)) })).selected).toEqual({ kind: 'unknown' });
    });
  });

  it.each([[1.323333, 'ready'], [1.324333, 'unknown']] as const)('compares original duration %s with the numeric(12,3) registered 1.323 (selection %s)', async (duration, kind) => {
    const key = await source();
    await withStore(key, async (store) => {
      const a = await plannedWith(store, key, { width: null, height: null, duration: 1.323 });
      const published = await bundle(key, 'e'.repeat(64));
      published.descriptor.original = { width: 95, height: 63, duration };
      expect((await store.report(a, { kind: 'verified', bundle: published })).selected.kind).toBe(kind);
    });
  });
});
