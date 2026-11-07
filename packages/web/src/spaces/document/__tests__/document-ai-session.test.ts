// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog's session (inner#1860, design §6.2): one reducer over
 * composing / streaming / stopped / done / failed / closed and the events
 * E1-E14, plus the one pure function that decides which buttons the dialog
 * shows (§5.3, invariant "按钮集合只由……决定").
 *
 * Every cell of the §6.2 table is a case below. E11 (Space tab closed, page
 * left, editor unmounted) is the same `close` event as E9: the table gives
 * the two columns the same outcome in every row but `closed`, where E9 is
 * impossible and E11 changes nothing, which is also what `close` on a closed
 * session does. E13 (write access lost) is not an event of its own: the
 * table keeps every state where it is, and in stopped / done the press on
 * insert or replace says it with a toast, so it is the `writable` flag those
 * two presses carry.
 *
 * The reducer is pure: what has to happen outside it (start or abort a
 * request, toast, write into the body) comes back as effects.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  aiDialogButtons,
  reduceAiSession,
  type AiCommand,
  type AiEffect,
  type AiSession,
  type AiSessionEvent,
  type AiSessionState,
  type AiStep,
} from '@web/spaces/document/document-ai-session';

const REFINE: AiCommand = { id: 'refine' };
const EXPAND: AiCommand = { id: 'expand' };
const CUSTOM: AiCommand = { id: 'custom' };

/**
 * Runs events one after another from a starting session.
 * @param events - The events.
 * @param from - Where to start; null for no session yet.
 * @returns The last step.
 */
function run(events: readonly AiSessionEvent[], from: AiSession | null = null): AiStep {
  let step: AiStep = { session: from, effects: [] };
  for (const event of events) step = reduceAiSession(step.session, event);
  return step;
}

/**
 * The session a step leaves, which these cases always expect to be there.
 * @param step - The step.
 * @returns Its session.
 */
function sessionOf(step: AiStep): AiSession {
  expect(step.session).not.toBeNull();
  return step.session!;
}

/**
 * A session in a given state, reached the way a user reaches it.
 * @param state - The state.
 * @param command - The command it runs; custom reaches streaming through a submit.
 * @returns The session.
 */
function sessionIn(state: AiSessionState, command: AiCommand = REFINE): AiSession {
  if (state === 'composing') return sessionOf(run([{ type: 'open', command: CUSTOM }]));
  let session = sessionOf(run([{ type: 'open', command }]));
  if (command.id === 'custom') session = sessionOf(run([{ type: 'submit', instructions: 'Make it rhyme' }], session));
  expect(session.state).toBe('streaming');
  const seq = session.seq;
  switch (state) {
    case 'streaming':
      return session;
    case 'stopped':
      return sessionOf(run([{ type: 'delta', seq, text: 'Hi' }, { type: 'stop' }], session));
    case 'done':
      return sessionOf(run([{ type: 'delta', seq, text: 'Hi' }, { type: 'done', seq }], session));
    case 'failed':
      return sessionOf(run([{ type: 'error', seq }], session));
    case 'closed':
      return sessionOf(run([{ type: 'close' }], session));
  }
}

/** The three stream events, each for the given request. */
function streamEvents(seq: number): AiSessionEvent[] {
  return [
    { type: 'delta', seq, text: 'late' },
    { type: 'done', seq },
    { type: 'error', seq },
  ];
}

/**
 * Says a step changed nothing: same session, nothing to do.
 * @param before - The session before.
 * @param event - The event.
 */
function expectUnchanged(before: AiSession, event: AiSessionEvent): void {
  const step = reduceAiSession(before, event);
  expect(step.session).toEqual(before);
  expect(step.effects).toEqual([]);
}

describe('opening a session', () => {
  it('starts a request straight away for a command that needs no instruction', () => {
    const step = run([{ type: 'open', command: REFINE }]);
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', command: REFINE, result: '', instructions: null });
    expect(step.effects).toEqual([{ kind: 'request', seq: session.seq }]);
  });

  it('waits for the instruction, sending nothing, for a custom instruction', () => {
    const step = run([{ type: 'open', command: CUSTOM }]);

    expect(sessionOf(step)).toMatchObject({ state: 'composing', command: CUSTOM, result: '', instructions: null });
    expect(step.effects).toEqual([]);
  });
});

