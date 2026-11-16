// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space's New and Modify dialog state (inner#1711 design §9, #1490 design §5.1): `transitionCreationDraft`
 * is its one writer.
 *
 * Execute fixes the input and the action id; until the accept answers, edits are ignored, a second Execute joins the
 * same action and opening shows that submission. Closing while submitting hides the dialog and lets the submission go
 * on; acceptance closes the draft, a refusal brings it back with the user's input and the reason.
 */

import type { WebAnimationEngine } from '@web/spaces/web-animation/execution-text';

/** What the user fills in. */
export interface CreationDraftInput {
  /** The result a modification starts from, or null for a new animation. */
  base: { executionId: string; sourceVersionId: string; request: string } | null;
  /** The prompt of a new animation, or the instruction of a modification. */
  prompt: string;
  engine: WebAnimationEngine;
  aspect: '16:9' | '9:16' | '1:1';
  durationSeconds: number;
}

/** Closed, being filled in, or submitted and waiting for the accept. */
export type CreationDraftState =
  | { status: 'closed' }
  | { status: 'drafting'; open: true; input: CreationDraftInput; error: string | null }
  | { status: 'submitting'; open: boolean; input: CreationDraftInput; actionId: string };

/** What the dialog and the accept tell the draft. */
export type CreationDraftEvent =
  | { type: 'open'; input: CreationDraftInput }
  | { type: 'edit'; patch: Partial<CreationDraftInput> }
  | { type: 'execute'; actionId: string }
  | { type: 'close' }
  | { type: 'accepted'; executionId: string }
  | { type: 'refused'; error: string };

const CLOSED: CreationDraftState = { status: 'closed' };

/**
 * Apply one event to the creation draft.
 * @param state - The current draft.
 * @param event - What happened.
 * @returns The next draft; the same object when the event changes nothing.
 * @throws {never} Never.
 */
export function transitionCreationDraft(state: CreationDraftState, event: CreationDraftEvent): CreationDraftState {
  switch (state.status) {
    case 'closed':
      return event.type === 'open' ? { status: 'drafting', open: true, input: event.input, error: null } : state;
    case 'drafting':
      if (event.type === 'edit') return { ...state, input: { ...state.input, ...event.patch } };
      if (event.type === 'execute') return { status: 'submitting', open: true, input: state.input, actionId: event.actionId };
      if (event.type === 'close') return CLOSED;
      return state;
    case 'submitting':
      if (event.type === 'open') return state.open ? state : { ...state, open: true };
      if (event.type === 'close') return state.open ? { ...state, open: false } : state;
      if (event.type === 'accepted') return CLOSED;
      if (event.type === 'refused') return { status: 'drafting', open: true, input: state.input, error: event.error };
      return state;
  }
}
