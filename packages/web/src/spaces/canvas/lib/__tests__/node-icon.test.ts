// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Box, FileText, Globe, Image, Music, Video } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';

describe('getNodeIcon', () => {
  it('maps each media / text modality to its representative lucide icon', () => {
    expect(getNodeIcon('text')).toBe(FileText);
    expect(getNodeIcon('image')).toBe(Image);
    expect(getNodeIcon('audio')).toBe(Music);
    expect(getNodeIcon('video')).toBe(Video);
    expect(getNodeIcon('3d')).toBe(Box);
    expect(getNodeIcon('web')).toBe(Globe);
  });

  it('returns a non-null icon for annotation / group (never crashes the chip)', () => {
    expect(getNodeIcon('annotation')).toBeTruthy();
    expect(getNodeIcon('group')).toBeTruthy();
  });

  // The `@` chip reads `kind` from an untrusted Yjs attr — a corrupt or
  // forward-incompatible doc can carry any string. getNodeIcon must always
  // return a real icon component so the chip never renders `<undefined/>` and
  // crashes the whole prompt editor (adversarial finding 2026-07-10).
  it('falls back to the Image icon for null / undefined / unknown modalities', () => {
    expect(getNodeIcon(null)).toBe(Image);
    expect(getNodeIcon(undefined)).toBe(Image);
    expect(getNodeIcon('sticker')).toBe(Image);
    expect(getNodeIcon('')).toBe(Image);
  });

  it('does NOT leak Object.prototype keys as icons (constructor / toString → Image)', () => {
    // A plain `map[kind]` lookup returns the Object constructor for these keys
    // (a truthy non-component), which would crash React. Object.hasOwn gating
    // must keep them on the fallback path.
    expect(getNodeIcon('constructor')).toBe(Image);
    expect(getNodeIcon('toString')).toBe(Image);
    expect(getNodeIcon('hasOwnProperty')).toBe(Image);
  });
});
