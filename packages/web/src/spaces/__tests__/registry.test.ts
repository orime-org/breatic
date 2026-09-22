// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { SpaceType } from '@breatic/shared';

import { SPACE_TYPES } from '@web/spaces';

describe('SPACE_TYPES registry', () => {
  it('exposes all 3 V1 space types (canvas / document / timeline)', () => {
    const keys: SpaceType[] = ['canvas', 'document', 'timeline'];
    keys.forEach((k) => {
      expect(SPACE_TYPES[k]).toBeDefined();
      expect(SPACE_TYPES[k].type).toBe(k);
    });
  });

  it('every space has a non-empty label, icon, bodyComponent', () => {
    Object.values(SPACE_TYPES).forEach((def) => {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.icon.length).toBeGreaterThan(0);
      expect(typeof def.bodyComponent).toBe('function');
    });
  });
});
