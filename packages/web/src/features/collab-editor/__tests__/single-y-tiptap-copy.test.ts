// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The bundle must contain exactly one copy of `@tiptap/y-tiptap`.
 *
 * Several things we rely on compare y-prosemirror's plugin keys by IDENTITY,
 * and those keys are module-level objects. The undo manager is the sharpest
 * case: it tracks which transactions to capture with
 * `trackedOrigins: new Set([ySyncPluginKey])`, and Yjs decides membership with
 * `Set.has`. Two copies in the bundle means the key we imported is not the
 * object the active sync plugin dispatches with, `has` is always false, and the
 * undo stack captures nothing — `Mod-z` and `Mod-Shift-z` do nothing at all,
 * with no error thrown and no test failing.
 *
 * The name-based lookups in `collab-plugin-keys` do not save us here, and say
 * so themselves: a duplicate copy makes pnpm mint the second key as `y-sync$1`,
 * so a lookup for `y-sync$` misses just as silently.
 *
 * Which makes single-copy an invariant rather than a happy accident, and this
 * is where it is enforced. It can break without anyone touching this code: the
 * catalog pins our direct dependency, but both collaboration extensions resolve
 * y-tiptap on their own, and an upgrade to any of the three can drift them
 * apart.
 *
 * BOTH extensions are checked, not just one. They register different plugins —
 * `extension-collaboration` the sync and undo plugins, `extension-collaboration-caret`
 * the cursor plugin — and each has its own dependency range on y-tiptap
 * (`^3.0.7` in both, today). A guard that checks one proves nothing about the
 * other: the caret path would break exactly as silently, with remote carets
 * simply never drawn.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

/** Where a given package resolves `@tiptap/y-tiptap` from. */
function yTiptapSeenBy(pkg: string): string {
  return createRequire(dirname(require.resolve(pkg))).resolve(
    '@tiptap/y-tiptap',
  );
}

describe('@tiptap/y-tiptap', () => {
  it('resolves to one copy for us and for both collaboration extensions', () => {
    const ours = require.resolve('@tiptap/y-tiptap');

    // Compared as paths so a failure names the versions rather than just
    // saying two objects differ.
    expect(yTiptapSeenBy('@tiptap/extension-collaboration')).toBe(ours);
    expect(yTiptapSeenBy('@tiptap/extension-collaboration-caret')).toBe(ours);
  });
});
