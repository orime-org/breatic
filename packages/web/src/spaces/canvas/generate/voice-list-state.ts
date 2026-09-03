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
 * `status` says what the reader sees; `fetching` and `loadingMore` say what is
 * on its way. They are separate because both are true at once for most of the
 * time a request is out: the loaded voices stay on screen through a new search
 * and through a next page, so the picture is `ready` while a request travels.
 * Only a first list with nothing yet to show, and a retry after a failure,
 * put a placeholder up — everything else replaces one picture with the next.
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
  /**
   * A whole list is on its way.
   *
   * Separate from `status` because the two answer different questions:
   * `status` is what the reader sees, and a search holds the loaded voices on
   * screen while its answer travels — so `ready` and "a request is out" are
   * true at once, and only this says the second one. It is what decides
   * whether a request gets sent at all.
   */
  fetching: boolean;
  /** A page is on its way. The list stays on screen while it is. */
  loadingMore: boolean;
  /**
   * The last next-page request came back failed.
   *
   * Its own field because the list has no other way to show it: with only
   * `loadingMore` falling back, a failed page renders exactly like reaching
   * the end — the loading line goes away and nothing takes its place.
   */
  moreFailed: boolean;
  /** Only an answer carrying this id is accepted. */
  requestId: number;
}

/** What can happen to the list. */
export type VoiceListEvent =
  | { type: 'opened' }
  | { type: 'collapsed' }
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
  fetching: false,
  loadingMore: false,
  moreFailed: false,
  requestId: 0,
};

/**
 * Starts a fresh request over what is on screen: the list empties and the
 * placeholder takes its place until the answer lands.
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
    fetching: true,
    loadingMore: false,
    moreFailed: false,
    requestId: state.requestId + 1,
  };
}

/**
 * Starts a fresh request under what is on screen: the picture holds until the
 * answer replaces it.
 *
 * Which of the two a search takes turns on whether the reader is looking at
 * anything worth holding. `ready` and `empty` are answers to a question about
 * the same model, and a new term does not make them wrong to look at — while
 * sweeping them away would do it on every keystroke, since each one restarts
 * the request. `idle` and `loading` have nothing to hold. `failed` is the one
 * picture that must go: held through a retry it reads as a picker that stopped
 * trying.
 * @param state - The state to start from.
 * @param query - The search term the new request carries.
 * @returns The same picture under a new request, or a loading state when there
 *   is no picture to keep.
 */
function startSearch(state: VoiceListState, query: string): VoiceListState {
  if (state.status !== 'ready' && state.status !== 'empty') {
    return startLoading(state, query);
  }
  return {
    ...state,
    query,
    cursor: undefined,
    hasMore: false,
    fetching: true,
    loadingMore: false,
    moreFailed: false,
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

    // Reaching idle is what matters: cancelling the request without changing
    // state would read as "already loading" on the next open, and no second
    // request would ever be sent. Closing the whole panel needs no event of
    // its own — it unmounts the container this state lives in.
    case 'collapsed':
      return reset(state);

    case 'queryChanged':
      return startSearch(state, event.query);

    // A different model reads a different value domain, so nothing carries
    // over — not the voices, not the cursor, and not the search term. From
    // idle there is nothing to carry and nothing to show, and opening the
    // picker is what sends the first request: fetching here would ask a vendor
    // for a list nobody has looked at.
    case 'modelChanged':
      return state.status === 'idle'
        ? { ...state, requestId: state.requestId + 1 }
        : startLoading(state, '');

    case 'arrived':
      if (event.requestId !== state.requestId) return state;
      return {
        ...state,
        status: event.page.voices.length > 0 ? 'ready' : 'empty',
        voices: event.page.voices,
        cursor: event.page.nextCursor,
        hasMore: event.page.hasMore,
        fetching: false,
        loadingMore: false,
        moreFailed: false,
      };

    case 'failed':
      if (event.requestId !== state.requestId) return state;
      return { ...state, status: 'failed', fetching: false, loadingMore: false };

    case 'moreRequested':
      if (state.loadingMore || !state.hasMore) return state;
      return { ...state, loadingMore: true, moreFailed: false };

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
        moreFailed: false,
      };
    }

    // The voices already loaded stay on screen: the user can still pick one,
    // and can ask for the next page again.
    case 'moreFailed':
      if (event.requestId !== state.requestId) return state;
      return { ...state, loadingMore: false, moreFailed: true };
  }
}
