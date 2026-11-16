// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One request to open, or make and open, a Motion Space (#1490 design §8.5, §13.5, the table whose one writer is
 * `transitionSpaceOpenRequest`). The Timeline's "make in Motion" entry and "Open in Motion" ask for the newest Motion
 * Space; a canvas video's "open source animation" names its Space. Every cell of the table is one case.
 */

import { describe, expect, it } from 'vitest';

import {
  transitionSpaceOpenRequest, type SpaceOpenRequest, type SpaceOpenRequestEvent, type SpaceOpenRequestState,
} from '@web/stores/space-open-request';

const S = 's0000000-0000-4000-8000-000000000001';
const N = 'n0000000-0000-4000-8000-000000000002';
const E = 'e0000000-0000-4000-8000-000000000003';

const newest: SpaceOpenRequest = { type: 'web_animation', select: E };
const named: SpaceOpenRequest = { type: 'web_animation', spaceId: S, select: E };
const other: SpaceOpenRequest = { type: 'web_animation' };

const NONE: SpaceOpenRequestState = { status: 'none' };
const REQUESTING: SpaceOpenRequestState = { status: 'requesting', request: newest };
const CREATING: SpaceOpenRequestState = { status: 'creating', request: newest, next: null };
const OPENED: SpaceOpenRequestState = { status: 'opened', request: newest, spaceId: S };

describe('transitionSpaceOpenRequest — no request', () => {
  it('takes a request', () => {
    expect(transitionSpaceOpenRequest(NONE, { type: 'request', request: newest })).toEqual({ state: REQUESTING, effects: [{ type: 'resolve', request: newest }] });
  });

  it.each([
    { type: 'target_exists', spaceId: S }, { type: 'target_missing' }, { type: 'created', spaceId: N }, { type: 'create_failed' },
    { type: 'target_gone' }, { type: 'handled' }, { type: 'leave' },
  ] as SpaceOpenRequestEvent[])('ignores %o', (event) => {
    expect(transitionSpaceOpenRequest(NONE, event)).toEqual({ state: NONE, effects: [] });
  });
});

describe('transitionSpaceOpenRequest — requesting', () => {
  it('replaces the request with a newer one', () => {
    expect(transitionSpaceOpenRequest(REQUESTING, { type: 'request', request: other })).toEqual({ state: { status: 'requesting', request: other }, effects: [{ type: 'resolve', request: other }] });
  });

  it('opens the Space that exists', () => {
    expect(transitionSpaceOpenRequest(REQUESTING, { type: 'target_exists', spaceId: S })).toEqual({ state: OPENED, effects: [{ type: 'open_tab', spaceId: S }] });
  });

  it('makes a Motion Space named Motion when the Project has none', () => {
    expect(transitionSpaceOpenRequest(REQUESTING, { type: 'target_missing' })).toEqual({ state: CREATING, effects: [{ type: 'create', spaceType: 'web_animation', name: 'Motion' }] });
  });

  it('drops a request whose named Space was deleted or is another type, and says so', () => {
    expect(transitionSpaceOpenRequest({ status: 'requesting', request: named }, { type: 'target_gone' })).toEqual({ state: NONE, effects: [{ type: 'toast_source_space_gone' }] });
  });

  it.each([{ type: 'created', spaceId: N }, { type: 'create_failed' }, { type: 'handled' }, { type: 'leave' }] as SpaceOpenRequestEvent[])('ignores %o', (event) => {
    expect(transitionSpaceOpenRequest(REQUESTING, event)).toEqual({ state: REQUESTING, effects: [] });
  });
});

describe('transitionSpaceOpenRequest — creating', () => {
  it('opens the Space once it is made', () => {
    expect(transitionSpaceOpenRequest(CREATING, { type: 'created', spaceId: N })).toEqual({
      state: { status: 'opened', request: newest, spaceId: N }, effects: [{ type: 'open_tab', spaceId: N }],
    });
  });

  it('holds a new request until the Space is made, then takes it', () => {
    const queued = transitionSpaceOpenRequest(CREATING, { type: 'request', request: other });
    expect(queued).toEqual({ state: { status: 'creating', request: newest, next: other }, effects: [] });
    expect(transitionSpaceOpenRequest(queued.state, { type: 'created', spaceId: N })).toEqual({
      state: { status: 'requesting', request: other }, effects: [{ type: 'open_tab', spaceId: N }, { type: 'resolve', request: other }],
    });
  });

  it('drops the request when making the Space fails; the existing failure message is shown', () => {
    expect(transitionSpaceOpenRequest(CREATING, { type: 'create_failed' })).toEqual({ state: NONE, effects: [] });
  });

  it.each([{ type: 'target_exists', spaceId: S }, { type: 'target_missing' }, { type: 'target_gone' }, { type: 'handled' }, { type: 'leave' }] as SpaceOpenRequestEvent[])('ignores %o', (event) => {
    expect(transitionSpaceOpenRequest(CREATING, event)).toEqual({ state: CREATING, effects: [] });
  });
});

describe('transitionSpaceOpenRequest — opened', () => {
  it('replaces the request with a newer one', () => {
    expect(transitionSpaceOpenRequest(OPENED, { type: 'request', request: other }).state).toEqual({ status: 'requesting', request: other });
  });

  it('ends once the Space has taken the selection', () => {
    expect(transitionSpaceOpenRequest(OPENED, { type: 'handled' })).toEqual({ state: NONE, effects: [] });
  });

  it('ends when the user leaves that Space', () => {
    expect(transitionSpaceOpenRequest(OPENED, { type: 'leave' })).toEqual({ state: NONE, effects: [] });
  });

  it.each([{ type: 'target_exists', spaceId: S }, { type: 'target_missing' }, { type: 'created', spaceId: N }, { type: 'create_failed' }, { type: 'target_gone' }] as SpaceOpenRequestEvent[])('ignores %o', (event) => {
    expect(transitionSpaceOpenRequest(OPENED, event)).toEqual({ state: OPENED, effects: [] });
  });
});

describe('transitionSpaceOpenRequest — the Project page closes', () => {
  it.each([NONE, REQUESTING, CREATING, { ...CREATING, next: other }, OPENED] as SpaceOpenRequestState[])('ends the request from %o, so a later one is taken', (state) => {
    expect(transitionSpaceOpenRequest(state, { type: 'reset' })).toEqual({ state: NONE, effects: [] });
  });
});
