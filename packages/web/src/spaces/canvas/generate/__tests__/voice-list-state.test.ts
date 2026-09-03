// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 §7.1 — the voice list's state machine, one cell at a time.
 *
 * Five states, and the transition table in the design says what each event
 * does in each of them. Two of its cells are worth naming here because they
 * are the ones that fail quietly:
 *
 * Collapsing the picker while a request is in flight has to reach `idle`, not
 * just abandon the request. Cancelling without changing state leaves the next
 * open reading "already loading", so it never sends a second request and the
 * picker spins forever.
 *
 * Paging is a separate flag rather than a sixth state. The user is looking at
 * the list while the next page loads, so the list must keep rendering — and a
 * failed page must not take the loaded ones down with it.
 */

import { describe, it, expect } from 'vitest';

import {
  voiceListReducer,
  initialVoiceListState,
  type VoiceListState,
} from '@web/spaces/canvas/generate/voice-list-state';
import type { Voice } from '@breatic/shared';

const VOICE_A: Voice = { id: 'a', name: 'Alpha' };
const VOICE_B: Voice = { id: 'b', name: 'Beta' };

/** Opens the picker and settles one page, the state most events start from. */
function readyState(): VoiceListState {
  const opened = voiceListReducer(initialVoiceListState, { type: 'opened' });
  return voiceListReducer(opened, {
    type: 'arrived',
    requestId: opened.requestId,
    page: { voices: [VOICE_A], hasMore: true, nextCursor: 'c2' },
  });
}

describe('opening and closing (#1960 §7.1)', () => {
  it('starts idle, having sent nothing', () => {
    expect(initialVoiceListState.status).toBe('idle');
    expect(initialVoiceListState.voices).toEqual([]);
  });

  it('goes to loading when the picker opens', () => {
    const s = voiceListReducer(initialVoiceListState, { type: 'opened' });
    expect(s.status).toBe('loading');
  });

  it('returns to idle when the picker is collapsed mid-request', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const s = voiceListReducer(loading, { type: 'collapsed' });
    expect(s.status).toBe('idle');
  });

  it('voids the in-flight request when collapsed, so a late page is ignored', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const collapsed = voiceListReducer(loading, { type: 'collapsed' });
    const late = voiceListReducer(collapsed, {
      type: 'arrived',
      requestId: loading.requestId,
      page: { voices: [VOICE_A], hasMore: false },
    });
    expect(late.status).toBe('idle');
    expect(late.voices).toEqual([]);
  });

  it('does not let a request from before a collapse answer the one after it', () => {
    // Resetting has to move the request id forward, not back to where it
    // started. Returning to the initial id makes the next open reuse the id
    // the abandoned request is still carrying, so its answer lands as if it
    // had been asked for — the picker fills with the previous search.
    const first = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const collapsed = voiceListReducer(first, { type: 'collapsed' });
    const second = voiceListReducer(collapsed, { type: 'opened' });
    const s = voiceListReducer(second, {
      type: 'arrived',
      requestId: first.requestId,
      page: { voices: [VOICE_A], hasMore: false },
    });
    expect(s.status).toBe('loading');
    expect(s.voices).toEqual([]);
  });

  it('clears the list and the search term on collapse', () => {
    const searched = voiceListReducer(readyState(), {
      type: 'queryChanged',
      query: 'deep',
    });
    const s = voiceListReducer(searched, { type: 'collapsed' });
    expect(s.voices).toEqual([]);
    expect(s.query).toBe('');
  });

  it('reopens into loading after a collapse, rather than staying put', () => {
    const collapsed = voiceListReducer(readyState(), { type: 'collapsed' });
    expect(voiceListReducer(collapsed, { type: 'opened' }).status).toBe('loading');
  });

  // The table's "open" column is idempotent everywhere except idle and failed:
  // the picker is already showing what that event would ask for. A second open
  // event while a request is in flight would void the one already on its way
  // and send another, and the answer to the first would then be discarded.
  it('does nothing when opened again while a request is in flight', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    expect(voiceListReducer(loading, { type: 'opened' })).toBe(loading);
  });

  it('does nothing when opened again with a list on screen', () => {
    const ready = readyState();
    expect(voiceListReducer(ready, { type: 'opened' })).toBe(ready);
  });

  it('does nothing when opened again on a search that matched nothing', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const empty = voiceListReducer(loading, {
      type: 'arrived',
      requestId: loading.requestId,
      page: { voices: [], hasMore: false },
    });
    expect(voiceListReducer(empty, { type: 'opened' })).toBe(empty);
  });
});

