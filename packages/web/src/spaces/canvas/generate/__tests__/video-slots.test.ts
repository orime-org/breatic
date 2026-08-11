// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every message the slot registry names is one the catalogs answer.
 *
 * `i18n-no-missing-keys` only sees a key spelled out as the whole argument of
 * a `t(...)` call — its own docstring says so, and names the lookup tables it
 * therefore cannot reach. Collecting the slot's four messages into
 * {@link VIDEO_SLOTS} (#1904) turned three keys that had been literal `t(...)`
 * arguments in the toolbar into table data, which is outside what that check
 * can read. A typo there is silent: the runtime has no message to look up and
 * puts the key itself on screen, so the user reads
 * `canvas.generatePanel.endFrmae`.
 *
 * A test rather than widening the guard. What the guard would have to do is
 * resolve a key back through a variable, and the cheap approximation —
 * sweeping every dotted string literal in a file — reports file paths and
 * property chains as missing messages, which is why that check deliberately
 * does not do it. This suite knows exactly which strings in this one table are
 * message keys, so it can be exact where a repo-wide sweep cannot.
 *
 * All five catalogs, not just the English source: these keys are ours and were
 * added to all five, so a locale missing one is a bug in this feature rather
 * than a translation still in flight.
 */

import { describe, it, expect } from 'vitest';

import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlot } from '@web/spaces/canvas/generate/video-slots';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/**
 * The message keys one slot names.
 *
 * Selected by SHAPE (a string under the `canvas.` namespace) rather than by a
 * hand-listed set of field names: a fifth message added to a slot is then
 * covered the day it is written, which is the whole reason this suite exists.
 * @param slot - The slot to read.
 * @returns Its message keys, in declaration order.
 */
function messageKeys(slot: VideoSlot): string[] {
  // Widened before filtering: the registry is `as const`, so its values are a
  // union of literals and a component type, and a `value is string` predicate
  // is not assignable to that union.
  const values: unknown[] = Object.values(VIDEO_SLOTS[slot]);
  return values.filter(
    (value): value is string =>
      typeof value === 'string' && value.startsWith('canvas.'),
  );
}

describe('the slot registry names only messages the catalogs answer', () => {
  const slots = Object.keys(VIDEO_SLOTS) as VideoSlot[];

  it.each(slots)('%s resolves in every locale', (slot) => {
    const keys = messageKeys(slot);
    // Guards the sweep itself: a shape-based filter that matches nothing
    // would make every assertion below vacuous and this suite would pass
    // while checking not one key.
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const [tag, catalog] of LOCALE_CATALOGS) {
      for (const key of keys) {
        expect(
          typeof readPath(catalog, key),
          `${tag} has no message at ${key}`,
        ).toBe('string');
      }
    }
  });
});
