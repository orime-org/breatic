// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog's session (inner#1860, design §6.2): one pure reducer
 * over composing / streaming / stopped / done / failed / closed, and the one
 * function that decides which buttons the dialog shows.
 *
 * What has to happen outside the reducer (start or abort a request, toast,
 * write into the body) comes back as effects, so the reducer is the only
 * place the table of §6.2 is written down. Every request carries a number
 * that grows across sessions; a stream event naming any request but the
 * current one changes nothing, which is how an aborted or superseded request
 * can never reach the dialog.
 */

import type { TextToolLanguage, TextToolTone } from '@breatic/shared';

/** A command the AI menu runs. */
export type AiCommand =
  | { readonly id: 'refine' | 'expand' | 'shorten' | 'custom' }
  | { readonly id: 'translate'; readonly language: TextToolLanguage }
  | { readonly id: 'tone'; readonly style: TextToolTone };

/** Where a session is. */
export type AiSessionState = 'composing' | 'streaming' | 'stopped' | 'done' | 'failed' | 'closed';

/** The dialog's session. */
export interface AiSession {
  readonly state: AiSessionState;
  readonly command: AiCommand;
  /** What the current request has streamed so far. */
  readonly result: string;
  /** The custom instruction once submitted; null for every other command. */
  readonly instructions: string | null;
  /** The number of the session's current request, growing across sessions. */
  readonly seq: number;
}

/** What reaches the session: the user's presses, the stream, the body. */
export type AiSessionEvent =
  | { readonly type: 'open'; readonly command: AiCommand }
  | { readonly type: 'submit'; readonly instructions: string }
  | { readonly type: 'delta'; readonly seq: number; readonly text: string }
  | { readonly type: 'done'; readonly seq: number }
  | { readonly type: 'error'; readonly seq: number }
  | { readonly type: 'stop' | 'retry' | 'close' }
  | { readonly type: 'insert' | 'replace'; readonly writable: boolean };

/** What the reducer asks the world to do. */
export type AiEffect =
  | { readonly kind: 'request' | 'abort'; readonly seq: number }
  | { readonly kind: 'write'; readonly how: 'insert' | 'replace'; readonly result: string }
  | { readonly kind: 'toastFailure' | 'toastNotWritable' };

/** A session after one event, and what has to happen because of it. */
export interface AiStep {
  readonly session: AiSession | null;
  readonly effects: readonly AiEffect[];
}

/**
 * The step that changes nothing.
 * @param session - The session.
 * @returns It, with nothing to do.
 */
function unchanged(session: AiSession | null): AiStep {
  return { session, effects: [] };
}

/**
 * Opens a session on a command, closing the one before it.
 * @param before - The session before, or null.
 * @param command - The command.
 * @returns The new session, aborting the old request when one was in flight.
 */
function open(before: AiSession | null, command: AiCommand): AiStep {
  const aborts: AiEffect[] = before?.state === 'streaming' ? [{ kind: 'abort', seq: before.seq }] : [];
  const seq = (before?.seq ?? 0) + 1;
  const composing = command.id === 'custom';
  const session: AiSession = {
    state: composing ? 'composing' : 'streaming',
    command,
    result: '',
    instructions: null,
    seq,
  };
  return { session, effects: composing ? aborts : [...aborts, { kind: 'request', seq }] };
}

/**
 * Starts the session's next request.
 * @param session - The session.
 * @param instructions - The instruction it runs with.
 * @returns The session streaming the new request.
 */
function request(session: AiSession, instructions: string | null): AiStep {
  const seq = session.seq + 1;
  return { session: { ...session, state: 'streaming', result: '', instructions, seq }, effects: [{ kind: 'request', seq }] };
}

/**
 * A stream event of the current request, while it streams.
 * @param session - The session, streaming.
 * @param event - The event.
 * @returns The step.
 */
function streamed(session: AiSession, event: AiSessionEvent & { type: 'delta' | 'done' | 'error' }): AiStep {
  switch (event.type) {
    case 'delta':
      return unchanged({ ...session, result: session.result + event.text });
    case 'done':
      return unchanged({ ...session, state: 'done' });
    case 'error':
      // Failures toast here, in this function only (§6.2 invariant).
      return { session: { ...session, state: 'failed', result: '' }, effects: [{ kind: 'toastFailure' }] };
  }
}

