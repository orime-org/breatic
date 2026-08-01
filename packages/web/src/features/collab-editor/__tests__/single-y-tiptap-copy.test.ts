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
 * undo stack captures nothing — Cmd+Z and both toolbar buttons do nothing at
 * all, with no error thrown and no test failing.
 *
 * The name-based lookups in `collab-plugin-keys` do not save us here, and say
 * so themselves: a duplicate copy makes pnpm mint the second key as `y-sync$1`,
 * so a lookup for `y-sync$` misses just as silently.
 *
 * Which makes single-copy an invariant rather than a happy accident, and this
 * is where it is enforced. It can break without anyone touching this code: the
 * catalog pins our direct dependency, but `@tiptap/extension-collaboration`
 * resolves y-tiptap on its own, and an upgrade to either can drift them apart.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

describe('@tiptap/y-tiptap', () => {
  it('resolves to the same copy for us and for the collaboration extension', () => {
    const ours = require.resolve('@tiptap/y-tiptap');
    const collabExtension = require.resolve('@tiptap/extension-collaboration');
    const theirs = createRequire(dirname(collabExtension)).resolve(
      '@tiptap/y-tiptap',
    );

    // Compared as paths so a failure names both versions rather than just
    // saying two objects differ.
    expect(theirs).toBe(ours);
  });
});