describe('what comes back (#1960 §7.1)', () => {
  it('goes to ready with the page it was handed', () => {
    const s = readyState();
    expect(s.status).toBe('ready');
    expect(s.voices).toEqual([VOICE_A]);
    expect(s.hasMore).toBe(true);
    expect(s.cursor).toBe('c2');
  });

  it('goes to empty when the search matched nothing', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const s = voiceListReducer(loading, {
      type: 'arrived',
      requestId: loading.requestId,
      page: { voices: [], hasMore: false },
    });
    expect(s.status).toBe('empty');
  });

  it('goes to failed when the request did', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const s = voiceListReducer(loading, {
      type: 'failed',
      requestId: loading.requestId,
    });
    expect(s.status).toBe('failed');
  });

  it('retries from failed by opening again, which is what the button does', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const failed = voiceListReducer(loading, {
      type: 'failed',
      requestId: loading.requestId,
    });
    expect(voiceListReducer(failed, { type: 'opened' }).status).toBe('loading');
  });

  it('ignores a failure that belongs to a request already superseded', () => {
    const ready = readyState();
    const searching = voiceListReducer(ready, {
      type: 'queryChanged',
      query: 'x',
    });
    const s = voiceListReducer(searching, {
      type: 'failed',
      requestId: ready.requestId,
    });
    expect(s.status).toBe('ready');
    expect(s.fetching).toBe(true);
  });
});

// `status` says what is on screen; this says whether a list is on its way.
// They came apart when a search learned to hold the old list: the picture
// stays `ready` while the request travels, and something still has to send it.
describe('whether a list is in flight (#1960 §7.1)', () => {
  it('has nothing in flight before the picker is opened', () => {
    expect(initialVoiceListState.fetching).toBe(false);
  });

  it('marks one in flight when the picker opens', () => {
    expect(
      voiceListReducer(initialVoiceListState, { type: 'opened' }).fetching,
    ).toBe(true);
  });

  it('marks one in flight for a search that holds the old list', () => {
    const s = voiceListReducer(readyState(), { type: 'queryChanged', query: 'x' });
    expect(s.status).toBe('ready');
    expect(s.fetching).toBe(true);
  });

  it('marks one in flight when the model changes', () => {
    expect(voiceListReducer(readyState(), { type: 'modelChanged' }).fetching).toBe(
      true,
    );
  });

  it('clears it when the page arrives', () => {
    expect(readyState().fetching).toBe(false);
  });

  it('clears it when the request fails', () => {
    const opened = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const s = voiceListReducer(opened, {
      type: 'failed',
      requestId: opened.requestId,
    });
    expect(s.fetching).toBe(false);
  });

  it('clears it when the picker collapses', () => {
    const opened = voiceListReducer(initialVoiceListState, { type: 'opened' });
    expect(voiceListReducer(opened, { type: 'collapsed' }).fetching).toBe(false);
  });

  it('leaves it alone while the next page loads', () => {
    const s = voiceListReducer(readyState(), { type: 'moreRequested' });
    expect(s.fetching).toBe(false);
    expect(s.loadingMore).toBe(true);
  });

  it('opening on a list already shown sends nothing', () => {
    const ready = readyState();
    expect(voiceListReducer(ready, { type: 'opened' }).fetching).toBe(false);
  });
});

describe('searching and switching models (#1960 §7.1)', () => {
  it('asks for nothing when the model changes before the picker was opened', () => {
    // Opening the picker is what sends the first request. Going to loading
    // here would fetch a vendor list for a picker nobody has looked at.
    const s = voiceListReducer(initialVoiceListState, { type: 'modelChanged' });
    expect(s.status).toBe('idle');
    expect(s.requestId).not.toBe(initialVoiceListState.requestId);
  });

  // What is on screen when the term changes is the same model's voices: still
  // pickable, still worth reading. Sweeping them away for a loading line
  // would do it on every keystroke, since each one restarts the request.
  it('leaves the loaded voices on screen while a new search travels', () => {
    const s = voiceListReducer(readyState(), {
      type: 'queryChanged',
      query: 'deep',
    });
    expect(s.status).toBe('ready');
    expect(s.voices).toEqual([VOICE_A]);
    expect(s.query).toBe('deep');
  });

  it('takes a new request id, so the previous term cannot answer', () => {
    const ready = readyState();
    const s = voiceListReducer(ready, { type: 'queryChanged', query: 'deep' });
    expect(s.requestId).not.toBe(ready.requestId);
  });

  it('drops the page that the previous search term asked for', () => {
    const ready = readyState();
    const searching = voiceListReducer(ready, {
      type: 'queryChanged',
      query: 'deep',
    });
    const stale = voiceListReducer(searching, {
      type: 'arrived',
      requestId: ready.requestId,
      page: { voices: [VOICE_B], hasMore: false },
    });
    expect(stale.voices).not.toContainEqual(VOICE_B);
  });

  it('holds the empty message while a new search travels', () => {
    const opened = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const empty = voiceListReducer(opened, {
      type: 'arrived',
      requestId: opened.requestId,
      page: { voices: [], hasMore: false },
    });
    const s = voiceListReducer(empty, { type: 'queryChanged', query: 'deep' });
    expect(s.status).toBe('empty');
  });

  // Nothing on screen worth holding: the first request has not answered yet.
  it('goes to loading for a term typed before anything has loaded', () => {
    const s = voiceListReducer(initialVoiceListState, {
      type: 'queryChanged',
      query: 'deep',
    });
    expect(s.status).toBe('loading');
    expect(s.voices).toEqual([]);
  });

  // Holding the error would read as a picker that stopped trying.
  it('goes to loading for a term typed after a failure', () => {
    const opened = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const failed = voiceListReducer(opened, {
      type: 'failed',
      requestId: opened.requestId,
    });
    const s = voiceListReducer(failed, { type: 'queryChanged', query: 'deep' });
    expect(s.status).toBe('loading');
  });

  it('starts over on a model switch, since the value domain changed', () => {
    const s = voiceListReducer(readyState(), { type: 'modelChanged' });
    expect(s.status).toBe('loading');
    expect(s.voices).toEqual([]);
    expect(s.cursor).toBeUndefined();
  });

  it('clears the cursor when a new search starts, so paging restarts', () => {
    const s = voiceListReducer(readyState(), { type: 'queryChanged', query: 'q' });
    expect(s.cursor).toBeUndefined();
  });
});

