// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The voice list's state machine (#1960 §7.1).
 *
 * Five states and one reducer: the list is written here and nowhere else, so
 * every path that changes it goes through the same transition table.
 *
 * The search term lives in this state rather than beside it. The search box is
 * inside a Radix Popover and unmounts when the picker collapses, while this
 * state lives in the container — keeping the term in the box would let the two
 * disagree about which page is on screen.
 *
 * A request's answer is accepted only when it carries the current request id.
 * Switching models, typing, and collapsing the picker each void what is in
 * flight, so a page that was asked for under an earlier question can never
 * land as if it answered this one.
 *
 * Paging is a flag, not a sixth state: the user is looking at the list while
 * the next page loads, so `status` stays `ready` and the list keeps rendering.
 * A page that fails takes nothing down with it.
 */

import type { Voice, VoicePage } from '@breatic/shared';

/** Where the list is. */
export type VoiceListStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

/** Everything the picker renders from. */
export interface VoiceListState {
  status: VoiceListStatus;
  voices: Voice[];
  /** What the user typed. Searched upstream, not in the rendered list. */
  query: string;
  /** The token for the next page, absent when there is none. */
  cursor?: string;
  hasMore: boolean;
  /** A page is on its way. The list stays on screen while it is. */
  loadingMore: boolean;
  /** Only an answer carrying this id is accepted. */
  requestId: number;
}

/** What can happen to the list. */
export type VoiceListEvent =
  | { type: 'opened' }
  | { type: 'collapsed' }
  | { type: 'panelClosed' }
  | { type: 'queryChanged'; query: string }
  | { type: 'modelChanged' }
  | { type: 'arrived'; requestId: number; page: VoicePage }
  | { type: 'failed'; requestId: number }
  | { type: 'moreRequested' }
  | { type: 'moreArrived'; requestId: number; page: VoicePage }
  | { type: 'moreFailed'; requestId: number };

/** Nothing asked for yet. */
export const initialVoiceListState: VoiceListState = {
  status: 'idle',
  voices: [],
  query: '',
  hasMore: false,
  loadingMore: false,
  requestId: 0,
};

/**
 * Starts a fresh request: empties what was on screen and takes a new id, which
 * is what voids whatever was in flight.
 * @param state - The state to start from.
 * @param query - The search term the new request carries.
 * @returns A loading state with nothing shown yet.
 */
function startLoading(state: VoiceListState, query: string): VoiceListState {
  return {
    status: 'loading',
    voices: [],
    query,
    cursor: undefined,
    hasMore: false,
    loadingMore: false,
    requestId: state.requestId + 1,
  };
}

/**
 * Returns to the state before the picker was ever opened, voiding anything in
 * flight so a late answer cannot revive a closed list.
 * @param state - The state to reset from.
 * @returns An idle state with a fresh request id.
 */
function reset(state: VoiceListState): VoiceListState {
  return { ...initialVoiceListState, requestId: state.requestId + 1 };
}

/**
 * Applies one event to the list.
 * @param state - Where the list is now.
 * @param event - What happened.
 * @returns Where the list goes. The same object when nothing changes.
 */
export function voiceListReducer(
  state: VoiceListState,
  event: VoiceListEvent,
): VoiceListState {
  switch (event.type) {
    // Only the two states with nothing on their way and nothing to show send
    // a request. Opening on top of `loading` would void the request already in
    // flight and send another; opening on top of `ready` or `empty` would
    // discard an answer the picker is already showing.
    case 'opened':
      return state.status === 'idle' || state.status === 'failed'
        ? startLoading(state, state.query)
        : state;

    // Collapsing the picker and closing the panel leave the same nothing
    // behind. Reaching idle is what matters: cancelling the request without
    // changing state would read as "already loading" on the next open, and no
    // second request would ever be sent.
    case 'collapsed':
    case 'panelClosed':
      return reset(state);

    case 'queryChanged':
      return startLoading(state, event.query);

    // A different model reads a different value domain, so nothing carries
    // over — not the voices, not the cursor, and not the search term.
    case 'modelChanged':
      return startLoading(state, '');

    case 'arrived':
      if (event.requestId !== state.requestId) return state;
      return {
        ...state,
        status: event.page.voices.length > 0 ? 'ready' : 'empty',
        voices: event.page.voices,
        cursor: event.page.nextCursor,
        hasMore: event.page.hasMore,
        loadingMore: false,
      };

    case 'failed':
      if (event.requestId !== state.requestId) return state;
      return { ...state, status: 'failed', loadingMore: false };

    case 'moreRequested':
      if (state.loadingMore || !state.hasMore) return state;
      return { ...state, loadingMore: true };

    // Takes only what this page adds. Neither vendor promises a stable order
    // across requests — Fish pages by number over a list sorted by task count,
    // which moves while the user reads — so a voice can cross the page
    // boundary and come back. Appending blind would then render its id twice.
    case 'moreArrived': {
      if (event.requestId !== state.requestId) return state;
      const loaded = new Set(state.voices.map((voice) => voice.id));
      const added = event.page.voices.filter((voice) => !loaded.has(voice.id));
      return {
        ...state,
        voices: [...state.voices, ...added],
        cursor: event.page.nextCursor,
        hasMore: event.page.hasMore,
        loadingMore: false,
      };
    }

    // Only the flag falls back. The voices already loaded stay on screen: the
    // user can still pick one, and can ask for the next page again.
    case 'moreFailed':
      if (event.requestId !== state.requestId) return state;
      return { ...state, loadingMore: false };
  }
}
