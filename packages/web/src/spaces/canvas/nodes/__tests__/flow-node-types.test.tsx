// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { NODE_KIND_LIST } from '@web/spaces/canvas/nodes/registry';

describe('FLOW_NODE_TYPES', () => {
  it('exposes a ReactFlow component for every node kind', () => {
    NODE_KIND_LIST.forEach((kind) => {
      expect(typeof FLOW_NODE_TYPES[kind]).toBe('function');
    });
  });

  it('keys match the registry kind list exactly', () => {
    expect(Object.keys(FLOW_NODE_TYPES).sort()).toEqual(
      [...NODE_KIND_LIST].sort(),
    );
  });
});
