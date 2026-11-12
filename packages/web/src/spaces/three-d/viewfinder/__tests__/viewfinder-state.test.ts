// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import {
  INITIAL_VIEWFINDER,
  viewfinderReducer,
  type ViewfinderAction,
  type ViewfinderState,
} from '@web/spaces/three-d/viewfinder/viewfinder-state';

const FRAME = { x: 40, y: 60, width: 640, height: 360 };
const SMALL = { x: 100, y: 100, width: 320, height: 180 };
const SHOT = { file: new File(['png'], 'shot.png', { type: 'image/png' }), url: 'blob:shot', width: 2048, height: 1152 };

/**
 * Apply actions in order.
 * @param actions - The actions.
 * @param from - The starting state.
 * @returns The state after the last one.
 */
function run(actions: readonly ViewfinderAction[], from: ViewfinderState = INITIAL_VIEWFINDER): ViewfinderState {
  return actions.reduce(viewfinderReducer, from);
}

const framing = run([{ type: 'open', frame: FRAME }]);
const captured = run([{ type: 'captured', shot: SHOT }], framing);

describe('the viewfinder states (design 6.1)', () => {
  it('opens on the default frame from off, with the 16:9 ratio', () => {
    expect(INITIAL_VIEWFINDER.phase).toBe('off');
    expect(framing).toMatchObject({ phase: 'framing', frame: FRAME, ratio: '16:9', shot: null, sending: null });
  });

  it('resizes and refits only while the frame is on screen', () => {
    expect(viewfinderReducer(framing, { type: 'frame', frame: SMALL }).frame).toEqual(SMALL);
    expect(viewfinderReducer(captured, { type: 'frame', frame: SMALL })).toMatchObject({ phase: 'captured', frame: SMALL, shot: SHOT });
    expect(viewfinderReducer(INITIAL_VIEWFINDER, { type: 'frame', frame: SMALL })).toBe(INITIAL_VIEWFINDER);
  });

  it('changes the ratio while framing, taking the frame the caller computed for it', () => {
    expect(viewfinderReducer(framing, { type: 'ratio', ratio: '1:1', frame: SMALL })).toMatchObject({ ratio: '1:1', frame: SMALL });
    expect(viewfinderReducer(captured, { type: 'ratio', ratio: '1:1', frame: SMALL })).toBe(captured);
  });

  it('closes from framing on cancel, the button or Esc', () => {
    expect(viewfinderReducer(framing, { type: 'close' }).phase).toBe('off');
  });

  it('captures from framing only, under a new session id', () => {
    expect(captured).toMatchObject({ phase: 'captured', shot: SHOT });
    expect(captured.session).not.toBe(framing.session);
    expect(viewfinderReducer(INITIAL_VIEWFINDER, { type: 'captured', shot: SHOT })).toBe(INITIAL_VIEWFINDER);
  });

  it('re-frames from captured, dropping the shot and keeping the frame', () => {
    const moved = viewfinderReducer(captured, { type: 'frame', frame: SMALL });
    expect(viewfinderReducer(moved, { type: 'reframe' })).toMatchObject({ phase: 'framing', shot: null, frame: SMALL });
  });

  it('opens the canvas list from captured and closes it back to captured', () => {
    const picking = viewfinderReducer(captured, { type: 'pick' });
    expect(picking.phase).toBe('picking');
    expect(viewfinderReducer(picking, { type: 'unpick' }).phase).toBe('captured');
  });

  it('sends to the Agent and copies from captured, and to a canvas from the list', () => {
    expect(viewfinderReducer(captured, { type: 'send', target: 'agent' })).toMatchObject({ phase: 'sending', sending: 'agent' });
    expect(viewfinderReducer(captured, { type: 'send', target: 'copy' })).toMatchObject({ phase: 'sending', sending: 'copy' });
    const picking = viewfinderReducer(captured, { type: 'pick' });
    expect(viewfinderReducer(picking, { type: 'send', target: 'canvas' })).toMatchObject({ phase: 'sending', sending: 'canvas' });
  });

  it('refuses a second send and a re-frame while one is in flight', () => {
    const sending = viewfinderReducer(captured, { type: 'send', target: 'agent' });
    expect(viewfinderReducer(sending, { type: 'send', target: 'copy' })).toBe(sending);
    expect(viewfinderReducer(sending, { type: 'reframe' })).toBe(sending);
    expect(viewfinderReducer(sending, { type: 'pick' })).toBe(sending);
  });

  it('closes on success, returns to captured on a failure that wrote nothing, and closes on a failure after the node was placed', () => {
    const sending = run([{ type: 'pick' }, { type: 'send', target: 'canvas' }], captured);
    expect(sending.phase).toBe('sending');
    expect(viewfinderReducer(sending, { type: 'settle', session: sending.session, outcome: 'done' }).phase).toBe('off');
    expect(viewfinderReducer(sending, { type: 'settle', session: sending.session, outcome: 'retry' })).toMatchObject({ phase: 'captured', sending: null, shot: SHOT });
    expect(viewfinderReducer(sending, { type: 'settle', session: sending.session, outcome: 'close' }).phase).toBe('off');
  });

  it('closes mid-send on Esc or the button, and the detached result then changes nothing', () => {
    const sending = viewfinderReducer(captured, { type: 'send', target: 'agent' });
    const closed = viewfinderReducer(sending, { type: 'close' });
    expect(closed.phase).toBe('off');
    expect(viewfinderReducer(closed, { type: 'settle', session: sending.session, outcome: 'retry' })).toBe(closed);
    const reopened = run([{ type: 'open', frame: FRAME }, { type: 'captured', shot: SHOT }], closed);
    expect(viewfinderReducer(reopened, { type: 'settle', session: sending.session, outcome: 'done' })).toBe(reopened);
  });

  it('treats Esc in captured as re-frame and in the canvas list as closing the list', () => {
    expect(viewfinderReducer(captured, { type: 'escape' }).phase).toBe('framing');
    expect(viewfinderReducer(viewfinderReducer(captured, { type: 'pick' }), { type: 'escape' }).phase).toBe('captured');
    expect(viewfinderReducer(framing, { type: 'escape' }).phase).toBe('off');
    expect(viewfinderReducer(viewfinderReducer(captured, { type: 'send', target: 'copy' }), { type: 'escape' }).phase).toBe('off');
    expect(viewfinderReducer(INITIAL_VIEWFINDER, { type: 'escape' })).toBe(INITIAL_VIEWFINDER);
  });
});
