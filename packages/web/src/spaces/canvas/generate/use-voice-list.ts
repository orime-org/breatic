// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Connects the voice list's state machine to the endpoint that fills it.
 *
 * The machine (`voice-list-state.ts`) says WHEN a request is wanted and which
 * answers are still welcome; this says how one is made. Splitting them that way
 * is what lets every transition be tested without a network, and what keeps the
 * request-id accounting in one place: an answer is dispatched with the id its
 * request was born under, and the reducer alone decides whether that id is
 * still current.
 */

import * as React from 'react';

import { voicesApi } from '@web/data/api/voices';
import {
  initialVoiceListState,
  voiceListReducer,
  type VoiceListState,
} from '@web/spaces/canvas/generate/voice-list-state';

/**
 * How long typing has to settle before the search is sent.
 *
 * Each keystroke empties the list and reloads it, so asking per character
 * flashes the list once per letter and spends one upstream call on each
 * abandoned prefix. A quarter of a second is the interval a typist does not
 * notice and a five-letter search collapses into one request.
 *
 * A constant rather than config: it describes how this control feels, not
 * something an operator would tune per deployment.
 */
const SEARCH_SETTLE_MS = 250;

/** What the picker needs to render and drive the list. */
export interface VoiceListHandle {
  state: VoiceListState;
  /** The picker opened or collapsed. */
  onOpenChange: (open: boolean) => void;
  /** What was typed into the search box. */
  onQueryChange: (query: string) => void;
  /** The list reached its end. */
  onLoadMore: () => void;
}

/**
 * Holds one model's voice list: its state, and the requests that fill it.
 *
 * A request is sent for exactly two states — `loading` (a fresh list) and
 * `loadingMore` (the next page) — and each is keyed by the request id the
 * machine minted for it, so an effect that re-runs for any other reason sends
 * nothing. A search waits {@link SEARCH_SETTLE_MS} for typing to settle; the
 * loading state shows from the first keystroke, because the wait is about which
 * request to send, not about whether to say something is happening.
 * @param model - The model whose voices these are; changing it voids the list.
 * @returns The list state and the picker's callbacks.
 */
export function useVoiceList(model: string | undefined): VoiceListHandle {
  const [state, dispatch] = React.useReducer(
    voiceListReducer,
    initialVoiceListState,
  );
  const modelChangedFrom = React.useRef(model);
  if (modelChangedFrom.current !== model) {
    modelChangedFrom.current = model;
    // During render rather than in an effect: the list on screen belongs to the
    // previous model, and a frame showing it under the new one would offer
    // voices this model cannot speak with.
    dispatch({ type: 'modelChanged' });
  }

  const query = state.query;
  const requestId = state.requestId;
  const loading = state.status === 'loading';
  React.useEffect(() => {
    if (!loading || !model) return;
    // Every fresh list waits out the settle window, including the one an open
    // starts: the timer is cleared on unmount and superseded by the next id,
    // so the only cost to a plain open is the wait itself.
    const timer = setTimeout(() => {
      voicesApi
        .list(model, { query })
        .then((page) => dispatch({ type: 'arrived', requestId, page }))
        .catch(() => dispatch({ type: 'failed', requestId }));
    }, SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [loading, model, query, requestId]);

  const loadingMore = state.loadingMore;
  const cursor = state.cursor;
  React.useEffect(() => {
    if (!loadingMore || !model) return;
    voicesApi
      .list(model, { query, cursor })
      .then((page) => dispatch({ type: 'moreArrived', requestId, page }))
      .catch(() => dispatch({ type: 'moreFailed', requestId }));
  }, [loadingMore, model, query, cursor, requestId]);

  const onOpenChange = React.useCallback((open: boolean) => {
    dispatch({ type: open ? 'opened' : 'collapsed' });
  }, []);
  const onQueryChange = React.useCallback((next: string) => {
    dispatch({ type: 'queryChanged', query: next });
  }, []);
  const onLoadMore = React.useCallback(() => {
    dispatch({ type: 'moreRequested' });
  }, []);

  // One object, kept while its parts are: the three callbacks never change
  // identity, so this only rebuilds when the state does. A fresh object every
  // render would spread through every callback that reads it and defeat the
  // memoized panel below them.
  return React.useMemo(
    () => ({ state, onOpenChange, onQueryChange, onLoadMore }),
    [state, onOpenChange, onQueryChange, onLoadMore],
  );
}
