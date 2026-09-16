// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { STORAGE_KEYS } from '@web/lib/storage-keys';
import {
  readProjectTabs,
  readSpaceViewport,
  writeOpenTabs,
  writeSpaceViewport,
} from '@web/lib/project-tabs-storage';

/**
 * The record is addressed account first, then project, then Space — the same
 * order the product nests them (user 2026-09-16). Every assertion below is
 * about one of the two boundaries that ordering buys: one account cannot read
 * another's slot, and one project's slot cannot be written by a call naming a
 * different one.
 */

const KEY = STORAGE_KEYS.projectTabs;
const ALICE = 'user-alice';
const BOB = 'user-bob';
const P1 = 'project-one';
const P2 = 'project-two';

/** What the browser is holding right now, parsed. */
function raw(): unknown {
  const value = window.localStorage.getItem(KEY);
  return value === null ? null : JSON.parse(value);
}

/** Put a record in place without going through the writers. */
function seed(value: unknown): void {
  window.localStorage.setItem(KEY, JSON.stringify(value));
}

/** One account's slot for one project, as the writers build it. */
function slot(
  tabs: Array<{ spaceId: string; viewport: unknown }>,
  activeId: string | null,
): unknown {
  return { tabs, activeId };
}

describe('project tab storage — the account boundary', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('answers with nothing for an account that has never opened this project', () => {
    writeOpenTabs(ALICE, P1, ['s1', 's2'], 's2');
    expect(readProjectTabs(BOB, P1)).toBeNull();
  });

  it('leaves one account untouched when another writes the same project', () => {
    writeOpenTabs(ALICE, P1, ['s1', 's2'], 's2');
    writeOpenTabs(BOB, P1, ['s3'], 's3');
    expect(readProjectTabs(ALICE, P1)).toEqual({
      openIds: ['s1', 's2'],
      activeId: 's2',
    });
    expect(readProjectTabs(BOB, P1)).toEqual({ openIds: ['s3'], activeId: 's3' });
  });

  it('reads and writes nothing at all without an account', () => {
    seed({ [ALICE]: { [P1]: slot([{ spaceId: 's1', viewport: null }], 's1') } });
    const before = raw();
    expect(readProjectTabs(undefined, P1)).toBeNull();
    expect(readSpaceViewport(undefined, P1, 's1')).toBeNull();
    writeOpenTabs(undefined, P1, ['s9'], 's9');
    writeSpaceViewport(undefined, P1, 's1', { x: 1, y: 2, zoom: 3 });
    expect(raw()).toEqual(before);
  });
});

describe('project tab storage — the open list', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('gives the list back in the order it was written', () => {
    writeOpenTabs(ALICE, P1, ['s3', 's1', 's2'], 's1');
    expect(readProjectTabs(ALICE, P1)).toEqual({
      openIds: ['s3', 's1', 's2'],
      activeId: 's1',
    });
  });

  it('keeps an empty list as an empty list', () => {
    writeOpenTabs(ALICE, P1, [], null);
    expect(readProjectTabs(ALICE, P1)).toEqual({ openIds: [], activeId: null });
  });

  it('leaves another project alone', () => {
    writeOpenTabs(ALICE, P1, ['s1'], 's1');
    writeOpenTabs(ALICE, P2, ['s2'], 's2');
    expect(readProjectTabs(ALICE, P1)).toEqual({ openIds: ['s1'], activeId: 's1' });
    expect(readProjectTabs(ALICE, P2)).toEqual({ openIds: ['s2'], activeId: 's2' });
  });
});

describe('project tab storage — a tab carries its camera', () => {
  beforeEach(() => {
    window.localStorage.clear();
    writeOpenTabs(ALICE, P1, ['s1', 's2'], 's1');
  });

  it('gives back the camera that was written for that Space', () => {
    writeSpaceViewport(ALICE, P1, 's1', { x: 10, y: -20, zoom: 0.5 });
    expect(readSpaceViewport(ALICE, P1, 's1')).toEqual({
      x: 10,
      y: -20,
      zoom: 0.5,
    });
  });

  it('answers with nothing for a Space whose camera was never written', () => {
    expect(readSpaceViewport(ALICE, P1, 's2')).toBeNull();
  });

  it('changes one tab and leaves its neighbour alone', () => {
    writeSpaceViewport(ALICE, P1, 's1', { x: 1, y: 1, zoom: 1 });
    writeSpaceViewport(ALICE, P1, 's2', { x: 2, y: 2, zoom: 2 });
    writeSpaceViewport(ALICE, P1, 's1', { x: 9, y: 9, zoom: 4 });
    expect(readSpaceViewport(ALICE, P1, 's2')).toEqual({ x: 2, y: 2, zoom: 2 });
    expect(readSpaceViewport(ALICE, P1, 's1')).toEqual({ x: 9, y: 9, zoom: 4 });
  });

  it('does not reach storage at all for a Space that is not an open tab', () => {
    // Closing a tab takes this path: the list is written without it, and only
    // then does the canvas unmount and offer its camera. Asserting on the
    // stored value alone would pass either way — rewriting the same tabs is a
    // no-op — so this watches the write itself.
    const before = raw();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    writeSpaceViewport(ALICE, P1, 'not-open', { x: 1, y: 1, zoom: 1 });
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    expect(raw()).toEqual(before);
    expect(readSpaceViewport(ALICE, P1, 'not-open')).toBeNull();
  });

  it('carries a surviving tab’s camera through a list rewrite', () => {
    writeSpaceViewport(ALICE, P1, 's2', { x: 7, y: 7, zoom: 2 });
    writeOpenTabs(ALICE, P1, ['s2', 's1'], 's2');
    expect(readSpaceViewport(ALICE, P1, 's2')).toEqual({ x: 7, y: 7, zoom: 2 });
  });

  it('drops the camera of a tab that left the list', () => {
    writeSpaceViewport(ALICE, P1, 's1', { x: 7, y: 7, zoom: 2 });
    writeOpenTabs(ALICE, P1, ['s2'], 's2');
    writeOpenTabs(ALICE, P1, ['s2', 's1'], 's1');
    expect(readSpaceViewport(ALICE, P1, 's1')).toBeNull();
  });
});

