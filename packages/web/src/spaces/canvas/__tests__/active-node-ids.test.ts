// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { deriveActiveNodeIds } from '@web/spaces/canvas/active-node-ids';

describe('deriveActiveNodeIds', () => {
  describe('with no pick session', () => {
    it('reports the whole selection', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: ['a'],
          pickSession: null,
          focusTargetId: null,
        }),
      ).toEqual(['a']);
    });

    it('keeps every id of a multi-selection', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: ['a', 'b', 'c'],
          pickSession: null,
          focusTargetId: null,
        }),
      ).toEqual(['a', 'b', 'c']);
    });

    it('reports null when the selection is empty', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: [],
          pickSession: null,
          focusTargetId: null,
        }),
      ).toBeNull();
    });

    it('ignores a focus target left over from a finished session', () => {
      // `focusTarget` is cleared by its own effect one render later; until then
      // the two sources disagree and the session is the one that is over.
      expect(
        deriveActiveNodeIds({
          selectedIds: ['host'],
          pickSession: null,
          focusTargetId: 'target',
        }),
      ).toEqual(['host']);
    });
  });

  describe('with a non-focus pick session', () => {
    it('reports only the host', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: [],
          pickSession: { nodeId: 'host', purpose: 'style' },
          focusTargetId: null,
        }),
      ).toEqual(['host']);
    });

    it('discards the selection the pick froze', () => {
      // Selection is switched off canvas-wide during a pick (`elementsSelectable`),
      // so `selectedIds` still holds whatever was selected when the pick began.
      expect(
        deriveActiveNodeIds({
          selectedIds: ['stale', 'older'],
          pickSession: { nodeId: 'host', purpose: 'reference' },
          focusTargetId: null,
        }),
      ).toEqual(['host']);
    });

    it('discards a focus target from an earlier focus session', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: [],
          pickSession: { nodeId: 'host', purpose: 'firstFrame' },
          focusTargetId: 'target',
        }),
      ).toEqual(['host']);
    });
  });

  describe('with a focus pick session', () => {
    it('reports only the host before a target is picked', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: [],
          pickSession: { nodeId: 'host', purpose: 'focus' },
          focusTargetId: null,
        }),
      ).toEqual(['host']);
    });

    it('reports host and target once a target is picked', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: [],
          pickSession: { nodeId: 'host', purpose: 'focus' },
          focusTargetId: 'target',
        }),
      ).toEqual(['host', 'target']);
    });

    it('reports the host once when it is its own focus target', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: [],
          pickSession: { nodeId: 'host', purpose: 'focus' },
          focusTargetId: 'host',
        }),
      ).toEqual(['host']);
    });

    it('still discards the selection the pick froze', () => {
      expect(
        deriveActiveNodeIds({
          selectedIds: ['stale'],
          pickSession: { nodeId: 'host', purpose: 'focus' },
          focusTargetId: 'target',
        }),
      ).toEqual(['host', 'target']);
    });
  });
});
