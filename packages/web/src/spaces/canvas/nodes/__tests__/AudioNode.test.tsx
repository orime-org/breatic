// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AudioNode } from '@web/spaces/canvas/nodes/AudioNode';

describe('AudioNode', () => {
  it('renders placeholder when no url', () => {
    render(<AudioNode data={{ kind: 'audio', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders the media player audio element when url is present', () => {
    render(
      <AudioNode
        data={{ kind: 'audio', content: 'https://e.com/a.mp3', status: 'idle' }}
      />,
    );
    const el = screen.getByTestId('media-element');
    expect(el.tagName).toBe('AUDIO');
    expect(el.getAttribute('src')).toBe('https://e.com/a.mp3');
    // the unified player surfaces a waveform + transport, not native controls
    expect(screen.getByTestId('waveform')).toBeInTheDocument();
  });

  it('keeps its empty box while a task runs on it', () => {
    // The counts beside the node say something is working; the node itself
    // shows what it holds, which here is nothing yet (user 2026-09-06).
    render(<AudioNode data={{ kind: 'audio', status: 'handling' }} />);
    expect(screen.queryByTestId('node-content-handling')).not.toBeInTheDocument();
    expect(screen.getByTestId('node-content-empty')).toBeInTheDocument();
  });
});