describe('composing (custom instruction, not started)', () => {
  it('E1: a non-empty instruction starts the request and keeps the instruction', () => {
    const step = reduceAiSession(sessionIn('composing'), { type: 'submit', instructions: 'Make it rhyme' });
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', instructions: 'Make it rhyme', result: '' });
    expect(step.effects).toEqual([{ kind: 'request', seq: session.seq }]);
  });

  it('E1: an instruction of only blanks starts nothing', () => {
    expectUnchanged(sessionIn('composing'), { type: 'submit', instructions: '  \n ' });
  });

  it('E2 E3 E4 E14: impossible with no request sent, so nothing changes', () => {
    const session = sessionIn('composing');
    for (const event of [...streamEvents(session.seq), ...streamEvents(session.seq + 1)]) expectUnchanged(session, event);
  });

  it('E5 E6 E7 E8: impossible, their buttons are not there', () => {
    const session = sessionIn('composing');
    expectUnchanged(session, { type: 'stop' });
    expectUnchanged(session, { type: 'retry' });
    expectUnchanged(session, { type: 'insert', writable: true });
    expectUnchanged(session, { type: 'replace', writable: true });
  });

  it('E9 / E11: closes, with no request to abort', () => {
    const step = reduceAiSession(sessionIn('composing'), { type: 'close' });

    expect(sessionOf(step).state).toBe('closed');
    expect(step.effects).toEqual([]);
  });

  it('E10: closes and opens the new command', () => {
    const before = sessionIn('composing');
    const step = reduceAiSession(before, { type: 'open', command: EXPAND });
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', command: EXPAND, result: '' });
    expect(session.seq).toBeGreaterThan(before.seq);
    expect(step.effects).toEqual([{ kind: 'request', seq: session.seq }]);
  });

});

describe('streaming', () => {
  it('E1: impossible, the instruction box is gone', () => {
    expectUnchanged(sessionIn('streaming'), { type: 'submit', instructions: 'again' });
  });

  it('E2: appends each delta in order and stays streaming', () => {
    const before = sessionIn('streaming');
    const step = run([
      { type: 'delta', seq: before.seq, text: 'Hello' },
      { type: 'delta', seq: before.seq, text: ', world' },
    ], before);

    expect(sessionOf(step)).toMatchObject({ state: 'streaming', result: 'Hello, world' });
    expect(step.effects).toEqual([]);
  });

  it('E3: done keeps the result', () => {
    const before = sessionIn('streaming');
    const step = run([{ type: 'delta', seq: before.seq, text: 'Hi' }, { type: 'done', seq: before.seq }], before);

    expect(sessionOf(step)).toMatchObject({ state: 'done', result: 'Hi' });
    expect(step.effects).toEqual([]);
  });

  it('E4: an error fails the session, empties the result and toasts once', () => {
    const before = sessionIn('streaming');
    const step = run([{ type: 'delta', seq: before.seq, text: 'Hi' }, { type: 'error', seq: before.seq }], before);

    expect(sessionOf(step)).toMatchObject({ state: 'failed', result: '' });
    expect(step.effects).toEqual([{ kind: 'toastFailure' }]);
  });

  it('E5: stop aborts the request and keeps what came so far', () => {
    const before = sessionIn('streaming');
    const step = run([{ type: 'delta', seq: before.seq, text: 'Hi' }, { type: 'stop' }], before);

    expect(sessionOf(step)).toMatchObject({ state: 'stopped', result: 'Hi' });
    expect(step.effects).toEqual([{ kind: 'abort', seq: before.seq }]);
  });

  it('E6 E7 E8: impossible, their buttons are not there', () => {
    const session = sessionIn('streaming');
    expectUnchanged(session, { type: 'retry' });
    expectUnchanged(session, { type: 'insert', writable: true });
    expectUnchanged(session, { type: 'replace', writable: true });
  });

  it('E9 / E11: closes and aborts the request', () => {
    const before = sessionIn('streaming');
    const step = reduceAiSession(before, { type: 'close' });

    expect(sessionOf(step).state).toBe('closed');
    expect(step.effects).toEqual([{ kind: 'abort', seq: before.seq }]);
  });

  it('E10: aborts the request, closes, and opens the new command', () => {
    const before = sessionIn('streaming');
    const step = reduceAiSession(before, { type: 'open', command: EXPAND });
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', command: EXPAND, result: '' });
    expect(session.seq).toBeGreaterThan(before.seq);
    expect(step.effects).toContainEqual({ kind: 'abort', seq: before.seq });
    expect(step.effects).toContainEqual({ kind: 'request', seq: session.seq });
    expect(step.effects).toHaveLength(2);
  });

  it('discards events of an earlier request', () => {
    const before = sessionIn('streaming');
    for (const event of streamEvents(before.seq - 1)) expectUnchanged(before, event);
  });
});

