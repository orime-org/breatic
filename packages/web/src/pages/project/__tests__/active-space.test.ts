// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  resolveEffectiveActiveSpace,
  reviseTabChoice,
} from '@web/pages/project/active-space';
import type { ProjectSpace } from '@web/data/yjs/project-meta';

const s = (id: string): ProjectSpace => ({ id, name: id, type: 'canvas' });

// The active tab is LOCAL state (batch-2 item 2): opening a project starts
// with no local choice, so the effective active is the FIRST open tab; a
// local choice wins while its tab is still open, and a stale choice (tab
// closed remotely / space vanished) falls back to the first open tab.
describe('resolveEffectiveActiveSpace', () => {
  const openTabs = [s('a'), s('b'), s('c')];

  it('defaults to the first open tab when there is no local choice (project open)', () => {
    expect(resolveEffectiveActiveSpace(openTabs, null)?.id).toBe('a');
  });

  it('honors the local choice while its tab is open', () => {
    expect(resolveEffectiveActiveSpace(openTabs, 'b')?.id).toBe('b');
  });

  it('falls back to the first open tab when the local choice is stale', () => {
    expect(resolveEffectiveActiveSpace(openTabs, 'gone')?.id).toBe('a');
  });

  it('returns undefined when no tabs are open (empty state)', () => {
    expect(resolveEffectiveActiveSpace([], 'b')).toBeUndefined();
  });
});

// The invariant: the choice either names a tab on the strip, or names one a
// `tab:open` is still travelling for. Anything else leaves the page falling
// back by POSITION, and a reorder then swaps the body out from under the user.
describe('reviseTabChoice', () => {
  const openTabIds = ['a', 'b', 'c'];

  it('takes the first tab when no choice has been made', () => {
    expect(
      reviseTabChoice({
        openTabIds,
        activeSpaceId: null,
        shownId: 'a',
        openingTab: null,
      }),
    ).toEqual({ activeSpaceId: 'a' });
  });

  it('has nothing to say when no choice has been made and no tabs are open', () => {
    expect(
      reviseTabChoice({
        openTabIds: [],
        activeSpaceId: null,
        shownId: undefined,
        openingTab: null,
      }),
    ).toEqual({});
  });

  it('leaves a choice whose tab is on the strip alone', () => {
    expect(
      reviseTabChoice({
        openTabIds,
        activeSpaceId: 'b',
        shownId: 'b',
        openingTab: null,
      }),
    ).toEqual({});
  });

  it('releases the pending open once its tab arrives', () => {
    expect(
      reviseTabChoice({
        openTabIds,
        activeSpaceId: 'c',
        shownId: 'c',
        openingTab: 'c',
      }),
    ).toEqual({ clearOpening: true });
  });

  it('waits while the tab for this choice is still travelling', () => {
    expect(
      reviseTabChoice({
        openTabIds,
        activeSpaceId: 'd',
        shownId: 'a',
        openingTab: 'd',
      }),
    ).toEqual({});
  });

  it('settles on what the page shows once the tab is gone', () => {
    expect(
      reviseTabChoice({
        openTabIds,
        activeSpaceId: 'gone',
        shownId: 'a',
        openingTab: null,
      }),
    ).toEqual({ activeSpaceId: 'a' });
  });

  it('settles a stale choice even while another Space is travelling', () => {
    // The guard compares the pending open against the choice itself, so an
    // open travelling for some other Space holds nothing back.
    expect(
      reviseTabChoice({
        openTabIds,
        activeSpaceId: 'gone',
        shownId: 'a',
        openingTab: 'd',
      }),
    ).toEqual({ activeSpaceId: 'a' });
  });

  it('has nothing to settle on when the strip is empty', () => {
    expect(
      reviseTabChoice({
        openTabIds: [],
        activeSpaceId: 'gone',
        shownId: undefined,
        openingTab: null,
      }),
    ).toEqual({});
  });
});
