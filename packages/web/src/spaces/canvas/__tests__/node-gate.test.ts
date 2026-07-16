// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import {
  evaluateNodeGate,
  NODE_GATE_TOAST_KEY,
  type NodeMutation,
} from '@web/spaces/canvas/node-gate';

const ALL_OPS: readonly NodeMutation[] = [
  'move',
  'delete',
  'rename',
  'editContent',
  'upload',
  'generate',
];

/** The operations `handling` freezes (content-affecting). */
const HANDLING_FROZEN: readonly NodeMutation[] = [
  'delete',
  'editContent',
  'upload',
  'generate',
];

/** The operations `handling` leaves free (orthogonal to content). */
const HANDLING_FREE: readonly NodeMutation[] = ['move', 'rename'];

describe('evaluateNodeGate', () => {
  it('allows every operation on an idle, unlocked node', () => {
    for (const op of ALL_OPS) {
      expect(evaluateNodeGate({ locked: false, handling: false }, op)).toBeNull();
    }
  });

  it('locked blocks EVERY operation with the locked reason', () => {
    for (const op of ALL_OPS) {
      expect(evaluateNodeGate({ locked: true, handling: false }, op)).toEqual({
        reason: 'locked',
        toastKey: NODE_GATE_TOAST_KEY.locked,
      });
    }
  });

  it('handling blocks only content-affecting operations', () => {
    for (const op of HANDLING_FROZEN) {
      expect(evaluateNodeGate({ locked: false, handling: true }, op)).toEqual({
        reason: 'handling',
        toastKey: NODE_GATE_TOAST_KEY.handling,
      });
    }
  });

  it('handling leaves position and name free', () => {
    for (const op of HANDLING_FREE) {
      expect(evaluateNodeGate({ locked: false, handling: true }, op)).toBeNull();
    }
  });

  it('locked takes precedence over handling for every operation', () => {
    for (const op of ALL_OPS) {
      expect(evaluateNodeGate({ locked: true, handling: true }, op)).toEqual({
        reason: 'locked',
        toastKey: NODE_GATE_TOAST_KEY.locked,
      });
    }
  });

  it('maps each reason to a distinct namespaced toast key', () => {
    expect(NODE_GATE_TOAST_KEY.locked).toBe('canvas.gate.locked');
    expect(NODE_GATE_TOAST_KEY.handling).toBe('canvas.gate.handling');
    expect(NODE_GATE_TOAST_KEY.locked).not.toBe(NODE_GATE_TOAST_KEY.handling);
  });
});
