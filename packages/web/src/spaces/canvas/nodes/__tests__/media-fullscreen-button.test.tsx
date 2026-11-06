// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

import { renderWithTooltips } from '@web/test-utils/render-with-tooltips';
import userEvent from '@testing-library/user-event';

import { ImageNode } from '@web/spaces/canvas/nodes/ImageNode';
import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { canvasSessions, type MiniToolDraft } from '@web/stores/canvas-session';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  canvasSessions.clear();
});

const NODES = [
  { name: 'image', Node: ImageNode, content: 'https://e.com/a.png' },
  { name: 'video', Node: VideoNode, content: 'https://e.com/v.mp4' },
] as const;

// inner#1844: every canvas image and video opens full screen from a button
// over the media's top-right corner, shown while the pointer is on the node.
describe.each(NODES)('$name node full-screen button', ({ Node, content }) => {
  /**
   * The node with an id, as the canvas renders it.
   * @param data - The node data.
   * @returns The element.
   */
  function node(data: Record<string, unknown>): React.JSX.Element {
    return (
      <NodeIdContext.Provider value='n1'>
        <Node data={{ handling: false, ...data }} />
      </NodeIdContext.Provider>
    );
  }

  it('sits in the media inset, hidden until the node is hovered', () => {
    renderWithTooltips(node({ content }));
    const button = screen.getByTestId('media-fullscreen-button');
    expect(screen.getByTestId('node-media-inset')).toContainElement(button);
    expect(button.className).toContain('opacity-0');
    expect(button.className).toContain('group-hover/media:opacity-100');
    expect(button.className).toContain('nodrag');
  });

  it('is absent while the node holds nothing', () => {
    renderWithTooltips(node({}));
    expect(screen.queryByTestId('media-fullscreen-button')).toBeNull();
  });

  it('is absent during a pick session', () => {
    renderWithTooltips(node({ content }));
    act(() => {
      canvasSessions.of('').setState({ pickSession: { nodeId: 'other', purpose: 'reference' } });
    });
    expect(screen.queryByTestId('media-fullscreen-button')).toBeNull();
  });

  it('is absent while a mini-tool is open on this node', () => {
    renderWithTooltips(node({ content }));
    act(() => {
      canvasSessions.of('').setState({
        panelKind: 'miniTool',
        panelHostId: 'n1',
        pickSession: null,
        miniTool: {
          toolId: 'crop',
          sourceContent: content,
          prompt: '',
          params: {},
          slots: {},
          sourceSize: null,
          drawing: null,
          expand: null,
          mark: null,
          exporting: false,
        } satisfies MiniToolDraft,
      });
    });
    expect(screen.queryByTestId('media-fullscreen-button')).toBeNull();
  });

  it('shows on a locked node', () => {
    renderWithTooltips(node({ content, locked: true }));
    expect(screen.getByTestId('media-fullscreen-button')).toBeInTheDocument();
  });

  // inner#1844 round 1: what opened stays on screen while the node changes.
  it('keeps showing what it opened on when the node gets new content', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithTooltips(node({ content }));
    await user.click(screen.getByTestId('media-fullscreen-button'));
    rerender(node({ content: `${content}?next` }));
    const media = screen.getByTestId('media-fullscreen').querySelector('img, video');
    expect(media?.getAttribute('src')).toBe(content);
  });

  it('places the button 6px from the picture, at a size and gap the zoom does not change', () => {
    renderWithTooltips(node({ content }));
    const button = screen.getByTestId('media-fullscreen-button');
    const scaled = button.parentElement?.parentElement;
    expect(scaled?.className).toContain('right-1');
    expect(scaled?.className).toContain('top-1');
    expect(button.parentElement?.className).toContain('pr-1.5');
    expect(button.parentElement?.className).toContain('pt-1.5');
  });

  it('opens the full-screen layer on the original file', async () => {
    const user = userEvent.setup();
    renderWithTooltips(node({ content }));
    await user.click(screen.getByTestId('media-fullscreen-button'));
    const layer = screen.getByTestId('media-fullscreen');
    const media = layer.querySelector('img, video');
    expect(media?.getAttribute('src')).toBe(content);
  });
});

describe('video node full screen', () => {
  it('pauses the node player and hands the full-screen position back on close', async () => {
    const user = userEvent.setup();
    renderWithTooltips(
      <NodeIdContext.Provider value='n1'>
        <VideoNode data={{ handling: false, content: 'https://e.com/v.mp4' }} />
      </NodeIdContext.Provider>,
    );
    const inline = screen.getByTestId('media-element') as HTMLVideoElement;
    inline.currentTime = 4;
    vi.mocked(inline.pause).mockClear();

    await user.click(screen.getByTestId('media-fullscreen-button'));
    expect(inline.pause).toHaveBeenCalled();
    const players = screen.getAllByTestId('media-element') as HTMLVideoElement[];
    const full = players.find((el) => el !== inline);
    expect(full?.currentTime).toBe(4);

    if (full) full.currentTime = 11;
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('media-fullscreen')).toBeNull();
    expect(inline.currentTime).toBe(11);
  });

  // inner#1844 round 2: a result landing on the node while full screen is open
  // is a different clip; the old clip's place and sound are not handed to it.
  it('hands nothing back to a node whose clip was replaced while open', async () => {
    const user = userEvent.setup();
    const view = (content: string): React.JSX.Element => (
      <NodeIdContext.Provider value='n1'>
        <VideoNode data={{ handling: false, content }} />
      </NodeIdContext.Provider>
    );
    const { rerender } = renderWithTooltips(view('https://e.com/old.mp4'));
    const inline = screen.getByTestId('media-element') as HTMLVideoElement;
    await user.click(screen.getByTestId('media-fullscreen-button'));
    rerender(view('https://e.com/new.mp4'));
    const full = screen.getAllByTestId('media-element').find((el) => el !== inline) as HTMLVideoElement;
    full.currentTime = 45;
    full.muted = true;
    await user.keyboard('{Escape}');
    expect(inline.currentTime).toBe(0);
    expect(inline.muted).toBe(false);
  });

  // Full screen exists only while open, so nothing from one opening reaches the next.
  it('measures a video of unknown size afresh each time it opens', async () => {
    const user = userEvent.setup();
    const view = (content: string): React.JSX.Element => (
      <NodeIdContext.Provider value='n1'>
        <VideoNode data={{ handling: false, content }} />
      </NodeIdContext.Provider>
    );
    const { rerender } = renderWithTooltips(view('https://e.com/wide.mp4'));
    const inline = screen.getByTestId('media-element');
    await user.click(screen.getByTestId('media-fullscreen-button'));
    const full = screen.getAllByTestId('media-element').find((el) => el !== inline)!;
    Object.defineProperty(full, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(full, 'videoHeight', { value: 480, configurable: true });
    fireEvent.loadedMetadata(full);
    expect(screen.getByTestId('media-fullscreen').style.getPropertyValue('--media-aspect')).not.toBe('');
    await user.keyboard('{Escape}');

    rerender(view('https://e.com/tall.mp4'));
    await user.click(screen.getByTestId('media-fullscreen-button'));
    expect(screen.getByTestId('media-fullscreen').style.getPropertyValue('--media-aspect')).toBe('');
  });
});
