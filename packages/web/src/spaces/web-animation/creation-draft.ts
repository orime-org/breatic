// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Motion Space's New and Modify dialog state (inner#1711 design §9, #1490 design §5.1): `transitionCreationDraft`
 * is its one writer.
 *
 * Execute fixes the input and the action id; until the accept answers, edits are ignored, a second Execute joins the
 * same action and opening shows that submission. Closing while submitting hides the dialog and lets the submission go
 * on; the acceptance of its own action closes the draft (another action's never does), a refusal brings it back with
 * the user's input and the reason.
 */

import type { WebAnimationAspect } from '@breatic/shared/space-content';

import type { WebAnimationEngine } from '@web/spaces/web-animation/execution-text';

/** What the user fills in. */
export interface CreationDraftInput {
  /** The result a modification starts from, or null for a new animation. */
  base: { executionId: string; sourceVersionId: string; request: string } | null;
  /** The prompt of a new animation, or the instruction of a modification. */
  prompt: string;
  engine: WebAnimationEngine;
  aspect: WebAnimationAspect;
  durationSeconds: number;
}

/** Closed, being filled in, or submitted and waiting for the accept. */
export type CreationDraftState =
  | { status: 'closed' }
  | { status: 'drafting'; open: true; input: CreationDraftInput; error: string | null; retry: boolean }
  | { status: 'submitting'; open: boolean; input: CreationDraftInput; actionId: string; retry: boolean };

/** What the dialog and the accept tell the draft. */
export type CreationDraftEvent =
  /** `retry` says the dialog runs a failed run again; it stays with the draft it opened. */
  | { type: 'open'; input: CreationDraftInput; retry: boolean }
  | { type: 'edit'; patch: Partial<CreationDraftInput> }
  | { type: 'execute'; actionId: string }
  | { type: 'close' }
  /** An accept answered; only the submission's own action closes the draft. */
  | { type: 'accepted'; actionId: string }
  | { type: 'refused'; error: string | null };

/** No dialog: the draft's start and where it returns once closed or accepted. */
export const CREATION_DRAFT_CLOSED: CreationDraftState = { status: 'closed' };

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
      return event.type === 'open' ? { status: 'drafting', open: true, input: event.input, error: null, retry: event.retry } : state;
    case 'drafting':
      if (event.type === 'edit') return { ...state, input: { ...state.input, ...event.patch } };
      if (event.type === 'execute') return { status: 'submitting', open: true, input: state.input, actionId: event.actionId, retry: state.retry };
      if (event.type === 'close') return CREATION_DRAFT_CLOSED;
      return state;
    case 'submitting':
      if (event.type === 'open') return state.open ? state : { ...state, open: true };
      if (event.type === 'close') return state.open ? { ...state, open: false } : state;
      if (event.type === 'accepted') return event.actionId === state.actionId ? CREATION_DRAFT_CLOSED : state;
      if (event.type === 'refused') return { status: 'drafting', open: true, input: state.input, error: event.error, retry: state.retry };
      return state;
  }
}
