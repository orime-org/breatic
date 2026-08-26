// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import en from '@locales/en.json';
import { pickEndToastKey } from '@web/spaces/canvas/generate/pick-end-notice';

/**
 * Read a dotted key out of the catalog.
 * @param key - The dotted translation key.
 * @returns The English text, or undefined when the key does not exist.
 */
function lookUp(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      en,
    );
}

describe('pickEndToastKey', () => {
  it('says nothing about anyone else when this client made the change', () => {
    expect(lookUp(pickEndToastKey(true))).not.toContain('collaborator');
  });

  it('names a collaborator when the change was theirs', () => {
    expect(lookUp(pickEndToastKey(false))).toContain('collaborator');
  });

  it('resolves both to real text', () => {
    // A key that does not exist reaches the user as the dotted key itself.
    for (const local of [true, false]) {
      expect(typeof lookUp(pickEndToastKey(local))).toBe('string');
    }
  });
});
