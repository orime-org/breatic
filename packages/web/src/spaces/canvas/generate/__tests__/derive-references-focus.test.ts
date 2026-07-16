// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Focus crops as pool entries (#1782): the `focus:` id namespace and the
 * FocusImage → rail-item mapping that lets the whole mention / rail /
 * cascade plumbing treat crops as ordinary pool rows.
 */

import { describe, it, expect } from 'vitest';

import {
  FOCUS_REF_PREFIX,
  focusRefId,
  focusIdOfRefId,
  focusToRailItem,
} from '@web/spaces/canvas/generate/derive-references';

const CROP = {
  id: 'f1',
  url: 'https://cdn/crop.png',
  name: 'Image Node 26',
  width: 640,
  height: 360,
};

describe('focus pool entries', () => {
  it('maps a FocusImage to a rail item in the focus: namespace', () => {
    const item = focusToRailItem(CROP);
    expect(item).toEqual({
      refId: `${FOCUS_REF_PREFIX}f1`,
      sourceNodeId: `${FOCUS_REF_PREFIX}f1`,
      sourceNodeType: 'image',
      sourceNodeName: 'Image Node 26',
      thumbnail: 'https://cdn/crop.png',
      focus: true,
    });
  });

  it('focusRefId / focusIdOfRefId round-trip; node ids resolve to null', () => {
    expect(focusRefId('f1')).toBe('focus:f1');
    expect(focusIdOfRefId('focus:f1')).toBe('f1');
    expect(focusIdOfRefId('edge-or-node-uuid')).toBeNull();
  });
});
