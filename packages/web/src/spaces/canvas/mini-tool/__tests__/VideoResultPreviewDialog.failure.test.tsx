// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 remove-background result preview: a failed presentation says so, as the video node does, instead of a player
 * that never loads.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@web/spaces/canvas/video-presentation/use-resolved-video-presentation', () => ({
  useResolvedVideoPresentation: () => ({ query: {}, source: null, failure: 'presentation-query-failed' }),
}));

import { VideoResultPreviewDialog } from '../video/VideoResultPreviewDialog';

describe('remove-background result preview on a failed presentation', () => {
  it('shows the media error line in place of the player', () => {
    render(<VideoResultPreviewDialog open onOpenChange={vi.fn()} projectId='p' url='https://assets.example.test/alpha.webm' name='BG' />);
    const dialog = screen.getByTestId('video-result-preview');
    const line = screen.getByText('Media unavailable');
    expect(line.className).toContain('text-status-error-foreground');
    expect(dialog.querySelector('[data-testid="media-player"]')).toBeNull();
  });
});
