// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

interface SyncState {
  localVersion: number;
  confirmedVersion: number;
  epoch: number;
  handshakeComplete: boolean;
  pending: { id: string; epoch: number; requestedVersion: number } | null;
}

type SyncEvent =
  | { type: 'local-update' }
  | { type: 'remote-update' }
  | { type: 'handshake-complete'; epoch: number }
  | { type: 'request-sent'; id: string }
  | { type: 'response'; id: string; epoch: number; ok: boolean }
  | { type: 'invalidate' };

interface SyncModule {
  transitionDocSync: (state: SyncState, event: SyncEvent) => SyncState;
}

const modules = import.meta.glob<SyncModule>('../doc-sync.ts');

/**
 * Loads the actual document transition function.
 * @returns The production module.
 * @throws {AssertionError} When the approved transition module is absent.
 */
async function syncModule(): Promise<SyncModule> {
  const load = modules['../doc-sync.ts'];
  expect(typeof load, 'the document sync transition implementation must exist').toBe('function');
  return load();
}

/**
 * Creates the initial facts specified by the approved document lifecycle.
 * @returns An independent initial input.
 * @throws {never} Never.
 */
function initialState(): SyncState {
  return { localVersion: 0, confirmedVersion: 0, epoch: 0, handshakeComplete: false, pending: null };
}