describe('project tab storage — data it will not trust', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('treats a slot with a broken camera as absent', () => {
    seed({
      [ALICE]: {
        [P1]: slot([{ spaceId: 's1', viewport: { x: 0, y: 0, zoom: NaN } }], 's1'),
      },
    });
    expect(readProjectTabs(ALICE, P1)).toBeNull();
  });

  it('treats a zoom outside the canvas range as absent', () => {
    seed({
      [ALICE]: {
        [P1]: slot([{ spaceId: 's1', viewport: { x: 0, y: 0, zoom: 99 } }], 's1'),
      },
    });
    expect(readProjectTabs(ALICE, P1)).toBeNull();
  });

  it('treats a slot missing its fields as absent', () => {
    seed({ [ALICE]: { [P1]: { tabs: [{ spaceId: '' }] } } });
    expect(readProjectTabs(ALICE, P1)).toBeNull();
  });

  it('keeps the other slots readable when one is broken', () => {
    seed({
      [ALICE]: {
        [P1]: { nonsense: true },
        [P2]: slot([{ spaceId: 's5', viewport: null }], 's5'),
      },
      [BOB]: { [P1]: slot([{ spaceId: 's6', viewport: null }], 's6') },
    });
    expect(readProjectTabs(ALICE, P1)).toBeNull();
    expect(readProjectTabs(ALICE, P2)).toEqual({ openIds: ['s5'], activeId: 's5' });
    expect(readProjectTabs(BOB, P1)).toEqual({ openIds: ['s6'], activeId: 's6' });
  });

  it('leaves the other slots in place when a broken one is written over', () => {
    seed({
      [ALICE]: {
        [P1]: { nonsense: true },
        [P2]: slot([{ spaceId: 's5', viewport: null }], 's5'),
      },
    });
    writeOpenTabs(ALICE, P1, ['s1'], 's1');
    expect(readProjectTabs(ALICE, P2)).toEqual({ openIds: ['s5'], activeId: 's5' });
  });

  it('treats a value that is not JSON as nothing stored', () => {
    window.localStorage.setItem(KEY, 'not json at all');
    expect(readProjectTabs(ALICE, P1)).toBeNull();
    writeOpenTabs(ALICE, P1, ['s1'], 's1');
    expect(readProjectTabs(ALICE, P1)).toEqual({ openIds: ['s1'], activeId: 's1' });
  });

  // An account entry is where a hand-edit lands most easily, and it is read
  // during the project page's first render: anything thrown here replaces the
  // whole page with an error screen the reader cannot get out of, since a
  // reload meets the same record.
  it.each([
    ['null', null],
    ['a string', 'nonsense'],
    ['a number', 7],
    ['an array', []],
  ])('treats an account entry that is %s as nothing stored', (_name, entry) => {
    seed({ [ALICE]: entry });
    expect(() => readProjectTabs(ALICE, P1)).not.toThrow();
    expect(readProjectTabs(ALICE, P1)).toBeNull();
    expect(() => readSpaceViewport(ALICE, P1, 's1')).not.toThrow();
    expect(readSpaceViewport(ALICE, P1, 's1')).toBeNull();
    expect(() => writeOpenTabs(ALICE, P1, ['s1'], 's1')).not.toThrow();
    expect(readProjectTabs(ALICE, P1)).toEqual({ openIds: ['s1'], activeId: 's1' });
  });
});

describe('project tab storage — a browser that refuses to store', () => {
  const getItem = Storage.prototype.getItem;
  const setItem = Storage.prototype.setItem;

  afterEach(() => {
    Storage.prototype.getItem = getItem;
    Storage.prototype.setItem = setItem;
  });

  it('answers with nothing when reading throws', () => {
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error('storage is disabled');
    });
    expect(readProjectTabs(ALICE, P1)).toBeNull();
    expect(readSpaceViewport(ALICE, P1, 's1')).toBeNull();
  });

  it('stays quiet when writing throws', () => {
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('quota exceeded');
    });
    expect(() => writeOpenTabs(ALICE, P1, ['s1'], 's1')).not.toThrow();
    expect(() =>
      writeSpaceViewport(ALICE, P1, 's1', { x: 0, y: 0, zoom: 1 }),
    ).not.toThrow();
  });
});
