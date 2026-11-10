// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The dialogue side of a model whose speakers stand in for its voice, and the
 * script it sends: one line per turn, the speaker picked, never typed
 * (inner#1825 design 8.5).
 */

import { describe, expect, it } from 'vitest';

import {
  STAND_IN_ON,
  dialogueSideOf,
  dialogueText,
  isStandInOn,
  speakersShort,
  standInOf,
  withStandInOn,
} from '@shared/canvas/dialogue.js';
import * as entry from '@shared/index.js';

const GEMINI = {
  name: 'gemini',
  params: {
    language: { values: ['English (United States)'] },
    speakers: {
      type: 'items',
      min_items: 2,
      max_items: 2,
      replaces: 'voice_id',
      fields: { speaker: { type: 'text' }, voice: { values: ['Kore', 'Puck'] } },
    },
    voice_id: { default: 'Kore' },
  },
};

const PLAIN = { name: 'plain', params: { voice_id: { default: null } } };

const PAIR = [
  { speaker: 'Ava', voice: 'Kore' },
  { speaker: 'Leo', voice: 'Puck' },
];
const HALF = [
  { speaker: 'Ava', voice: 'Kore' },
  { speaker: '', voice: 'Puck' },
];

describe('the shared entry', () => {
  it('exports the dialogue helpers from the package index', () => {
    for (const name of ['STAND_IN_ON', 'standInOf', 'isStandInOn', 'withStandInOn', 'speakersShort', 'dialogueSideOf', 'dialogueText']) {
      expect(entry, name).toHaveProperty(name);
    }
  });
});

describe('standInOf', () => {
  it('names the param that stands in for another, with its floor', () => {
    expect(standInOf(GEMINI)).toMatchObject({ name: 'speakers', replaces: 'voice_id', min: 2 });
  });

  it('answers null for a model with none, or no model', () => {
    expect(standInOf(PLAIN)).toBeNull();
    expect(standInOf(undefined)).toBeNull();
  });
});

describe('isStandInOn', () => {
  it('is true only for an explicit true', () => {
    expect(isStandInOn({ [STAND_IN_ON]: true })).toBe(true);
    expect(isStandInOn({ [STAND_IN_ON]: 'true' })).toBe(false);
    expect(isStandInOn({})).toBe(false);
  });
});

describe('speakersShort', () => {
  it('counts only complete speakers against the floor, and only in a dialogue', () => {
    expect(speakersShort(GEMINI, { speakers: HALF, [STAND_IN_ON]: true })).toBe(true);
    expect(speakersShort(GEMINI, { speakers: PAIR, [STAND_IN_ON]: true })).toBe(false);
    expect(speakersShort(GEMINI, { speakers: HALF })).toBe(false);
    expect(speakersShort(PLAIN, { [STAND_IN_ON]: true })).toBe(false);
  });
});

describe('withStandInOn', () => {
  it('switches a record holding complete speakers and no switch to the dialogue side', () => {
    expect(withStandInOn(GEMINI, { speakers: PAIR })).toEqual({ speakers: PAIR, [STAND_IN_ON]: true });
  });

  it('leaves a record whose speakers are missing, empty or incomplete as it was', () => {
    const none = [{ speaker: '', voice: 'Kore' }, { speaker: 'Leo', voice: 'Nobody' }];
    for (const speakers of [null, [], none]) {
      expect(withStandInOn(GEMINI, { voice_id: 'Kore', speakers })).toEqual({ voice_id: 'Kore', speakers });
    }
  });

  it('keeps a switch the record already holds, and leaves a model without a stand-in as it was', () => {
    expect(withStandInOn(GEMINI, { speakers: PAIR, [STAND_IN_ON]: false })).toEqual({ speakers: PAIR, [STAND_IN_ON]: false });
    expect(withStandInOn(PLAIN, { speakers: PAIR })).toEqual({ speakers: PAIR });
    expect(withStandInOn(undefined, { speakers: PAIR })).toEqual({ speakers: PAIR });
  });
});

describe('dialogueSideOf', () => {
  it('is on with the switch on, whatever the speakers', () => {
    expect(dialogueSideOf(GEMINI, { [STAND_IN_ON]: true })).toBe(true);
    expect(dialogueSideOf(GEMINI, { speakers: HALF, [STAND_IN_ON]: true })).toBe(true);
  });

  it('is off with the switch off, whatever the speakers', () => {
    expect(dialogueSideOf(GEMINI, { speakers: PAIR, [STAND_IN_ON]: false })).toBe(false);
  });

  it('with no switch, is on once at least one speaker is complete, as a landing writer switches it', () => {
    expect(dialogueSideOf(GEMINI, { speakers: PAIR })).toBe(true);
    expect(dialogueSideOf(GEMINI, { speakers: HALF })).toBe(true);
    expect(dialogueSideOf(GEMINI, { speakers: [{ speaker: '', voice: 'Kore' }] })).toBe(false);
    expect(dialogueSideOf(GEMINI, {})).toBe(false);
  });

  it('is off on a model without a stand-in, or no model', () => {
    expect(dialogueSideOf(PLAIN, { speakers: PAIR, [STAND_IN_ON]: true })).toBe(false);
    expect(dialogueSideOf(undefined, { [STAND_IN_ON]: true })).toBe(false);
  });

  it('agrees with withStandInOn on every record a writer could bring', () => {
    for (const speakers of [undefined, null, [], HALF, PAIR, [{ speaker: '', voice: 'Kore' }]]) {
      const record = speakers === undefined ? {} : { speakers };
      expect(dialogueSideOf(GEMINI, record), JSON.stringify(record)).toBe(isStandInOn(withStandInOn(GEMINI, record)));
    }
  });
});

describe('dialogueText', () => {
  const SPEAKERS = [{ speaker: 'Ava' }, { speaker: 'Leo' }];

  it('writes each line after its speaker\'s name and a half-width colon, a line apart', () => {
    expect(dialogueText([{ speaker: 1, text: 'Hi.' }, { speaker: 2, text: 'Hello.' }], SPEAKERS)).toBe('Ava: Hi.\nLeo: Hello.');
  });

  it('numbers speakers from 1 and trims the name', () => {
    expect(dialogueText([{ speaker: 2, text: 'x' }], [{ speaker: ' Ava ' }, { speaker: '  Leo' }])).toBe('Leo: x');
  });

  it('skips a line that is empty or only spaces', () => {
    expect(dialogueText([{ speaker: 1, text: 'a' }, { speaker: 2, text: '   ' }, { speaker: 2, text: '' }, { speaker: 2, text: 'b' }], SPEAKERS)).toBe(
      'Ava: a\nLeo: b',
    );
    expect(dialogueText([{ speaker: 1, text: ' ' }], SPEAKERS)).toBe('');
    expect(dialogueText([], SPEAKERS)).toBe('');
  });

  it('folds a line break inside a line into one space', () => {
    expect(dialogueText([{ speaker: 1, text: 'one\ntwo' }], SPEAKERS)).toBe('Ava: one two');
  });

  it('gives a line with no speaker, or one past the speakers, the previous line\'s, and the first such speaker 1', () => {
    expect(
      dialogueText(
        [
          { text: 'first' },
          { speaker: 2, text: 'second' },
          { speaker: null, text: 'third' },
          { speaker: 7, text: 'fourth' },
          { speaker: 0, text: 'fifth' },
        ],
        SPEAKERS,
      ),
    ).toBe('Ava: first\nLeo: second\nLeo: third\nLeo: fourth\nLeo: fifth');
  });
});
