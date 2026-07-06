// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

describe('VideoNode', () => {
  it('renders placeholder when no url', () => {
    render(<VideoNode data={{ kind: 'video', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders video element with src + poster', () => {
    render(
      <VideoNode
        data={{
          kind: 'video',
          content: 'https://e.com/v.mp4',
          coverUrl: 'https://e.com/c.jpg',
          status: 'idle',
        }}
      />,
    );
    const v = screen.getByTestId('media-element') as HTMLVideoElement;
    expect(v.tagName).toBe('VIDEO');
    expect(v.getAttribute('src')).toBe('https://e.com/v.mp4');
    expect(v.getAttribute('poster')).toBe('https://e.com/c.jpg');
    // the unified player adds a fullscreen control
    expect(screen.getByTestId('fullscreen')).toBeInTheDocument();
  });

  it('error status shows the error message', () => {
    render(
      <VideoNode
        data={{
          kind: 'video',
          status: 'error',
          errorMessage: 'Failed',
        }}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent(
      'Failed',
    );
  });

  // #1616: non-empty video nodes show their pixel resolution top-right once the
  // metadata loads; read from the DOM (videoWidth/Height), no data-model field.
  it('shows the resolution badge after video metadata loads (#1616)', () => {
    render(
      <VideoNode
        data={{ kind: 'video', status: 'idle', content: 'https://e.com/v.mp4' }}
      />,
    );
    const v = screen.getByTestId('media-element');
    Object.defineProperty(v, 'videoWidth', { value: 1280, configurable: true });
    Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true });
    fireEvent.loadedMetadata(v);
    expect(screen.getByTestId('node-resolution-badge')).toHaveTextContent(
      '1280×720',
    );
  });

  it('empty video node shows no resolution badge (#1616)', () => {
    render(<VideoNode data={{ kind: 'video', status: 'idle' }} />);
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });
});
