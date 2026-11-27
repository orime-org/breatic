// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 the source player's camera menu (tools design §4 camera menu; canvas design §27; demo video-controls.tsx
 * SourcePlayer): hovering a video node's player shows a camera button whose menu offers First frame, Last frame and Current
 * frame, each opening Extract frames in that mode.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

describe('the camera menu on the video player', () => {
  it('lists First, Last and Current frame and reports the one chosen', async () => {
    const onPickFrame = vi.fn();
    render(<MediaPlayer modality='video' src='/v.mp4' onPickFrame={onPickFrame} />);
    const trigger = screen.getByTestId('frame-capture-menu');
    expect(trigger.className).toContain('opacity-0');
    expect(trigger.className).toContain('group-hover/player:opacity-100');
    await userEvent.click(trigger);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['First frame', 'Last frame', 'Current frame']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Last frame' }));
    expect(onPickFrame).toHaveBeenCalledExactlyOnceWith('last');
  });

  it('is absent without a handler, and from the preview player', () => {
    const { rerender } = render(<MediaPlayer modality='video' src='/v.mp4' />);
    expect(screen.queryByTestId('frame-capture-menu')).toBeNull();
    rerender(<MediaPlayer modality='video' src='/v.mp4' variant='preview' onPickFrame={vi.fn()} />);
    expect(screen.queryByTestId('frame-capture-menu')).toBeNull();
  });
});
