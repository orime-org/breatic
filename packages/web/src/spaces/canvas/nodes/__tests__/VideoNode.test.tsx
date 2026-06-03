// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';

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
          url: 'https://e.com/v.mp4',
          coverUrl: 'https://e.com/c.jpg',
          status: 'idle',
        }}
      />,
    );
    const v = screen.getByTestId('video-node-video') as HTMLVideoElement;
    expect(v.getAttribute('src')).toBe('https://e.com/v.mp4');
    expect(v.getAttribute('poster')).toBe('https://e.com/c.jpg');
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
});
