// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

interface Card { visible: boolean; freshness: 'unpainted' | 'stale' | 'fresh' }
type Cards = Readonly<Record<string, Card>>;
type Reduce = (cards: Cards, event: Record<string, unknown>) => Cards;
type Due = (cards: Cards) => readonly string[];

const modules = import.meta.glob<Record<string, unknown>>('../monitor-schedule.ts', { eager: true });
const schedule = modules['../monitor-schedule.ts'] ?? {};
const reduce = schedule.monitorReducer as Reduce;
const due = schedule.monitorsDue as Due;

/**
 * Apply events in order through the real reducer.
 * @param events - The events.
 * @param from - The starting cards.
 * @returns The cards after the last one.
 */
function run(events: readonly Record<string, unknown>[], from: Cards = {}): Cards {
  return events.reduce<Cards>((cards, event) => reduce(cards, event), from);
}

const mounted = (): Cards => run([{ type: 'mount', id: 'a' }, { type: 'mount', id: 'b' }, { type: 'visible', id: 'a', visible: true }, { type: 'visible', id: 'b', visible: true }]);
const painted = (): Cards => run([{ type: 'painted', ids: ['a', 'b'] }], mounted());

describe('monitor cards (inner#1694 design 6.3)', () => {
  it('exports the reducer and the due list', () => {
    expect([typeof reduce, typeof due]).toEqual(['function', 'function']);
  });

  it('mounts a card unpainted and draws it only once it is visible', () => {
    const one = run([{ type: 'mount', id: 'a' }]);
    expect(one.a).toEqual({ visible: false, freshness: 'unpainted' });
    expect(due(one)).toEqual([]);
    expect(due(run([{ type: 'visible', id: 'a', visible: true }], one))).toEqual(['a']);
  });

  it('marks drawn cards fresh and draws nothing more until a display value changes', () => {
    expect(painted().a?.freshness).toBe('fresh');
    expect(due(painted())).toEqual([]);
    expect(due(run([{ type: 'changed' }], painted()))).toEqual(['a', 'b']);
  });

  it('a change to one camera or one card size stales only that card', () => {
    expect(due(run([{ type: 'changed', ids: ['b'] }], painted()))).toEqual(['b']);
  });

  it('scrolling or switching tabs changes only visibility', () => {
    const hidden = run([{ type: 'visible', id: 'a', visible: false }], painted());
    expect(hidden.a).toEqual({ visible: false, freshness: 'fresh' });
    const staleHidden = run([{ type: 'changed' }], hidden);
    expect(due(staleHidden)).toEqual(['b']);
    expect(due(run([{ type: 'visible', id: 'a', visible: true }], staleHidden))).toEqual(['a', 'b']);
  });


  it('removes the card of a deleted camera and ignores events for unknown cards', () => {
    const removed = run([{ type: 'removed', id: 'a' }], painted());
    expect(Object.keys(removed)).toEqual(['b']);
    expect(run([{ type: 'visible', id: 'zz', visible: true }, { type: 'painted', ids: ['zz'] }, { type: 'changed', ids: ['zz'] }], removed)).toEqual(removed);
  });

  it('marks only the cards it drew as fresh', () => {
    const changedDuring = run([{ type: 'changed', ids: ['a', 'b'] }, { type: 'painted', ids: ['b'] }], painted());
    expect(due(changedDuring)).toEqual(['a']);
  });

  it('starts a remounted card unpainted again', () => {
    expect(run([{ type: 'mount', id: 'a' }], painted()).a).toEqual({ visible: false, freshness: 'unpainted' });
  });

  it('draws exactly the visible, out-of-date cards for any event sequence', () => {
    const id = fc.constantFrom('a', 'b', 'c');
    const event = fc.oneof(
      id.map((value) => ({ type: 'mount', id: value })),
      id.map((value) => ({ type: 'removed', id: value })),
      fc.record({ type: fc.constant('visible'), id, visible: fc.boolean() }),
      fc.record({ type: fc.constant('changed'), ids: fc.option(fc.array(id, { maxLength: 3 }), { nil: undefined }) }),
      fc.record({ type: fc.constant('painted'), ids: fc.array(id, { maxLength: 3 }) }),
    );
    fc.assert(fc.property(fc.array(event, { maxLength: 40 }), (events) => {
      const cards = run(events);
      const expected = Object.entries(cards).filter(([, card]) => card.visible && card.freshness !== 'fresh').map(([key]) => key).sort();
      expect([...due(cards)].sort()).toEqual(expected);
    }), { numRuns: 200 });
  });
});
