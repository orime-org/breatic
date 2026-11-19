// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adding an annotation at the playhead (#1490 design §13.7, the table whose one writer is
 * `transitionAnnotationDraft`). Every cell of the table is one case; the effects pause playback, ask before throwing
 * text away, write the thread, and toast.
 */

import { describe, expect, it } from 'vitest';

import {
  transitionAnnotationDraft, type AnnotationDraftEvent, type AnnotationDraftState,
} from '@web/spaces/web-animation/annotation-draft';

const EXEC = 'e0000000-0000-4000-8000-000000000001';
const IDLE: AnnotationDraftState = { status: 'idle' };
const PICKING: AnnotationDraftState = { status: 'picking', executionId: EXEC, timeSeconds: 2.5 };
const writing = (text: string, overrides: Partial<Extract<AnnotationDraftState, { status: 'writing' }>> = {}): AnnotationDraftState => ({
  status: 'writing', executionId: EXEC, timeSeconds: 2.5, point: { x: 0.25, y: 0.5 }, text, disconnected: false, ...overrides,
});
const SENDING: AnnotationDraftState = { status: 'sending', executionId: EXEC, timeSeconds: 2.5, point: { x: 0.25, y: 0.5 }, text: 'Too fast' };

const add: AnnotationDraftEvent = { type: 'add', executionId: EXEC, timeSeconds: 2.5 };
const click: AnnotationDraftEvent = { type: 'click_frame', point: { x: 0.25, y: 0.5 } };

/**
 * One step.
 * @param state - From.
 * @param event - The event.
 * @returns The next state and its effects.
 */
const step = (state: AnnotationDraftState, event: AnnotationDraftEvent): ReturnType<typeof transitionAnnotationDraft> => transitionAnnotationDraft(state, event);

describe('transitionAnnotationDraft — idle', () => {
  it('pauses playback and waits for a point on the frame when Add annotation is pressed', () => {
    expect(step(IDLE, add)).toEqual({ state: PICKING, effects: [{ type: 'pause' }] });
  });

  it.each([click, { type: 'type', text: 'x' }, { type: 'send' }, { type: 'written' }, { type: 'write_failed', reason: 'full' }, { type: 'cancel', confirmed: false }, { type: 'switch_result', confirmed: false }, { type: 'disconnect' }] as AnnotationDraftEvent[])(
    'stays idle on %o',
    (event) => {
      expect(step(IDLE, event)).toEqual({ state: IDLE, effects: [] });
    },
  );
});

describe('transitionAnnotationDraft — picking a point', () => {
  it('stays put on a second Add annotation', () => {
    expect(step(PICKING, add)).toEqual({ state: PICKING, effects: [] });
  });

  it('takes the clicked point as a fraction of the frame and starts writing', () => {
    expect(step(PICKING, click).state).toEqual(writing(''));
  });

  it('starts writing with no point when the user types first', () => {
    expect(step(PICKING, { type: 'type', text: 'T' }).state).toEqual(writing('T', { point: null }));
  });

  it('sends nothing while there is no text', () => {
    expect(step(PICKING, { type: 'send' })).toEqual({ state: PICKING, effects: [] });
  });

  it('goes back to idle on cancel and a switch of result', () => {
    expect(step(PICKING, { type: 'cancel', confirmed: false }).state).toEqual(IDLE);
    expect(step(PICKING, { type: 'switch_result', confirmed: false }).state).toEqual(IDLE);
  });

  it('goes back to idle and says the connection dropped', () => {
    expect(step(PICKING, { type: 'disconnect' })).toEqual({ state: IDLE, effects: [{ type: 'toast_disconnected' }] });
  });
});

describe('transitionAnnotationDraft — writing', () => {
  it('moves the point on another click and keeps the text', () => {
    expect(step(writing('A'), { type: 'click_frame', point: { x: 0.9, y: 0.1 } }).state).toEqual(writing('A', { point: { x: 0.9, y: 0.1 } }));
  });

  it('updates the text', () => {
    expect(step(writing('A'), { type: 'type', text: 'AB' }).state).toEqual(writing('AB'));
  });

  it('sends non-empty text once, writing the thread with its anchor', () => {
    expect(step(writing('Too fast'), { type: 'send' })).toEqual({
      state: SENDING,
      effects: [{ type: 'write', anchor: { executionId: EXEC, timeSeconds: 2.5, point: { x: 0.25, y: 0.5 } }, text: 'Too fast' }],
    });
  });

  it('sends nothing while the text is only spaces', () => {
    expect(step(writing('   '), { type: 'send' })).toEqual({ state: writing('   '), effects: [] });
  });

  it('closes an empty draft on cancel and asks before throwing text away', () => {
    expect(step(writing(''), { type: 'cancel', confirmed: false }).state).toEqual(IDLE);
    expect(step(writing('A'), { type: 'cancel', confirmed: false })).toEqual({ state: writing('A'), effects: [{ type: 'confirm_discard' }] });
    expect(step(writing('A'), { type: 'cancel', confirmed: true }).state).toEqual(IDLE);
  });

  it('asks the same before switching result with text written', () => {
    expect(step(writing('A'), { type: 'switch_result', confirmed: false })).toEqual({ state: writing('A'), effects: [{ type: 'confirm_discard' }] });
    expect(step(writing('A'), { type: 'switch_result', confirmed: true }).state).toEqual(IDLE);
  });

  it('keeps the draft but holds sending while the document is disconnected, and lets it go once back', () => {
    const offline = step(writing('A'), { type: 'disconnect' }).state;
    expect(offline).toEqual(writing('A', { disconnected: true }));
    expect(step(offline, { type: 'send' })).toEqual({ state: offline, effects: [] });
    expect(step(offline, { type: 'reconnect' }).state).toEqual(writing('A'));
  });

  it('answers a connection state it already holds with the same draft, so a repeated notice renders nothing', () => {
    const online = writing('A');
    expect(step(online, { type: 'reconnect' })).toEqual({ state: online, effects: [] });
    expect(step(online, { type: 'reconnect' }).state).toBe(online);
    const offline = writing('A', { disconnected: true });
    expect(step(offline, { type: 'disconnect' }).state).toBe(offline);
  });
});

describe('transitionAnnotationDraft — sending', () => {
  it.each([add, click, { type: 'type', text: 'x' }, { type: 'send' }, { type: 'cancel', confirmed: true }, { type: 'switch_result', confirmed: true }, { type: 'disconnect' }] as AnnotationDraftEvent[])(
    'ignores %o',
    (event) => {
      expect(step(SENDING, event)).toEqual({ state: SENDING, effects: [] });
    },
  );

  it('goes back to idle once written', () => {
    expect(step(SENDING, { type: 'written' })).toEqual({ state: IDLE, effects: [] });
  });

  it('goes back to writing with the text and toasts the reason when the write fails', () => {
    expect(step(SENDING, { type: 'write_failed', reason: 'space_full' })).toEqual({
      state: writing('Too fast'), effects: [{ type: 'toast_failed', reason: 'space_full' }],
    });
  });
});

