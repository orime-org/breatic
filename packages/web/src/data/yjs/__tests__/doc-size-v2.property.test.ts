// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec P-04:
 * over any sequence of pushes, refusal closes and `synced`, the size state
 * equals the one a reference model of DD 6.3 derives.
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import { push, refuse, resetProviderSpies, synced, type ProviderSpy } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { PUSHES_V2, type DocSizePushV2 } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { readDocSize, type DocSizePhase } from '@web/data/yjs/doc-size';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';

const NAME = docName.canvasSpace('p1', 's1');

/** One event of the sequence. */
type Event = { type: 'push'; push: DocSizePushV2 } | { type: 'refuse' } | { type: 'synced' };

/** The reference model of DD 6.3 for one document. */
interface Model {
  /** The push in effect, which a rebuild keeps on screen. */
  shown: DocSizePushV2 | null;
  /** The last push received. */
  latest: DocSizePushV2 | null;
  resyncing: boolean;
}

/**
 * The model after one event.
 * @param model - The model before.
 * @param event - The event.
 * @returns The model after.
 * @throws {never} Never.
 */
function step(model: Model, event: Event): Model {
  if (event.type === 'push') return { ...model, latest: event.push, shown: model.resyncing ? model.shown : event.push };
  if (event.type === 'refuse') return { ...model, resyncing: true };
  return model.resyncing ? { ...model, resyncing: false, shown: model.latest } : model;
}

/**
 * The phase the model shows.
 * @param model - The model.
 * @returns The phase.
 * @throws {never} Never.
 */
function phaseOf(model: Model): DocSizePhase {
  if (model.resyncing) return 'resyncing';
  if (model.shown === null || model.shown.limit === 0) return 'unknown';
  return model.shown.phase;
}

const eventArb: fc.Arbitrary<Event> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...Object.values(PUSHES_V2)).map((p): Event => ({ type: 'push', push: p })) },
  { weight: 1, arbitrary: fc.constant<Event>({ type: 'refuse' }) },
  { weight: 1, arbitrary: fc.constant<Event>({ type: 'synced' }) },
);

/**
 * Opens the document the way a tab (or a rebuilt Space) does.
 * @returns The provider spy.
 * @throws {Error} When acquiring fails.
 */
function open(): ProviderSpy {
  return acquireDocProvider(NAME, getDoc(NAME)) as unknown as ProviderSpy;
}

/**
 * Tears down every provider, document and size state.
 * @throws {never} Never.
 */
function reset(): void {
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
}

afterEach(reset);

describe('size state against the DD 6.3 model (P-04)', () => {
  it('P-04 after every event the phase and overCeiling match the model', () => {
    fc.assert(fc.property(fc.array(eventArb, { minLength: 1, maxLength: 12 }), (events) => {
      reset();
      let provider = open();
      let model: Model = { shown: null, latest: null, resyncing: false };
      for (const event of events) {
        if (event.type === 'push') push(provider, event.push);
        if (event.type === 'synced') synced(provider);
        if (event.type === 'refuse') {
          refuse(provider);
          provider = open();
        }
        model = step(model, event);
        const state = readDocSize(NAME);
        expect(state.phase).toBe(phaseOf(model));
        const known = model.shown !== null && model.shown.limit > 0;
        expect(state.overCeiling).toBe(known && model.shown!.bytes >= model.shown!.ceiling);
        if (known) {
          expect(state.bytes).toBe(model.shown!.bytes);
          expect(state.ceiling).toBe(model.shown!.ceiling);
          expect(state.overCeiling).toBe(state.bytes! >= state.ceiling!);
        }
      }
    }), { numRuns: 60 });
  });
});