describe('document sync state invariants (inner#1641)', () => {
  it('keeps an empty handshake and remote updates clean', async () => {
    const { transitionDocSync: step } = await syncModule();
    let state = initialState();
    state = step(state, { type: 'handshake-complete', epoch: 0 });
    state = step(state, { type: 'remote-update' });
    state = step(state, { type: 'request-sent', id: 'unused' });
    expect(state).toEqual({ ...initialState(), handshakeComplete: true });
  });

  it('confirms only the request snapshot while preserving newer edits', async () => {
    const { transitionDocSync: step } = await syncModule();
    let state = step(initialState(), { type: 'handshake-complete', epoch: 0 });
    state = step(state, { type: 'local-update' });
    state = step(state, { type: 'request-sent', id: 'first' });
    const first = state.pending;
    expect(first).toEqual({ id: 'first', epoch: 0, requestedVersion: 1 });
    state = step(state, { type: 'local-update' });
    state = step(state, { type: 'request-sent', id: 'overlapping' });
    expect(state.pending).toEqual(first);
    state = step(state, { type: 'response', id: 'first', epoch: 0, ok: true });
    expect(state).toEqual({ localVersion: 2, confirmedVersion: 1, epoch: 0, handshakeComplete: true, pending: null });
    state = step(state, { type: 'request-sent', id: 'second' });
    state = step(state, { type: 'response', id: 'second', epoch: 0, ok: true });
    expect(state).toEqual({ localVersion: 2, confirmedVersion: 2, epoch: 0, handshakeComplete: true, pending: null });
  });

  it('requires the current handshake before requesting a receipt', async () => {
    const { transitionDocSync: step } = await syncModule();
    let state = step(initialState(), { type: 'local-update' });
    state = step(state, { type: 'request-sent', id: 'too-early' });
    expect(state.pending).toBeNull();
    state = step(state, { type: 'handshake-complete', epoch: 0 });
    state = step(state, { type: 'request-sent', id: 'current' });
    expect(state.pending).toEqual({ id: 'current', epoch: 0, requestedVersion: 1 });
  });

  it('invalidates old responses and old handshake microtasks across a reconnect', async () => {
    const { transitionDocSync: step } = await syncModule();
    let state = step(initialState(), { type: 'handshake-complete', epoch: 0 });
    state = step(state, { type: 'local-update' });
    state = step(state, { type: 'request-sent', id: 'old' });
    state = step(state, { type: 'invalidate' });
    expect(state).toEqual({ localVersion: 1, confirmedVersion: 0, epoch: 1, handshakeComplete: false, pending: null });
    state = step(state, { type: 'response', id: 'old', epoch: 0, ok: true });
    state = step(state, { type: 'handshake-complete', epoch: 0 });
    state = step(state, { type: 'request-sent', id: 'too-early' });
    expect(state).toEqual({ localVersion: 1, confirmedVersion: 0, epoch: 1, handshakeComplete: false, pending: null });
    state = step(state, { type: 'handshake-complete', epoch: 1 });
    state = step(state, { type: 'request-sent', id: 'new' });
    state = step(state, { type: 'response', id: 'new', epoch: 1, ok: true });
    expect(state.confirmedVersion).toBe(1);
  });

  it('holds unconfirmed edits after rejection until a new handshake', async () => {
    const { transitionDocSync: step } = await syncModule();
    let state = step(initialState(), { type: 'handshake-complete', epoch: 0 });
    state = step(state, { type: 'local-update' });
    state = step(state, { type: 'request-sent', id: 'readonly' });
    state = step(state, { type: 'response', id: 'readonly', epoch: 0, ok: false });
    expect(state).toEqual({ localVersion: 1, confirmedVersion: 0, epoch: 0, handshakeComplete: false, pending: null });
    state = step(state, { type: 'request-sent', id: 'retry' });
    expect(state.pending).toBeNull();
  });

  it('ignores unrelated and duplicate responses while preserving the current request', async () => {
    const { transitionDocSync: step } = await syncModule();
    let state = step(initialState(), { type: 'handshake-complete', epoch: 0 });
    state = step(state, { type: 'local-update' });
    state = step(state, { type: 'request-sent', id: 'current' });
    const before = structuredClone(state);
    state = step(state, { type: 'response', id: 'other', epoch: 0, ok: true });
    state = step(state, { type: 'response', id: 'current', epoch: -1, ok: true });
    expect(state).toEqual(before);
    state = step(state, { type: 'response', id: 'current', epoch: 0, ok: true });
    state = step(state, { type: 'local-update' });
    state = step(state, { type: 'request-sent', id: 'next' });
    const next = structuredClone(state);
    state = step(state, { type: 'response', id: 'current', epoch: 0, ok: true });
    expect(state).toEqual(next);
  });

  it('preserves monotonic versions and request causality for generated event sequences', async () => {
    const { transitionDocSync: step } = await syncModule();
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 7 }), { maxLength: 150 }), (events) => {
      let state = initialState();
      let model = initialState();
      for (const [index, kind] of events.entries()) {
        const before = structuredClone(state);
        const pending = model.pending;
        const event: SyncEvent = kind === 0 ? { type: 'local-update' }
          : kind === 1 ? { type: 'remote-update' }
            : kind === 2 ? { type: 'handshake-complete', epoch: model.epoch }
              : kind === 3 ? { type: 'request-sent', id: `request-${index}` }
                : kind === 4 ? { type: 'invalidate' }
                  : kind === 5 ? { type: 'response', id: pending?.id ?? 'absent', epoch: model.epoch, ok: true }
                    : kind === 6 ? { type: 'response', id: pending?.id ?? 'absent', epoch: model.epoch, ok: false }
                      : { type: 'response', id: 'stale', epoch: model.epoch - 1, ok: true };
        if (kind === 0) model.localVersion += 1;
        if (kind === 2) model.handshakeComplete = true;
        if (kind === 3 && model.pending === null && model.handshakeComplete && model.localVersion > model.confirmedVersion) {
          model.pending = { id: `request-${index}`, epoch: model.epoch, requestedVersion: model.localVersion };
        }
        if (kind === 4) model = { ...model, epoch: model.epoch + 1, handshakeComplete: false, pending: null };
        if ((kind === 5 || kind === 6) && pending !== null) {
          if (kind === 5) model.confirmedVersion = pending.requestedVersion;
          else model.handshakeComplete = false;
          model.pending = null;
        }
        state = step(state, event);
        expect(state).toEqual(model);
        expect(state.confirmedVersion).toBeGreaterThanOrEqual(before.confirmedVersion);
        expect(state.confirmedVersion).toBeLessThanOrEqual(state.localVersion);
        if (kind === 3 && pending !== null) expect(state.pending).toEqual(pending);
        if (state.pending !== null) {
          expect(state.pending.epoch).toBe(state.epoch);
          expect(state.pending.requestedVersion).toBeLessThanOrEqual(state.localVersion);
          expect(state.handshakeComplete).toBe(true);
        }
      }
    }), { seed: 1641, numRuns: 200 });
  });
});
