// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { NODE_TYPES, NODE_KIND_LIST } from '@web/spaces/canvas/nodes/registry';

describe('canvas NODE_TYPES registry', () => {
  it('exposes a component for every kind in NODE_KIND_LIST', () => {
    NODE_KIND_LIST.forEach((k) => {
      expect(typeof NODE_TYPES[k]).toBe('function');
    });
  });

  it('NODE_KIND_LIST is exactly the 6 unified types + annotation', () => {
    expect(NODE_KIND_LIST).toEqual([
      'text',
      'image',
      'audio',
      'video',
      '3d',
      'web',
      'annotation',
    ]);
  });
});
