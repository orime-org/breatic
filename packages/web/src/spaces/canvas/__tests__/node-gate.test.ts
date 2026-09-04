// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/**
 * The one operation a running task freezes: deleting the node it is going to
 * write to would leave the result nowhere to land (#186 §7.7).
 */
const HANDLING_FROZEN: readonly NodeMutation[] = ['delete'];

/**
 * Everything a running task leaves free. Starting a second upload or a second
 * generation is what this whole change is for; editing the content by hand
 * belongs with them, since the last write wins either way and the task list is
 * where a user picks between the results.
 */
const HANDLING_FREE: readonly NodeMutation[] = [
  'move',
  'rename',
  'editContent',
  'upload',
  'generate',
];

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

  it('a running task blocks only deleting the node', () => {
    for (const op of HANDLING_FROZEN) {
      expect(evaluateNodeGate({ locked: false, handling: true }, op)).toEqual({
        reason: 'handling',
        toastKey: NODE_GATE_TOAST_KEY.handling,
      });
    }
  });

  it('a running task leaves every other operation free', () => {
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
