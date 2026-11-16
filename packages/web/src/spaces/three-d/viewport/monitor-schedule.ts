// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Two independent facts about one monitor card (inner#1694 design 6.3); a failed renderer is shown by the card itself. */
export interface MonitorCard {
  visible: boolean;
  freshness: 'unpainted' | 'stale' | 'fresh';
}
export type MonitorCards = Readonly<Record<string, MonitorCard>>;

export type MonitorEvent =
  | { type: 'mount'; id: string }
  | { type: 'removed'; id: string }
  | { type: 'visible'; id: string; visible: boolean }
  /** A display value changed: for the listed cards, or for every card when none are listed. */
  | { type: 'changed'; ids?: readonly string[] }
  | { type: 'painted'; ids: readonly string[] };

/**
 * Change the cards a set of ids names.
 * @param cards - The cards.
 * @param ids - Which ones; unknown ids are skipped.
 * @param change - The new values for each.
 * @returns The updated cards.
 */
function update(cards: MonitorCards, ids: readonly string[], change: (card: MonitorCard) => MonitorCard): MonitorCards {
  const next = { ...cards };
  for (const id of ids) {
    const card = next[id];
    if (card) next[id] = change(card);
  }
  return next;
}

/**
 * Advance the monitor cards by one event.
 * @param cards - The cards.
 * @param event - What happened.
 * @returns The next cards.
 */
export function monitorReducer(cards: MonitorCards, event: MonitorEvent): MonitorCards {
  const all = Object.keys(cards);
  switch (event.type) {
    case 'mount':
      return { ...cards, [event.id]: { visible: false, freshness: 'unpainted' } };
    case 'removed': {
      const { [event.id]: _removed, ...rest } = cards;
      return rest;
    }
    case 'visible':
      return update(cards, [event.id], (card) => ({ ...card, visible: event.visible }));
    case 'changed':
      return update(cards, event.ids ?? all, (card) => (card.freshness === 'fresh' ? { ...card, freshness: 'stale' } : card));
    case 'painted':
      return update(cards, event.ids, (card) => ({ ...card, freshness: 'fresh' }));
  }
}

/**
 * The cards to draw at the next refresh: visible and out of date.
 * @param cards - The cards.
 * @returns Their ids in insertion order.
 */
export function monitorsDue(cards: MonitorCards): string[] {
  return Object.entries(cards).filter(([, card]) => card.visible && card.freshness !== 'fresh').map(([id]) => id);
}