describe('paging (#1960 §7.1, a flag rather than a state)', () => {
  it('keeps showing the list while the next page loads', () => {
    const s = voiceListReducer(readyState(), { type: 'moreRequested' });
    expect(s.status).toBe('ready');
    expect(s.voices).toEqual([VOICE_A]);
    expect(s.loadingMore).toBe(true);
  });

  it('appends the next page to what is already there', () => {
    const ready = readyState();
    const loadingMore = voiceListReducer(ready, { type: 'moreRequested' });
    const s = voiceListReducer(loadingMore, {
      type: 'moreArrived',
      requestId: ready.requestId,
      page: { voices: [VOICE_B], hasMore: false },
    });
    expect(s.voices).toEqual([VOICE_A, VOICE_B]);
    expect(s.hasMore).toBe(false);
    expect(s.loadingMore).toBe(false);
  });

  it('takes only what the next page adds, never a repeat', () => {
    // Neither vendor promises a stable order across page requests: Fish pages
    // by number over a list sorted by task count, a figure that moves while
    // the user reads. A voice that shifts across the page boundary comes back
    // a second time, and appending it blind puts the same name on two rows
    // that both claim its id.
    const ready = readyState();
    const loadingMore = voiceListReducer(ready, { type: 'moreRequested' });
    const s = voiceListReducer(loadingMore, {
      type: 'moreArrived',
      requestId: ready.requestId,
      page: { voices: [VOICE_A, VOICE_B], hasMore: false },
    });
    expect(s.voices).toEqual([VOICE_A, VOICE_B]);
  });

  it('says a next page failed, so the list does not read as finished', () => {
    // Without a mark of its own, a failed page renders exactly like reaching
    // the end: the loading line goes away and nothing takes its place.
    const ready = readyState();
    const loadingMore = voiceListReducer(ready, { type: 'moreRequested' });
    const s = voiceListReducer(loadingMore, {
      type: 'moreFailed',
      requestId: ready.requestId,
    });
    expect(s.moreFailed).toBe(true);
  });

  it('clears that mark when the next attempt starts', () => {
    const ready = readyState();
    const failed = voiceListReducer(
      voiceListReducer(ready, { type: 'moreRequested' }),
      { type: 'moreFailed', requestId: ready.requestId },
    );
    expect(voiceListReducer(failed, { type: 'moreRequested' }).moreFailed).toBe(
      false,
    );
  });

  it('keeps the loaded voices when the next page fails', () => {
    const ready = readyState();
    const loadingMore = voiceListReducer(ready, { type: 'moreRequested' });
    const s = voiceListReducer(loadingMore, {
      type: 'moreFailed',
      requestId: ready.requestId,
    });
    expect(s.status).toBe('ready');
    expect(s.voices).toEqual([VOICE_A]);
    expect(s.loadingMore).toBe(false);
  });

  it('drops a page that belongs to the model the user just left', () => {
    const ready = readyState();
    const loadingMore = voiceListReducer(ready, { type: 'moreRequested' });
    const switched = voiceListReducer(loadingMore, { type: 'modelChanged' });
    const s = voiceListReducer(switched, {
      type: 'moreArrived',
      requestId: ready.requestId,
      page: { voices: [VOICE_B], hasMore: false },
    });
    expect(s.voices).toEqual([]);
    expect(s.status).toBe('loading');
  });

  it('will not start a second page while one is already loading', () => {
    const ready = readyState();
    const once = voiceListReducer(ready, { type: 'moreRequested' });
    const twice = voiceListReducer(once, { type: 'moreRequested' });
    expect(twice).toBe(once);
  });

  it('will not page when the last page said there is no more', () => {
    const loading = voiceListReducer(initialVoiceListState, { type: 'opened' });
    const last = voiceListReducer(loading, {
      type: 'arrived',
      requestId: loading.requestId,
      page: { voices: [VOICE_A], hasMore: false },
    });
    expect(voiceListReducer(last, { type: 'moreRequested' })).toBe(last);
  });
});
