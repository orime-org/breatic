// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import {
  evaluateNodeGate,
  NODE_GATE_TOAST_KEY,
} from '@web/spaces/canvas/node-gate';

describe('evaluateNodeGate', () => {
  it('allows the operation on an unlocked node', () => {
    expect(evaluateNodeGate({ locked: false })).toBeNull();
  });

  it('locked blocks it, and says which reason to show', () => {
    expect(evaluateNodeGate({ locked: true })).toEqual({
      reason: 'locked',
      toastKey: NODE_GATE_TOAST_KEY.locked,
    });
  });

  it('maps each reason to a distinct namespaced toast key', () => {
    expect(NODE_GATE_TOAST_KEY.locked).toBe('canvas.gate.locked');
    expect(NODE_GATE_TOAST_KEY.handling).toBe('canvas.gate.handling');
    expect(NODE_GATE_TOAST_KEY.locked).not.toBe(NODE_GATE_TOAST_KEY.handling);
  });
});
