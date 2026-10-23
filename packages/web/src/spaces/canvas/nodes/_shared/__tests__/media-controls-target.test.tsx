// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

afterEach(() => vi.restoreAllMocks());

describe('a document video controls target', () => {
  it('moves the same controls and media between targets and parks them while closed', () => {
    const first = document.createElement('div');
    const next = document.createElement('div');
    document.body.append(first, next);
    const { rerender, unmount } = render(<MediaPlayer modality='video' src='/clip.mp4' videoControls={{ destination: first, surface: 'popover' }} />);
    const media = screen.getByTestId('media-element');
    const controls = screen.getByTestId('controls');
    const seek = screen.getByTestId('seek');
    expect(first.contains(controls)).toBe(true);
    rerender(<MediaPlayer modality='video' src='/clip.mp4' videoControls={{ destination: next, surface: 'popover' }} />);
    expect(next.contains(controls)).toBe(true);
    expect(screen.getByTestId('seek')).toBe(seek);
    expect(screen.getByTestId('media-element')).toBe(media);
    rerender(<MediaPlayer modality='video' src='/clip.mp4' videoControls={{ destination: null, surface: 'popover' }} />);
    expect(controls.closest('[inert]')).not.toBeNull();
    expect(first.contains(controls)).toBe(false);
    expect(next.contains(controls)).toBe(false);
    unmount();
    first.remove(); next.remove();
  });

  it('reads the current seek geometry after a target changes width during a pointer gesture', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const activity = vi.fn();
    const { unmount } = render(<MediaPlayer modality='video' src='/clip.mp4' duration={100} videoControls={{ destination: target, surface: 'popover', onSeekingChange: activity }} />);
    const seek = screen.getByTestId('seek');
    const media = screen.getByTestId('media-element') as HTMLVideoElement;
    const rect = vi.spyOn(seek, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 24));
    fireEvent.pointerDown(seek, { pointerId: 3, clientX: 160, button: 0 });
    expect(media.currentTime).toBeCloseTo(30);
    rect.mockReturnValue(new DOMRect(40, 0, 80, 24));
    fireEvent.pointerMove(seek, { pointerId: 3, clientX: 100 });
    expect(media.currentTime).toBeCloseTo(75);
    fireEvent.pointerUp(seek, { pointerId: 3, clientX: 100 });
    expect(media.currentTime).toBeCloseTo(75);
    expect(activity.mock.calls.map(([active]) => active)).toEqual([true, false]);
    unmount(); target.remove();
  });
  it('restores the same focused seek after an intermediate parked transfer', () => {
    const first = document.createElement('div');
    const next = document.createElement('div');
    document.body.append(first, next);
    const { rerender, unmount } = render(<MediaPlayer modality='video' src='/clip.mp4' videoControls={{ destination: first, surface: 'video', preserveFocus: true }} />);
    const thumb = screen.getByRole('slider', { name: 'Seek' });
    thumb.focus();
    rerender(<MediaPlayer modality='video' src='/clip.mp4' videoControls={{ destination: null, surface: 'popover', preserveFocus: true }} />);
    rerender(<MediaPlayer modality='video' src='/clip.mp4' videoControls={{ destination: next, surface: 'popover', preserveFocus: true }} />);
    expect(screen.getByRole('slider', { name: 'Seek' })).toBe(thumb);
    expect(thumb).toHaveFocus();
    unmount(); first.remove(); next.remove();
  });

  it('releases an external seek when controls become hidden', () => {
    const target = document.createElement('div'); document.body.appendChild(target);
    const activity = vi.fn();
    const config = { destination: target, surface: 'popover' as const, onSeekingChange: activity };
    const { rerender, unmount } = render(<MediaPlayer modality='video' src='/clip.mp4' duration={100} videoControls={config} />);
    const seek = screen.getByTestId('seek');
    const media = screen.getByTestId('media-element') as HTMLVideoElement;
    vi.spyOn(seek, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 200, 24));
    fireEvent.pointerDown(seek, { pointerId: 3, clientX: 160, button: 0 });
    expect(media.currentTime).toBeCloseTo(30);
    rerender(<MediaPlayer modality='video' src='/clip.mp4' duration={100} videoControls={config} controlsHidden />);
    expect(activity.mock.calls.map(([active]) => active)).toEqual([true, false]);
    fireEvent.pointerMove(seek, { pointerId: 3, clientX: 250 });
    expect(media.currentTime).toBeCloseTo(30);
    unmount(); target.remove();
  });

});