describe.each(['stopped', 'done'] as const)('%s', (state) => {
  it('E1 E5: impossible', () => {
    const session = sessionIn(state);
    expectUnchanged(session, { type: 'submit', instructions: 'again' });
    expectUnchanged(session, { type: 'stop' });
  });

  it('E2 E3 E4 E14: late or impossible stream events are discarded', () => {
    const session = sessionIn(state);
    for (const event of [...streamEvents(session.seq), ...streamEvents(session.seq - 1)]) expectUnchanged(session, event);
  });

  it('E6: retry empties the result and starts a new request', () => {
    const before = sessionIn(state);
    const step = reduceAiSession(before, { type: 'retry' });
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', result: '', command: REFINE });
    expect(session.seq).toBeGreaterThan(before.seq);
    expect(step.effects).toEqual([{ kind: 'request', seq: session.seq }]);
  });

  it('E6: retry of a custom instruction keeps the instruction', () => {
    const before = sessionIn(state, CUSTOM);
    const step = reduceAiSession(before, { type: 'retry' });

    expect(sessionOf(step)).toMatchObject({ state: 'streaming', instructions: 'Make it rhyme', result: '' });
    expect(step.effects).toEqual([{ kind: 'request', seq: sessionOf(step).seq }]);
  });

  it.each(['insert', 'replace'] as const)('E7 / E8 %s: writes the result once and closes', (how) => {
    const step = reduceAiSession(sessionIn(state), { type: how, writable: true });

    expect(sessionOf(step).state).toBe('closed');
    expect(step.effects).toEqual([{ kind: 'write', how, result: 'Hi' }]);
  });

  it.each(['insert', 'replace'] as const)('E13 then %s: says it cannot write and stays', (how) => {
    const before = sessionIn(state);
    const step = reduceAiSession(before, { type: how, writable: false });

    expect(step.session).toEqual(before);
    expect(step.effects).toEqual([{ kind: 'toastNotWritable' }]);
  });

  it('E9 / E11: closes with nothing left to abort', () => {
    const step = reduceAiSession(sessionIn(state), { type: 'close' });

    expect(sessionOf(step).state).toBe('closed');
    expect(step.effects).toEqual([]);
  });

  it('E10: closes and opens the new command with nothing to abort', () => {
    const before = sessionIn(state);
    const step = reduceAiSession(before, { type: 'open', command: EXPAND });
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', command: EXPAND, result: '' });
    expect(step.effects).toEqual([{ kind: 'request', seq: session.seq }]);
  });

});

describe('stopped with nothing received', () => {
  it.each(['insert', 'replace'] as const)('E7 / E8 %s: an empty result writes nothing', (how) => {
    const opened = sessionIn('streaming');
    const stopped = sessionOf(reduceAiSession(opened, { type: 'stop' }));

    expect(stopped).toMatchObject({ state: 'stopped', result: '' });
    expectUnchanged(stopped, { type: how, writable: true });
  });

  it.each(['insert', 'replace'] as const)('E7 / E8 %s: a result of only blanks writes nothing', (how) => {
    const opened = sessionIn('streaming');
    const blank = sessionOf(run([{ type: 'delta', seq: opened.seq, text: ' \n ' }, { type: 'done', seq: opened.seq }], opened));

    expectUnchanged(blank, { type: how, writable: true });
  });
});

