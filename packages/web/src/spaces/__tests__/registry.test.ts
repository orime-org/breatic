// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, it, expect } from 'vitest';
import type { SpaceType } from '@breatic/shared';

import { SPACE_TYPES } from '@web/spaces';
import { SPACE_TYPE_ICON } from '@web/spaces/space-type-icon';

describe('SPACE_TYPES registry', () => {
  it('exposes all 3 V1 space types (canvas / document / timeline)', () => {
    const keys: SpaceType[] = ['canvas', 'document', 'timeline'];
    keys.forEach((k) => {
      expect(SPACE_TYPES[k]).toBeDefined();
      expect(SPACE_TYPES[k].type).toBe(k);
    });
  });

  it('every space has a bodyComponent and an icon', () => {
    Object.values(SPACE_TYPES).forEach((def) => {
      expect(SPACE_TYPE_ICON[def.type]).toBeDefined();
      // Like the Canvas node registry, Space bodies may be memo components.
      const component: unknown = def.bodyComponent;
      expect(typeof component === 'function' ||
        (typeof component === 'object' && component !== null &&
          '$$typeof' in component && component.$$typeof === Symbol.for('react.memo'))).toBe(true);
    });
  });
});
