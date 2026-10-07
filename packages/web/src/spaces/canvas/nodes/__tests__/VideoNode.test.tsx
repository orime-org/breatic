// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import { canvasSessions } from '@web/stores/canvas-session';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  // The canvas store is a module singleton: a session left open here reaches
  // every later test in this file.
  canvasSessions.of('').setState({ pickSession: null });
});

describe('VideoNode', () => {
  it('renders placeholder when no url', () => {
    render(<VideoNode data={{ kind: 'video', handling: false }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  // Same inset as the image node (user 2026-07-29): media flush against the
  // shell's 1px border merges with it, so the node boundary stops reading as a
  // boundary. Matches the 4px the hover preview card already applies.
  it('insets the player from the shell border', () => {
    render(
      <VideoNode
        data={{
          kind: 'video',
          content: 'https://e.com/v.mp4',
          handling: false,
        }}
      />,
    );
    const media = screen.getByTestId('node-media-inset');
    expect(media.className).toContain('p-1');
    expect(media).toContainElement(screen.getByTestId('media-player'));
  });

  it('renders video element with src + poster', () => {
    render(
      <VideoNode
        data={{
          kind: 'video',
          content: 'https://e.com/v.mp4',
          coverUrl: 'https://e.com/c.jpg',
          handling: false,
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

  // #1616: non-empty video nodes show their pixel resolution top-right once the
  // metadata loads; read from the DOM (videoWidth/Height), no data-model field.
  it('shows the resolution badge after video metadata loads (#1616)', () => {
    render(
      <VideoNode
        data={{ kind: 'video', handling: false, content: 'https://e.com/v.mp4' }}
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
    render(<VideoNode data={{ kind: 'video', handling: false }} />);
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });

  // #1987 A5. The wiring half: MediaPlayer's own test pins prop → DOM, this
  // pins store → prop. Stubbing one of them out is how a chain looks green
  // while nothing is connected.
  it('hides its control bar for the whole focus pick session (#1987 A5)', () => {
    const data = {
      kind: 'video' as const,
      handling: false as const,
      content: 'https://e.com/v.mp4',
    };
    render(<VideoNode data={data} />);
    expect(screen.getByTestId('controls').hasAttribute('inert')).toBe(false);
    // A focus session opens on SOME node — every video hides its bar, not just
    // the one being picked for.
    act(() => {
      canvasSessions.of('').setState({
        pickSession: { nodeId: 'other-node', purpose: 'focus' },
      });
    });
    expect(screen.getByTestId('controls').hasAttribute('inert')).toBe(true);
    // A reference pick is a different session: nothing about it makes a video's
    // own controls a problem.
    act(() => {
      canvasSessions.of('').setState({
        pickSession: { nodeId: 'other-node', purpose: 'reference' },
      });
    });
    expect(screen.getByTestId('controls').hasAttribute('inert')).toBe(false);
    act(() => {
      canvasSessions.of('').setState({ pickSession: null });
    });
    expect(screen.getByTestId('controls').hasAttribute('inert')).toBe(false);
  });
});
