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
  it('names the user for their own change and a collaborator for theirs', () => {
    expect(pickEndToastKey('modeChanged', true)).not.toBe(
      pickEndToastKey('modeChanged', false),
    );
    expect(lookUp(pickEndToastKey('modeChanged', false))).toContain(
      'A collaborator',
    );
    expect(lookUp(pickEndToastKey('modeChanged', true))).not.toContain(
      'A collaborator',
    );
  });

  it('tells a mode change from a model change', () => {
    expect(pickEndToastKey('modeChanged', true)).not.toBe(
      pickEndToastKey('modelChanged', true),
    );
    expect(lookUp(pickEndToastKey('modeChanged', true))).toContain('Mode');
    expect(lookUp(pickEndToastKey('modelChanged', true))).toContain('Model');
  });

  it('resolves every combination to real text', () => {
    // A key that does not exist reaches the user as the dotted key itself.
    for (const reason of ['modeChanged', 'modelChanged'] as const) {
      for (const local of [true, false]) {
        expect(typeof lookUp(pickEndToastKey(reason, local))).toBe('string');
      }
    }
  });
});