describe('failed', () => {
  it('E1 E2 E3 E4 E5 E14: impossible, nothing changes', () => {
    const session = sessionIn('failed');
    expectUnchanged(session, { type: 'submit', instructions: 'again' });
    expectUnchanged(session, { type: 'stop' });
    for (const event of streamEvents(session.seq)) expectUnchanged(session, event);
  });

  it('E6: retry starts a new request', () => {
    const before = sessionIn('failed');
    const step = reduceAiSession(before, { type: 'retry' });
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', result: '' });
    expect(session.seq).toBeGreaterThan(before.seq);
    expect(step.effects).toEqual([{ kind: 'request', seq: session.seq }]);
  });

  it('E7 E8: impossible, their buttons are not there', () => {
    const session = sessionIn('failed');
    expectUnchanged(session, { type: 'insert', writable: true });
    expectUnchanged(session, { type: 'replace', writable: true });
  });

  it('E9 / E11: closes', () => {
    const step = reduceAiSession(sessionIn('failed'), { type: 'close' });

    expect(sessionOf(step).state).toBe('closed');
    expect(step.effects).toEqual([]);
  });

  it('E10: closes and opens the new command', () => {
    const step = reduceAiSession(sessionIn('failed'), { type: 'open', command: EXPAND });

    expect(sessionOf(step)).toMatchObject({ state: 'streaming', command: EXPAND });
    expect(step.effects).toEqual([{ kind: 'request', seq: sessionOf(step).seq }]);
  });

});

describe('closed', () => {
  it('discards late stream events', () => {
    const session = sessionIn('closed');
    for (const event of streamEvents(session.seq)) expectUnchanged(session, event);
  });

  it('E1 E5 E6 E7 E8 E9 E11: nothing happens', () => {
    const session = sessionIn('closed');
    expectUnchanged(session, { type: 'submit', instructions: 'x' });
    expectUnchanged(session, { type: 'stop' });
    expectUnchanged(session, { type: 'retry' });
    expectUnchanged(session, { type: 'insert', writable: true });
    expectUnchanged(session, { type: 'replace', writable: true });
    expectUnchanged(session, { type: 'close' });
  });

  it('E10: opens a new session whose requests are told apart from the old one', () => {
    const before = sessionIn('closed');
    const step = reduceAiSession(before, { type: 'open', command: EXPAND });
    const session = sessionOf(step);

    expect(session).toMatchObject({ state: 'streaming', command: EXPAND, result: '' });
    expect(session.seq).toBeGreaterThan(before.seq);
    expect(step.effects).toEqual([{ kind: 'request', seq: session.seq }]);
    // A delta of the closed session's request does not reach the new one.
    expectUnchanged(session, { type: 'delta', seq: before.seq, text: 'old' });
  });
});

