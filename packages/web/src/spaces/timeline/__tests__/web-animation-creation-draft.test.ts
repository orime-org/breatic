// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The creation dialog's state (inner#1711 design §9, the table whose one writer is `transitionCreationDraft`).
 *
 * Execute fixes the input and the action id; while the accept is out, edits are ignored and a second Execute joins
 * the same action. Closing while submitting lets the submission go on; its answer closes the draft (accepted) or
 * brings it back with the user's input and the reason (refused).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  transitionCreationDraft, type CreationDraftEvent, type CreationDraftInput, type CreationDraftState,
} from '@web/spaces/timeline/web-animation-creation-draft';

const INPUT: CreationDraftInput = { prompt: 'A blue title slides in', engine: 'deepseek', aspect: '16:9', durationSeconds: 4, addAtPlayhead: true };
const ACTION = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ACTION = 'a0000000-0000-4000-8000-000000000002';
const CLOSED: CreationDraftState = { status: 'closed' };

/**
 * Run events from a state.
 * @param state - The start.
 * @param events - The events, in order.
 * @returns The end state.
 * @throws {never} Never.
 */
function run(state: CreationDraftState, ...events: CreationDraftEvent[]): CreationDraftState {
  return events.reduce(transitionCreationDraft, state);
}

const drafting = run(CLOSED, { type: 'open', input: INPUT });
const submitting = run(drafting, { type: 'execute', actionId: ACTION });

describe('transitionCreationDraft', () => {
  it('opens a draft from closed with the given input', () => {
    expect(drafting).toEqual({ status: 'drafting', open: true, input: INPUT, error: null });
  });

  it.each<CreationDraftEvent>([
    { type: 'edit', patch: { prompt: 'x' } },
    { type: 'execute', actionId: ACTION },
    { type: 'accepted', executionId: 'e' },
    { type: 'refused', error: 'no' },
    { type: 'close' },
  ])('ignores $type while closed', (event) => {
    expect(transitionCreationDraft(CLOSED, event)).toEqual(CLOSED);
  });

  it('edits a draft, keeps it when opened again and closes it', () => {
    const edited = run(drafting, { type: 'edit', patch: { aspect: '9:16', durationSeconds: 8 } });
    expect(edited).toEqual({ status: 'drafting', open: true, input: { ...INPUT, aspect: '9:16', durationSeconds: 8 }, error: null });
    expect(run(edited, { type: 'open', input: { ...INPUT, prompt: 'other' } })).toEqual(edited);
    expect(run(edited, { type: 'close' })).toEqual(CLOSED);
  });

  it('ignores an answer while drafting', () => {
    expect(run(drafting, { type: 'accepted', executionId: 'e' })).toEqual(drafting);
    expect(run(drafting, { type: 'refused', error: 'no' })).toEqual(drafting);
  });

  it('fixes the input and the action id on Execute', () => {
    expect(submitting).toEqual({ status: 'submitting', open: true, input: INPUT, actionId: ACTION });
  });

  it('keeps the fixed input and joins the same action while submitting', () => {
    expect(run(submitting, { type: 'edit', patch: { prompt: 'changed' } })).toEqual(submitting);
    expect(run(submitting, { type: 'execute', actionId: OTHER_ACTION })).toEqual(submitting);
    expect(run(submitting, { type: 'open', input: { ...INPUT, prompt: 'other' } })).toEqual(submitting);
  });

  it('lets a submission go on when the dialog closes, and closes the draft on acceptance', () => {
    const hidden = run(submitting, { type: 'close' });
    expect(hidden).toEqual({ status: 'submitting', open: false, input: INPUT, actionId: ACTION });
    expect(run(hidden, { type: 'open', input: { ...INPUT, prompt: 'other' } })).toEqual(submitting);
    expect(run(hidden, { type: 'accepted', executionId: 'e' })).toEqual(CLOSED);
    expect(run(submitting, { type: 'accepted', executionId: 'e' })).toEqual(CLOSED);
  });

  it('brings a refused submission back as a draft with the input and the reason', () => {
    expect(run(submitting, { type: 'refused', error: 'Not enough credits.' })).toEqual({ status: 'drafting', open: true, input: INPUT, error: 'Not enough credits.' });
  });

  it('gives a new action id to the Execute after a refusal', () => {
    const again = run(submitting, { type: 'refused', error: 'no' }, { type: 'execute', actionId: OTHER_ACTION });
    expect(again).toMatchObject({ status: 'submitting', actionId: OTHER_ACTION });
  });

  it('never changes a submission input or action id before its answer (fast-check)', () => {
    const event = fc.oneof(
      fc.record({ type: fc.constant('edit' as const), patch: fc.record({ prompt: fc.string() }) }),
      fc.record({ type: fc.constant('execute' as const), actionId: fc.uuid() }),
      fc.record({ type: fc.constant('open' as const), input: fc.constant({ ...INPUT, prompt: 'other' }) }),
      fc.constant({ type: 'close' as const }),
    );
    fc.assert(fc.property(fc.array(event, { maxLength: 12 }), (events) => {
      const end = run(submitting, ...events);
      expect(end).toMatchObject({ status: 'submitting', input: INPUT, actionId: ACTION });
    }));
  });
});
