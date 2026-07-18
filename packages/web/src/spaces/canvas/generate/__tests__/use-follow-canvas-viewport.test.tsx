// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/**
 * Test harness: mounts the hook with the given open flag.
 * @param root0 - Props.
 * @param root0.open - Whether the popover is open.
 * @returns Nothing rendered.
 */
function Harness({ open }: { open: boolean }): null {
  useFollowCanvasViewport(open);
  return null;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * Flushes the hook's requestAnimationFrame-coalesced dispatch.
 * @returns A promise resolving after one frame.
 */
function flushFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('useFollowCanvasViewport — repositions canvas popovers on viewport transform', () => {
  it('dispatches resize when the viewport transform mutates while open', async () => {
    const viewport = document.createElement('div');
    viewport.className = 'react-flow__viewport';
    viewport.style.transform = 'translate(0px, 0px) scale(1)';
    document.body.appendChild(viewport);

    const onResize = vi.fn();
    window.addEventListener('resize', onResize);
    render(<Harness open />);

    await act(async () => {
      viewport.style.transform = 'translate(-40px, -20px) scale(1)';
      // MutationObserver callbacks are microtask-scheduled; the dispatch is
      // then coalesced to the next animation frame.
      await Promise.resolve();
      await flushFrame();
    });

    expect(onResize).toHaveBeenCalled();
    window.removeEventListener('resize', onResize);
  });

  it('does not dispatch resize while closed', async () => {
    const viewport = document.createElement('div');
    viewport.className = 'react-flow__viewport';
    viewport.style.transform = 'translate(0px, 0px) scale(1)';
    document.body.appendChild(viewport);

    const onResize = vi.fn();
    window.addEventListener('resize', onResize);
    render(<Harness open={false} />);

    await act(async () => {
      viewport.style.transform = 'translate(-40px, -20px) scale(1)';
      await Promise.resolve();
      await flushFrame();
    });

    expect(onResize).not.toHaveBeenCalled();
    window.removeEventListener('resize', onResize);
  });

  it('no-ops when there is no canvas viewport (e.g. isolated render)', () => {
    // No `.react-flow__viewport` in the DOM — the hook must mount without error.
    expect(() => render(<Harness open />)).not.toThrow();
  });
});
