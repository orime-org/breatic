// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { SPACE_TYPES, SPACE_TYPE_LIST, type SpaceType } from '@web/spaces';

describe('SPACE_TYPES registry', () => {
  it('exposes all 3 V1 space types (canvas / document / timeline)', () => {
    const keys: SpaceType[] = ['canvas', 'document', 'timeline'];
    keys.forEach((k) => {
      expect(SPACE_TYPES[k]).toBeDefined();
      expect(SPACE_TYPES[k].type).toBe(k);
    });
  });

  it('every space has a non-empty label, icon, bodyComponent', () => {
    SPACE_TYPE_LIST.forEach((def) => {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.icon.length).toBeGreaterThan(0);
      expect(typeof def.bodyComponent).toBe('function');
    });
  });

  it('SPACE_TYPE_LIST preserves insertion order (canvas first)', () => {
    expect(SPACE_TYPE_LIST.map((s) => s.type)).toEqual([
      'canvas',
      'document',
      'timeline',
    ]);
  });
});
