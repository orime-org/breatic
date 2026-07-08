// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { NODE_TYPES, NODE_KIND_LIST } from '@web/spaces/canvas/nodes/registry';

describe('canvas NODE_TYPES registry', () => {
  it('exposes a renderable component for every kind in NODE_KIND_LIST', () => {
    NODE_KIND_LIST.forEach((k) => {
      const component = NODE_TYPES[k];
      // Node bodies are React.memo-wrapped for canvas perf (#1647), and
      // React.memo returns an exotic component OBJECT (with `$$typeof`), not a
      // plain function — so a valid entry is a function or a memo component.
      const isRenderable =
        typeof component === 'function' ||
        (typeof component === 'object' &&
          component !== null &&
          '$$typeof' in component);
      expect(isRenderable).toBe(true);
    });
  });

  it('NODE_KIND_LIST is exactly the 6 unified types + annotation + group', () => {
    expect(NODE_KIND_LIST).toEqual([
      'text',
      'image',
      'audio',
      'video',
      '3d',
      'web',
      'annotation',
      'group',
    ]);
  });
});
