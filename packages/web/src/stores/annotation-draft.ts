// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The text someone is typing into an annotation, before any of it reaches Yjs.
 *
 * One draft at a time, and the same shape serves all three uses: a new
 * annotation, a new reply, and editing something already posted. Nothing here
 * is shared — a collaborator sees the words only once `commit` comes back on a
 * closed draft and the caller writes them.
 */

/** Which of the three things the open box is for. */
export type DraftUse = 'annotation' | 'reply' | 'edit';

/**
 * Which entry on a sticky the open box belongs to: its body, or one reply.
 *
 * Lives with the draft rather than with the node that draws it, because the
 * two are one fact — a box with no entry under it is not a state anything can
 * act on, and a pair stored apart could come to name different entries.
 */
export type DraftTarget = { kind: 'body' } | { kind: 'reply'; id: string } | null;

export interface DraftState {
  /**
   * Whether a box is on screen.
   *
   * No IME state here: the platform reports whether a keystroke belongs to a
   * composition on the keystroke itself (`KeyboardEvent.isComposing`), and the
   * boxes read it there, as the canvas, the crop overlay and the chat composer
   * all do. A copy kept in here would be a second source of truth that can
   * fall out of step with the IME and never come back — the draft outlives its
   * textarea on purpose, so a composition cut short by the canvas culling the
   * sticky left every way out of the box refused for good.
   */
  mode: 'closed' | 'typing';
  /** What the box is for. Meaningless while closed; kept so callers can read it back. */
  use: DraftUse;
  /** The words as they stand. */
  text: string;
  /**
   * Set only on the transition that closes a draft the user meant to keep.
   * The caller writes this to Yjs and nothing else does — a close with no
   * `commit` wrote nothing, which is what "Yjs holds no empty annotation"
   * rests on.
   */
  commit?: string;
  /** Set when the close came from this annotation or reply being deleted elsewhere. */
  targetGone?: boolean;
}

export type DraftAction =
  | { type: 'open'; use: DraftUse; text: string }
  | { type: 'type'; text: string }
  | { type: 'escape' }
  | { type: 'blur' }
  | { type: 'save' }
  | { type: 'cancel' }
  | { type: 'targetGone' };

/** No box on screen. */
export const CLOSED_DRAFT: DraftState = {
  mode: 'closed',
  use: 'annotation',
  text: '',
};

/**
 * Whether these words are worth writing.
 * @param text - The draft body.
 * @returns True when it holds something other than whitespace.
 */
const worthWriting = (text: string): boolean => text.trim().length > 0;

/**
 * Close the draft and hand its words to the caller to write.
 * @param state - The draft as it stands.
 * @returns A closed draft carrying `commit`, or `state` when the body is blank.
 */
const commitDraft = (state: DraftState): DraftState =>
  worthWriting(state.text)
    ? { mode: 'closed', use: state.use, text: '', commit: state.text }
    : state;

/**
 * Close the draft, throwing the words away.
 * @param state - The draft as it stands.
 * @returns A closed draft carrying no `commit`, so nothing is written.
 */
const discardDraft = (state: DraftState): DraftState => ({
  mode: 'closed',
  use: state.use,
  text: '',
});

/**
 * Advance the draft. The one place its state changes.
 * @param state - The draft as it stands.
 * @param action - What just happened.
 * @returns The next draft, or `state` itself when nothing moves.
 */
export function reduceDraft(
  state: DraftState,
  action: DraftAction,
): DraftState {
  switch (action.type) {
    case 'open':
      // An entry point only renders while nothing is open, so a second open
      // is a stale event rather than a request to throw away live words.
      if (state.mode !== 'closed') return state;
      return { mode: 'typing', use: action.use, text: action.text };

    case 'type':
      if (state.mode === 'closed') return state;
      return { ...state, text: action.text, commit: undefined };

    case 'save':
      // Every way of keeping the words — the Enter key, the Save button, the
      // reply's Post button — is this one action. Whether a keystroke was the
      // user's or the IME's is settled at the keydown, where the platform
      // says so, and never reaches here.
      if (state.mode === 'closed') return state;
      return commitDraft(state);

    case 'escape':
    case 'cancel':
      if (state.mode === 'closed') return state;
      return discardDraft(state);

    case 'blur':
      // A fresh box holds words that never existed, so losing focus drops
      // them. An edit holds words already on the canvas: dropping them loses
      // the user's work and keeping them silently overwrites the original, so
      // it waits for save or cancel.
      if (state.mode === 'closed' || state.use === 'edit') return state;
      return discardDraft(state);

    case 'targetGone':
      if (state.mode === 'closed') return state;
      return { ...discardDraft(state), targetGone: true };
  }
}
