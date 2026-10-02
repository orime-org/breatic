// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { fixedEntries } from '@web/spaces/canvas/generate/fixed-entries';
import type { ItemFieldControl } from '@web/spaces/canvas/generate/model-controls';

const FIELDS: ItemFieldControl[] = [
  { kind: 'text', name: 'speaker' },
  { kind: 'choice', name: 'voice', options: [{ value: 'Kore', label: 'Kore' }, { value: 'Puck', label: 'Puck' }] },
];

describe('fixedEntries (#2256)', () => {
  it('fills a list short of its size with a blank name and the first option', () => {
    expect(fixedEntries([{ speaker: 'Ana', voice: 'Puck' }], 2, FIELDS)).toEqual([
      { speaker: 'Ana', voice: 'Puck' },
      { speaker: '', voice: 'Kore' },
    ]);
  });

  it('reads anything that is not a list of entries as empty', () => {
    expect(fixedEntries(null, 2, FIELDS)).toEqual([
      { speaker: '', voice: 'Kore' },
      { speaker: '', voice: 'Kore' },
    ]);
    expect(fixedEntries(['x', [1], { speaker: 'Ana', voice: 'Kore' }], 1, FIELDS)).toEqual([{ speaker: 'Ana', voice: 'Kore' }]);
  });

  it('cuts a longer list to its size', () => {
    const three = [{ speaker: 'a' }, { speaker: 'b' }, { speaker: 'c' }];
    expect(fixedEntries(three, 2, FIELDS)).toEqual([{ speaker: 'a' }, { speaker: 'b' }]);
  });
});
