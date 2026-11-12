// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Who says each line of a dialogue, and the typed name prefix a line drops
 * (inner#1825 design 8.5): old nodes written as `Name: line`, a pasted
 * script and a remote write all come out one speaker per line.
 */

import { describe, expect, it } from 'vitest';

import { planDialogueLines } from '@web/spaces/canvas/generate/dialogue-lines';

const NAMES = ['Ava', 'Leo'];

describe('planDialogueLines', () => {
  it('takes the speaker from a name and a half-width or full-width colon at the start, and strips the prefix', () => {
    expect(planDialogueLines([{ text: 'Ava: hi' }, { text: 'Leo：hello' }, { text: 'Leo  :  yes' }], NAMES)).toEqual([
      { speaker: 1, strip: 5 },
      { speaker: 2, strip: 4 },
      { speaker: 2, strip: 8 },
    ]);
  });

  it('reads the prefix even on a line that already has a speaker', () => {
    expect(planDialogueLines([{ speaker: 1, text: 'Leo: hello' }], NAMES)).toEqual([{ speaker: 2, strip: 5 }]);
  });

  it('keeps a line\'s own speaker when it has no prefix', () => {
    expect(planDialogueLines([{ speaker: 2, text: 'hello' }], NAMES)).toEqual([{ speaker: 2, strip: 0 }]);
  });

  it('gives a line with no speaker the previous line\'s, and the first such speaker 1', () => {
    expect(planDialogueLines([{ text: 'x' }, { speaker: 2, text: 'y' }, { speaker: null, text: 'z' }], NAMES)).toEqual([
      { speaker: 1, strip: 0 },
      { speaker: 2, strip: 0 },
      { speaker: 2, strip: 0 },
    ]);
  });

  it('treats a speaker past the configured ones as none', () => {
    expect(planDialogueLines([{ speaker: 2, text: 'a' }, { speaker: 5, text: 'b' }, { speaker: 0, text: 'c' }], NAMES)).toEqual([
      { speaker: 2, strip: 0 },
      { speaker: 2, strip: 0 },
      { speaker: 2, strip: 0 },
    ]);
  });

  it('leaves a word that is not a configured name, or a name with no colon, as words', () => {
    expect(planDialogueLines([{ speaker: 1, text: 'Note: later' }, { speaker: 1, text: 'Leo said hi' }], NAMES)).toEqual([
      { speaker: 1, strip: 0 },
      { speaker: 1, strip: 0 },
    ]);
  });

  it('matches a whole name, not the start of a longer word', () => {
    expect(planDialogueLines([{ speaker: 1, text: 'Leon: hi' }], NAMES)).toEqual([{ speaker: 1, strip: 0 }]);
  });

  it('is idempotent on its own output', () => {
    const lines = [{ text: 'Ava：x' }, { text: 'y' }, { speaker: 1, text: 'Leo: z' }];
    const once = planDialogueLines(lines, NAMES);
    const applied = lines.map((line, at) => ({ speaker: once[at]?.speaker, text: line.text.slice(once[at]?.strip ?? 0) }));
    expect(planDialogueLines(applied, NAMES).every((plan, at) => plan.speaker === once[at]?.speaker && plan.strip === 0)).toBe(true);
  });
});
