// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A transparent presentation (an alpha-packed version, such as a remove-background result) shows the canvas checkerboard
 * behind its picture, the one an expansion's painted area shows; an opaque one shows none.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@web/spaces/canvas/video-presentation/use-media-surface', () => ({
  useMediaSurface: () => ({ status: 'ready', binding: null, error: null }),
}));

import { VideoPresentationSurface } from '../VideoPresentationSurface';
import type { VideoPresentationSource } from '../types';

/**
 * A source whose selected version plays as the given kind.
 * @param kind - The playback kind.
 * @returns The source.
 */
function sourceOf(kind: 'native' | 'alpha-packed'): VideoPresentationSource {
  return { canonicalURL: 'https://assets.example.test/clip.webm', sourceFingerprint: 'a'.repeat(64), manifest: null,
    presentation: { display: { width: 640, height: 360 }, playback: { kind } } } as unknown as VideoPresentationSource;
}

describe('VideoPresentationSurface transparency backdrop', () => {
  it('draws the checkerboard behind an alpha-packed picture', () => {
    const { container } = render(<VideoPresentationSurface source={sourceOf('alpha-packed')} active onBinding={vi.fn()} />);
    const surface = container.querySelector<HTMLElement>('[data-video-presentation]')!;
    expect(surface.style.backgroundImage).toContain('repeating-conic-gradient');
    expect(surface.style.aspectRatio).toBe('640/360');
  });

  it('draws no checkerboard behind an opaque picture', () => {
    const { container } = render(<VideoPresentationSurface source={sourceOf('native')} active onBinding={vi.fn()} />);
    expect(container.querySelector<HTMLElement>('[data-video-presentation]')!.style.backgroundImage).toBe('');
  });
});