/**
 * A press on insert or replace, in stopped or done.
 * @param session - The session.
 * @param event - The press.
 * @returns The write and the closed session, a toast, or nothing.
 */
function written(session: AiSession, event: AiSessionEvent & { type: 'insert' | 'replace' }): AiStep {
  if (session.result.trim() === '') return unchanged(session);
  if (!event.writable) return { session, effects: [{ kind: 'toastNotWritable' }] };
  return {
    session: { ...session, state: 'closed' },
    effects: [{ kind: 'write', how: event.type, result: session.result }],
  };
}

/**
 * The dialog's session after one event (design §6.2).
 * @param session - The session before, or null when none was opened yet.
 * @param event - The event.
 * @returns The session after it and what has to happen.
 */
export function reduceAiSession(session: AiSession | null, event: AiSessionEvent): AiStep {
  if (event.type === 'open') return open(session, event.command);
  if (session === null || session.state === 'closed') return unchanged(session);
  const { state } = session;
  const finished = state === 'stopped' || state === 'done';
  switch (event.type) {
    case 'submit':
      return state === 'composing' && event.instructions.trim() !== '' ? request(session, event.instructions) : unchanged(session);
    case 'delta':
    case 'done':
    case 'error':
      return state === 'streaming' && event.seq === session.seq ? streamed(session, event) : unchanged(session);
    case 'stop':
      return state === 'streaming'
        ? { session: { ...session, state: 'stopped' }, effects: [{ kind: 'abort', seq: session.seq }] }
        : unchanged(session);
    case 'retry':
      return finished || state === 'failed' ? request(session, session.instructions) : unchanged(session);
    case 'insert':
    case 'replace':
      return finished ? written(session, event) : unchanged(session);
    case 'close':
      return {
        session: { ...session, state: 'closed' },
        effects: state === 'streaming' ? [{ kind: 'abort', seq: session.seq }] : [],
      };
  }
}

/** Why insert or replace cannot be pressed. */
export type AiButtonReason = 'rangeGone' | 'insertBlockGone';

/** Insert or replace: shown, and whether it can be pressed. */
export interface AiWriteButton {
  readonly disabled: boolean;
  readonly reason: AiButtonReason | null;
}

/** The dialog's buttons; null for insert or replace means not shown. */
export interface AiDialogButtons {
  readonly stop: boolean;
  readonly retry: boolean;
  readonly insert: AiWriteButton | null;
  readonly replace: AiWriteButton | null;
}

/** What decides the buttons, and nothing else does (§6.2 invariant). */
export interface AiButtonInputs {
  readonly state: AiSessionState;
  readonly resultEmpty: boolean;
  /** Whether all of the result is on screen; it is revealed at a reading pace. */
  readonly revealed: boolean;
  /** Whether replace can be written over the original words (`aiCoverIn` is not null). */
  readonly replaceable: boolean;
  readonly insertBlockPresent: boolean;
}

/**
 * The buttons the dialog shows (§5.3, A5, A7).
 * @param inputs - What decides them.
 * @param inputs.state - The session's state.
 * @param inputs.resultEmpty - Whether its result holds only blanks.
 * @param inputs.revealed - Whether all of the result is on screen.
 * @param inputs.replaceable - Whether replace can be written (`aiCoverIn` is not null).
 * @param inputs.insertBlockPresent - Whether the insert block is in the body.
 * @returns The buttons.
 */
export function aiDialogButtons({ state, resultEmpty, revealed, replaceable, insertBlockPresent }: AiButtonInputs): AiDialogButtons {
  const finished = state === 'stopped' || state === 'done';
  const writable = finished && !resultEmpty && revealed;
  // The block gone says more than the words gone: neither can be written.
  const replaceReason: AiButtonReason | null = replaceable ? null : insertBlockPresent ? 'rangeGone' : 'insertBlockGone';
  return {
    // An answer the server has finished can still be being written on
    // screen; until it is all shown, that is still the output, and stop applies.
    stop: state === 'streaming' || (finished && !revealed),
    retry: (finished && revealed) || state === 'failed',
    insert: writable ? { disabled: !insertBlockPresent, reason: insertBlockPresent ? null : 'insertBlockGone' } : null,
    replace: writable ? { disabled: !replaceable, reason: replaceReason } : null,
  };
}
