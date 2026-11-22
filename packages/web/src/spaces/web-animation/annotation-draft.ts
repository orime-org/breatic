// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adding an annotation at the playhead (#1490 design §13.7). The one writer is `transitionAnnotationDraft`; its
 * effects pause playback, ask before throwing text away, write the thread and toast.
 */

import type { WebAnimationAnchor } from '@breatic/shared/space-content';

/** A point on the frame, as fractions of its width and height. */
export type FramePoint = { x: number; y: number };

/** The draft's state. */
export type AnnotationDraftState =
  | { status: 'idle' }
  | { status: 'picking'; executionId: string; timeSeconds: number }
  | { status: 'writing'; executionId: string; timeSeconds: number; point: FramePoint | null; text: string }
  | { status: 'sending'; executionId: string; timeSeconds: number; point: FramePoint | null; text: string };

/** What can happen to the draft. */
export type AnnotationDraftEvent =
  | { type: 'add'; executionId: string; timeSeconds: number }
  | { type: 'click_frame'; point: FramePoint }
  | { type: 'type'; text: string }
  | { type: 'send' }
  | { type: 'written' }
  | { type: 'write_failed'; reason: string }
  | { type: 'cancel'; confirmed: boolean }
  | { type: 'switch_result'; confirmed: boolean };

/** What the Space does after a transition. */
export type AnnotationDraftEffect =
  | { type: 'pause' }
  | { type: 'confirm_discard' }
  | { type: 'write'; anchor: WebAnimationAnchor; text: string }
  | { type: 'toast_failed'; reason: string };

/** A transition's outcome. */
export interface AnnotationDraftTransition {
  state: AnnotationDraftState;
  effects: AnnotationDraftEffect[];
}

export const ANNOTATION_DRAFT_IDLE: AnnotationDraftState = { status: 'idle' };

const IDLE: AnnotationDraftTransition = { state: ANNOTATION_DRAFT_IDLE, effects: [] };

/**
 * Close a draft that is being written, asking first when it holds text.
 * @param state - The draft.
 * @param confirmed - Whether the user already agreed to throw its text away.
 * @returns The transition.
 * @throws {never} Never.
 */
function closeWriting(state: Extract<AnnotationDraftState, { status: 'writing' }>, confirmed: boolean): AnnotationDraftTransition {
  if (state.text.trim() === '' || confirmed) return IDLE;
  return { state, effects: [{ type: 'confirm_discard' }] };
}

/**
 * The draft after one event.
 * @param state - The draft now.
 * @param event - What happened.
 * @returns The draft after it and what the Space does next.
 * @throws {never} Never.
 */
export function transitionAnnotationDraft(state: AnnotationDraftState, event: AnnotationDraftEvent): AnnotationDraftTransition {
  const stay: AnnotationDraftTransition = { state, effects: [] };
  switch (state.status) {
    case 'idle':
      if (event.type !== 'add') return stay;
      return { state: { status: 'picking', executionId: event.executionId, timeSeconds: event.timeSeconds }, effects: [{ type: 'pause' }] };
    case 'picking': {
      const base = { status: 'writing' as const, executionId: state.executionId, timeSeconds: state.timeSeconds };
      switch (event.type) {
        case 'click_frame': return { state: { ...base, point: event.point, text: '' }, effects: [] };
        case 'type': return { state: { ...base, point: null, text: event.text }, effects: [] };
        case 'cancel': case 'switch_result': return IDLE;
        default: return stay;
      }
    }
    case 'writing':
      switch (event.type) {
        case 'click_frame': return { state: { ...state, point: event.point }, effects: [] };
        case 'type': return { state: { ...state, text: event.text }, effects: [] };
        case 'send': {
          if (state.text.trim() === '') return stay;
          const { executionId, timeSeconds, point, text } = state;
          return {
            state: { status: 'sending', executionId, timeSeconds, point, text },
            effects: [{ type: 'write', anchor: { executionId, timeSeconds, point }, text }],
          };
        }
        case 'cancel': case 'switch_result': return closeWriting(state, event.confirmed);
        default: return stay;
      }
    case 'sending':
      if (event.type === 'written') return IDLE;
      if (event.type !== 'write_failed') return stay;
      return {
        state: { status: 'writing', executionId: state.executionId, timeSeconds: state.timeSeconds, point: state.point, text: state.text },
        effects: [{ type: 'toast_failed', reason: event.reason }],
      };
  }
}
