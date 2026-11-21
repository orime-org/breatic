// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One request to open, or make and open, a Motion Space (#1490 design §8.5, §13.5). The Timeline's "make in Motion"
 * entry and "Open in Motion" ask for the newest Motion Space; a canvas video's "Open source animation" names its Space.
 * The one writer is `transitionSpaceOpenRequest`: the project page resolves a request whenever the state is
 * `requesting`, runs the effects, and the Motion Space it opened takes the selection and says it handled it.
 */

import { create } from 'zustand';

/** What is asked for. */
export interface SpaceOpenRequest {
  type: 'web_animation';
  /** A named Space; without it, the newest Space of the type. */
  spaceId?: string;
  /** The execution the Space selects once open. */
  select?: string;
}

/** The request's state. */
export type SpaceOpenRequestState =
  | { status: 'none' }
  | { status: 'requesting'; request: SpaceOpenRequest }
  | { status: 'creating'; request: SpaceOpenRequest; next: SpaceOpenRequest | null }
  | { status: 'opened'; request: SpaceOpenRequest; spaceId: string };

/** What can happen to it. */
export type SpaceOpenRequestEvent =
  | { type: 'request'; request: SpaceOpenRequest }
  | { type: 'target_exists'; spaceId: string }
  | { type: 'target_missing' }
  | { type: 'target_gone' }
  | { type: 'created'; spaceId: string }
  | { type: 'create_failed' }
  | { type: 'handled' }
  | { type: 'leave' }
  /** The Project page that carries requests out closed; nothing can finish what is pending. */
  | { type: 'reset' };

/** What the project page does next. */
export type SpaceOpenRequestEffect =
  | { type: 'open_tab'; spaceId: string }
  | { type: 'create'; spaceType: 'web_animation'; name: string }
  | { type: 'toast_source_space_gone' };

/** A transition's outcome. */
export interface SpaceOpenRequestTransition {
  state: SpaceOpenRequestState;
  effects: SpaceOpenRequestEffect[];
}

/** The name a Motion Space is made with, as the backend's default. */
const MOTION_NAME = 'Motion';

const NONE: SpaceOpenRequestState = { status: 'none' };

/**
 * The request after one event.
 * @param state - The request now.
 * @param event - What happened.
 * @returns The request after it and what the project page does next.
 * @throws {never} Never.
 */
export function transitionSpaceOpenRequest(state: SpaceOpenRequestState, event: SpaceOpenRequestEvent): SpaceOpenRequestTransition {
  const stay: SpaceOpenRequestTransition = { state, effects: [] };
  if (event.type === 'reset') return { state: NONE, effects: [] };
  if (event.type === 'request') {
    if (state.status === 'creating') return { state: { ...state, next: event.request }, effects: [] };
    return { state: { status: 'requesting', request: event.request }, effects: [] };
  }
  switch (state.status) {
    case 'none':
      return stay;
    case 'requesting':
      if (event.type === 'target_exists') return { state: { status: 'opened', request: state.request, spaceId: event.spaceId }, effects: [{ type: 'open_tab', spaceId: event.spaceId }] };
      if (event.type === 'target_missing') return { state: { status: 'creating', request: state.request, next: null }, effects: [{ type: 'create', spaceType: 'web_animation', name: MOTION_NAME }] };
      if (event.type === 'target_gone') return { state: NONE, effects: [{ type: 'toast_source_space_gone' }] };
      return stay;
    case 'creating':
      if (event.type === 'create_failed') return { state: NONE, effects: [] };
      if (event.type !== 'created') return stay;
      if (state.next !== null) {
        return { state: { status: 'requesting', request: state.next }, effects: [{ type: 'open_tab', spaceId: event.spaceId }] };
      }
      return { state: { status: 'opened', request: state.request, spaceId: event.spaceId }, effects: [{ type: 'open_tab', spaceId: event.spaceId }] };
    case 'opened':
      return event.type === 'handled' || event.type === 'leave' ? { state: NONE, effects: [] } : stay;
  }
}

interface SpaceOpenRequestStore {
  state: SpaceOpenRequestState;
  /**
   * Apply one event.
   * @returns The effects for the project page.
   */
  dispatch: (event: SpaceOpenRequestEvent) => SpaceOpenRequestEffect[];
}

export const useSpaceOpenRequestStore = create<SpaceOpenRequestStore>()((set, get) => ({
  state: NONE,
  dispatch: (event) => {
    const { state, effects } = transitionSpaceOpenRequest(get().state, event);
    set({ state });
    return effects;
  },
}));
