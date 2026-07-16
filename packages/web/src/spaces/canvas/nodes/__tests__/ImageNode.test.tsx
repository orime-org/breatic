// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImageNode } from '@web/spaces/canvas/nodes/ImageNode';

/**
 * jsdom never decodes images, so `naturalWidth`/`naturalHeight` stay 0. Stub
 * them on the element and fire the load event to exercise the onLoad read path.
 * @param img - The image element to stub.
 * @param width - The intrinsic width to report.
 * @param height - The intrinsic height to report.
 * @returns Nothing.
 */
function fireImageLoad(img: HTMLElement, width: number, height: number): void {
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', {
    value: height,
    configurable: true,
  });
  fireEvent.load(img);
}

describe('ImageNode', () => {
  it('renders placeholder when no url', () => {
    render(<ImageNode data={{ kind: 'image', status: 'idle' }} />);
    expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
  });

  it('renders the image when url is present', () => {
    render(
      <ImageNode
        data={{ kind: 'image', content: 'https://e.com/x.jpg', status: 'idle' }}
      />,
    );
    expect(
      screen.getByTestId('image-node-img').getAttribute('src'),
    ).toBe('https://e.com/x.jpg');
  });

  it('handling status shows skeleton even with url', () => {
    render(
      <ImageNode
        data={{ kind: 'image', content: 'https://e.com/x', status: 'handling' }}
      />,
    );
    expect(screen.getByTestId('node-content-handling')).toBeInTheDocument();
  });

  it('error status shows the error message', () => {
    render(
      <ImageNode
        data={{
          kind: 'image',
          status: 'error',
          errorMessage: '404',
        }}
      />,
    );
    expect(screen.getByTestId('node-content-error')).toHaveTextContent('404');
  });

  it('DOUBLE-clicking placeholder fires onActivate (opens upload); a single click does not', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle' }}
        onActivate={onActivate}
      />,
    );
    const ph = screen.getByTestId('node-placeholder');
    await user.click(ph);
    expect(onActivate).not.toHaveBeenCalled();
    await user.dblClick(ph);
    expect(onActivate).toHaveBeenCalled();
  });

  // #1772: onlyRenderVisibleElements culls offscreen nodes AFTER the initial
  // mount, but the initial mount renders every node once (xyflow #3883) — an
  // eager <img> would start fetching every image in the space on load. Native
  // lazy loading defers offscreen fetches to viewport proximity.
  it('the image is viewport-lazy and decodes off the main thread (#1772)', () => {
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'https://e.com/x.jpg' }}
      />,
    );
    const img = screen.getByTestId('image-node-img');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
  });

  it('the shell clips the filled image - no corner gap (#1550 follow-up)', () => {
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'blob:img' }}
      />,
    );
    // Concentric-radius geometry: the shell is rounded-sm (6px) + 1px border
    // with zero padding, so a child carrying its own 6px radius curves faster
    // than the border's inner arc and opens a gap in all four corners. The
    // shell clips every child to its rounded box; the img carries NO radius.
    expect(screen.getByTestId('image-node').className).toContain(
      'overflow-hidden',
    );
    expect(screen.getByTestId('image-node-img').className).not.toContain(
      'rounded',
    );
  });

  // #1616: non-empty image nodes show their pixel resolution top-right once the
  // image loads; read from the DOM (naturalWidth/Height), no data-model field.
  it('shows the resolution badge after the image loads (#1616)', () => {
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'https://e.com/x.jpg' }}
      />,
    );
    fireImageLoad(screen.getByTestId('image-node-img'), 1920, 1080);
    expect(screen.getByTestId('node-resolution-badge')).toHaveTextContent(
      '1920×1080',
    );
  });

  it('empty image node shows no resolution badge (#1616)', () => {
    render(<ImageNode data={{ kind: 'image', status: 'idle' }} />);
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });

  it('no badge before the image loads — broken/loading src (#1616)', () => {
    render(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'https://e.com/x.jpg' }}
      />,
    );
    // No load event fired (still loading, or onError for a broken src).
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });

  it('resets the badge when the content URL changes (no stale value) (#1616)', () => {
    const { rerender } = render(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'https://e.com/a.jpg' }}
      />,
    );
    fireImageLoad(screen.getByTestId('image-node-img'), 1920, 1080);
    expect(screen.getByTestId('node-resolution-badge')).toHaveTextContent(
      '1920×1080',
    );
    // Swap the image: the badge must clear until the NEW image loads, never
    // showing the previous image's dimensions.
    rerender(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'https://e.com/b.jpg' }}
      />,
    );
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });

  // #1616 adversarial fix: regenerating a loaded node in place flips status to
  // 'handling' while keeping the SAME content URL — the img unmounts behind a
  // skeleton but resolution state survives. The badge must hide, not float a
  // stale size over the skeleton.
  it('hides the badge when flipping to handling in place (same content) (#1616)', () => {
    const { rerender } = render(
      <ImageNode
        data={{ kind: 'image', status: 'idle', content: 'https://e.com/x.jpg' }}
      />,
    );
    fireImageLoad(screen.getByTestId('image-node-img'), 1920, 1080);
    expect(screen.getByTestId('node-resolution-badge')).toBeInTheDocument();
    rerender(
      <ImageNode
        data={{ kind: 'image', status: 'handling', content: 'https://e.com/x.jpg' }}
      />,
    );
    expect(screen.queryByTestId('node-resolution-badge')).toBeNull();
  });
});
