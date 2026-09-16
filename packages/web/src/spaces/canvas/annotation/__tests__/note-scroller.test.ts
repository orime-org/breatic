// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The sticky's scrollers all come from one component.
 *
 * "Every scroller on a sticky needs `nowheel`" was five call sites that had to
 * be kept in step, and the new-note box was the one that missed: measured on a
 * board, a wheel over a draft past the cap left its `scrollTop` where it was
 * and panned the canvas instead. A rule held by remembering how many places
 * there are today goes wrong the next time a place is added, so the rule lives
 * inside `NoteScroller` and this says the feature goes through it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

const FEATURE = resolve(__dirname, '..');
const STICKY = resolve(__dirname, '../../nodes/AnnotationNode.tsx');

/**
 * Every source file the sticky is drawn from, paired with its text.
 * @returns The path and contents of each, excluding tests and the scroller.
 */
function stickySources(): { path: string; text: string }[] {
  const own = readdirSync(FEATURE)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .filter((name) => name !== 'NoteScroller.tsx')
    .map((name) => resolve(FEATURE, name));
  return [...own, STICKY].map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }));
}

describe('a sticky scrolls through one component', () => {
  it('reads more than one file, so an empty list cannot pass it', () => {
    expect(stickySources().length).toBeGreaterThan(3);
  });

  it('leaves the primitive to NoteScroller', () => {
    const direct = stickySources()
      .filter(({ text }) =>
        text.includes('from \'@web/components/ui/scroll-area\''),
      )
      .map(({ path }) => path);
    expect(direct).toEqual([]);
  });

  it('keeps the wheel claim in the one place that renders the primitive', () => {
    const scroller = readFileSync(resolve(FEATURE, 'NoteScroller.tsx'), 'utf8');
    expect(scroller).toContain('nowheel');
  });
});
