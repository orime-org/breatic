// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every slot's stored pick reaches the node view the panels read (#1928, #2156).
 *
 * The view is a hand-written object literal, so a field a slot writes but the
 * view leaves out type-checks and then reads as empty forever: the pick
 * writes, collaborators see the value, and the slot button stays blank.
 * Walked off the slot registries so a slot added later is asked too.
 */

import type { CanvasNodeFields } from '@breatic/shared';
import { describe, it, expect } from 'vitest';

import { toNodeView } from '@web/data/yjs/node-view';
import { allSlotSpecs } from '@web/spaces/canvas/generate/slots';

describe('slot fields on the node view', () => {
  for (const spec of allSlotSpecs()) {
    it(`carries ${spec.field}`, () => {
      const url = `https://cdn/${spec.field}`;
      const pick = spec.multiple ? [url] : spec.storesCover ? { url } : url;
      const fields = {
        id: 'n1',
        // The slot fields ride the part every content view shares.
        type: 'video',
        position: { x: 0, y: 0 },
        data: { name: 'N', createdAt: 1, createdBy: 'u1', locked: false, attachments: [], [spec.field]: pick },
      } as unknown as CanvasNodeFields;
      expect(toNodeView(fields)).toMatchObject({ [spec.field]: pick });
    });
  }
});