describe('the buttons the dialog shows (§5.3, A5, A7)', () => {
  const all = { resultEmpty: false, revealed: true, replaceable: true, insertBlockPresent: true };

  it.each(['stopped', 'done'] as const)('%s, with the result still being written on screen: stop, no retry, insert or replace', (state) => {
    expect(aiDialogButtons({ state, ...all, revealed: false })).toEqual({ stop: true, retry: false, insert: null, replace: null });
  });

  it('composing: close only', () => {
    expect(aiDialogButtons({ state: 'composing', ...all })).toEqual({ stop: false, retry: false, insert: null, replace: null });
  });

  it('streaming: close and stop', () => {
    expect(aiDialogButtons({ state: 'streaming', ...all })).toEqual({ stop: true, retry: false, insert: null, replace: null });
  });

  it.each(['stopped', 'done'] as const)('%s with a result: close, retry, insert and replace, all usable', (state) => {
    expect(aiDialogButtons({ state, ...all })).toEqual({
      stop: false,
      retry: true,
      insert: { disabled: false, reason: null },
      replace: { disabled: false, reason: null },
    });
  });

  it.each(['stopped', 'done'] as const)('%s with an empty result: close and retry only', (state) => {
    expect(aiDialogButtons({ state, ...all, resultEmpty: true })).toEqual({ stop: false, retry: true, insert: null, replace: null });
  });

  it('failed: close and retry only', () => {
    expect(aiDialogButtons({ state: 'failed', ...all })).toEqual({ stop: false, retry: true, insert: null, replace: null });
  });

  it('closed: nothing', () => {
    expect(aiDialogButtons({ state: 'closed', ...all })).toEqual({ stop: false, retry: false, insert: null, replace: null });
  });

  it('A7: the selected words gone, their block still there: replace disabled, insert usable', () => {
    const buttons = aiDialogButtons({ state: 'done', ...all, replaceable: false });

    expect(buttons.replace).toEqual({ disabled: true, reason: 'rangeGone' });
    expect(buttons.insert).toEqual({ disabled: false, reason: null });
  });

  it('A7: the block gone as well: neither replace nor insert', () => {
    const buttons = aiDialogButtons({ state: 'done', ...all, replaceable: false, insertBlockPresent: false });

    expect(buttons.insert).toEqual({ disabled: true, reason: 'insertBlockGone' });
    expect(buttons.replace?.disabled).toBe(true);
    expect(buttons.replace?.reason).not.toBeNull();
  });

  it('the insert block gone while the words are still there: insert disabled, replace usable', () => {
    const buttons = aiDialogButtons({ state: 'stopped', ...all, insertBlockPresent: false });

    expect(buttons.insert).toEqual({ disabled: true, reason: 'insertBlockGone' });
    expect(buttons.replace).toEqual({ disabled: false, reason: null });
  });

  it('is decided by its five inputs alone, for every combination', () => {
    const states: AiSessionState[] = ['composing', 'streaming', 'stopped', 'done', 'failed', 'closed'];
    fc.assert(
      fc.property(fc.constantFrom(...states), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (state, resultEmpty, revealed, replaceable, insertBlockPresent) => {
        const buttons = aiDialogButtons({ state, resultEmpty, revealed, replaceable, insertBlockPresent });
        const finished = state === 'stopped' || state === 'done';
        expect(buttons.stop).toBe(state === 'streaming' || (finished && !revealed));
        expect(buttons.retry).toBe((finished && revealed) || state === 'failed');
        const writable = finished && !resultEmpty && revealed;
        expect(buttons.insert !== null).toBe(writable);
        expect(buttons.replace !== null).toBe(writable);
        if (writable) {
          expect(buttons.insert!.disabled).toBe(!insertBlockPresent);
          expect(buttons.replace!.disabled).toBe(!replaceable);
        }
      }),
    );
  });
});

/** An event drawn without knowing the session: a stream event names its request relative to the current one. */
type EventTemplate =
  | { readonly kind: 'open'; readonly command: AiCommand }
  | { readonly kind: 'submit'; readonly instructions: string }
  | { readonly kind: 'delta'; readonly offset: number; readonly text: string }
  | { readonly kind: 'done' | 'error'; readonly offset: number }
  | { readonly kind: 'stop' | 'retry' | 'close' }
  | { readonly kind: 'insert' | 'replace'; readonly writable: boolean };

const commands: fc.Arbitrary<AiCommand> = fc.constantFrom<AiCommand>(
  { id: 'refine' },
  { id: 'expand' },
  { id: 'shorten' },
  { id: 'translate', language: 'ja' },
  { id: 'tone', style: 'friendly' },
  { id: 'custom' },
);

const offsets = fc.constantFrom(-1, 0, 0, 0, 1);

const templates: fc.Arbitrary<EventTemplate> = fc.oneof(
  commands.map((command) => ({ kind: 'open' as const, command })),
  fc.constantFrom('', ' ', 'Rhyme').map((instructions) => ({ kind: 'submit' as const, instructions })),
  fc.tuple(offsets, fc.constantFrom('a', ' ', 'bc')).map(([offset, text]) => ({ kind: 'delta' as const, offset, text })),
  fc.tuple(fc.constantFrom('done' as const, 'error' as const), offsets).map(([kind, offset]) => ({ kind, offset })),
  fc.constantFrom('stop' as const, 'retry' as const, 'close' as const).map((kind) => ({ kind })),
  fc.tuple(fc.constantFrom('insert' as const, 'replace' as const), fc.boolean()).map(([kind, writable]) => ({ kind, writable })),
);

