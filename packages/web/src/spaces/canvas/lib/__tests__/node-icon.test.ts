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
});
