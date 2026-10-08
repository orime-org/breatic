// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import { resetPreviewRecords } from '@web/lib/preview-src';
import { NodeZoomedPastPreviewContext } from '@web/spaces/canvas/nodes/_shared/preview-zoom';
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

describe('VideoNode zoomed past its cover preview (inner#1320)', () => {
  const COVER =
    'https://resource-dev.breatic.cc/video/2026-09-30/1_18f58aed-b802-4243-a8ea-02d377de9679_cover.png';

  /**
   * The node under a given zoom answer from the canvas.
   * @param past - Whether the canvas says the node is past its preview.
   * @returns The element tree.
   */
  function zoomed(past: boolean): React.JSX.Element {
    return (
      <NodeZoomedPastPreviewContext.Provider value={past}>
        <VideoNode
          data={{ kind: 'video', content: 'https://e.com/v.mp4', coverUrl: COVER, status: 'idle' }}
        />
      </NodeZoomedPastPreviewContext.Provider>
    );
  }

  it('shows the cover preview while the canvas is not zoomed past it', () => {
    resetPreviewRecords();
    render(zoomed(false));

    expect(screen.getByTestId('media-element').getAttribute('poster')).toBe(`${COVER}.preview.webp`);
  });

  it('shows the full cover once zoomed past it, and keeps it after zooming out', () => {
    resetPreviewRecords();
    const { rerender } = render(zoomed(true));
    expect(screen.getByTestId('media-element').getAttribute('poster')).toBe(COVER);

    rerender(zoomed(false));
    expect(screen.getByTestId('media-element').getAttribute('poster')).toBe(COVER);
  });
});

// inner#1320: the node hands the player its own size, so the box is reserved
// before the poster arrives, as an image node's is.
describe('VideoNode while its poster loads', () => {
  it('reserves the box from the size it carries and shows the skeleton', () => {
    render(
      <VideoNode
        data={{ kind: 'video', status: 'idle', content: '/v.mp4', coverUrl: '/v_cover.png', width: 1080, height: 3840 }}
      />,
    );

    expect(screen.getByTestId('media-element').getAttribute('width')).toBe('1080');
    expect(screen.getByTestId('media-element').getAttribute('height')).toBe('3840');
    expect(screen.getByTestId('media-skeleton')).toBeInTheDocument();
  });

  it('reserves nothing for a node of unknown size', () => {
    render(<VideoNode data={{ kind: 'video', status: 'idle', content: '/v.mp4', coverUrl: '/v_cover.png' }} />);

    expect(screen.getByTestId('media-element').getAttribute('width')).toBeNull();
    expect(screen.queryByTestId('media-skeleton')).toBeNull();
  });
});