/**
 * Resolves a template against the session it is about to reach.
 * @param template - The template.
 * @param session - The current session, or null.
 * @returns The event.
 */
function eventFor(template: EventTemplate, session: AiSession | null): AiSessionEvent {
  const seq = (session?.seq ?? 0) + ('offset' in template ? template.offset : 0);
  switch (template.kind) {
    case 'open': return { type: 'open', command: template.command };
    case 'submit': return { type: 'submit', instructions: template.instructions };
    case 'delta': return { type: 'delta', seq, text: template.text };
    case 'done': case 'error': return { type: template.kind, seq };
    case 'stop': case 'retry': case 'close': return { type: template.kind };
    case 'insert': case 'replace': return { type: template.kind, writable: template.writable };
  }
}

describe('the invariants of §6.2, over any sequence of events', () => {
  it('hold after every step', () => {
    fc.assert(
      fc.property(commands, fc.array(templates, { maxLength: 40 }), (first, rest) => {
        let session: AiSession | null = null;
        // Requests started and not yet aborted or finished.
        const inFlight = new Set<number>();
        let lastRequest = 0;
        // What the current request has streamed, from the events the reducer took.
        let streamed = '';
        for (const template of [{ kind: 'open', command: first } as EventTemplate, ...rest]) {
          const event = eventFor(template, session);
          const before: AiSession | null = session;
          const step = reduceAiSession(before, event);
          const effects: readonly AiEffect[] = step.effects;
          session = step.session;

          // Every session reached is a real one once a session was opened.
          expect(session).not.toBeNull();
          const now = session!;

          for (const effect of effects) {
            if (effect.kind === 'request') {
              // A request's number is new: an event of an earlier one can never match it.
              expect(effect.seq).toBeGreaterThan(lastRequest);
              lastRequest = effect.seq;
              inFlight.add(effect.seq);
              streamed = '';
            }
            if (effect.kind === 'abort') {
              expect(inFlight.has(effect.seq)).toBe(true);
              inFlight.delete(effect.seq);
            }
            if (effect.kind === 'write') {
              // The body is written only by a press on insert or replace, with a result that holds something.
              expect(event.type === 'insert' || event.type === 'replace').toBe(true);
              expect(effect.how).toBe(event.type);
              expect(effect.result.trim()).not.toBe('');
              expect(before?.result).toBe(effect.result);
              expect(now.state).toBe('closed');
            }
          }

          const finishes = event.type === 'done' || event.type === 'error';
          if (finishes && before?.state === 'streaming' && event.seq === before.seq) inFlight.delete(event.seq);
          if (event.type === 'delta' && before?.state === 'streaming' && event.seq === before.seq) streamed += event.text;

          // At most one request in flight, and it is the streaming session's own.
          expect(inFlight.size).toBeLessThanOrEqual(1);
          if (now.state === 'streaming') {
            expect([...inFlight]).toEqual([now.seq]);
            expect(now.result).toBe(streamed);
          } else {
            expect(inFlight.size).toBe(0);
          }

          // An event of any request but the current one changes nothing.
          if ('seq' in event && before !== null && event.seq !== before.seq) {
            expect(now).toEqual(before);
            expect(effects).toEqual([]);
          }

          // A failure always toasts, exactly once, and only on the way into failed.
          const toasts = effects.filter((effect) => effect.kind === 'toastFailure').length;
          const intoFailed = now.state === 'failed' && before?.state !== 'failed';
          expect(toasts).toBe(intoFailed ? 1 : 0);
          if (intoFailed) expect(event.type).toBe('error');
          if (now.state === 'failed') expect(now.result).toBe('');
        }
      }),
      { numRuns: 300 },
    );
  });
});
