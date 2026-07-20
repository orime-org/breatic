// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ImageModeToggle } from '@web/spaces/canvas/generate/ImageModeToggle';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import { panCanvasViewport } from '@web/spaces/canvas/generate/__tests__/canvas-viewport-test-utils';

/**
 * Renders the mode picker with the given active mode.
 * @param value - The active generation mode.
 * @param onChange - The change handler (defaults to a no-op).
 * @returns The render result.
 */
function setup(
  value: ImageGenMode,
  onChange: (mode: ImageGenMode) => void = () => {},
): ReturnType<typeof render> {
  return render(<ImageModeToggle value={value} onChange={onChange} />);
}

describe('ImageModeToggle — the t2i / i2i mode popover', () => {
  it('shows the active mode label (English, not localized) on the trigger', () => {
    setup('i2i');
    expect(screen.getByTestId('generate-mode-trigger')).toHaveTextContent(
      'Image to Image',
    );
  });

  it('opens the popover to reveal both mode options', () => {
    setup('t2i');
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    expect(screen.getByTestId('generate-mode-t2i')).toBeInTheDocument();
    expect(screen.getByTestId('generate-mode-i2i')).toBeInTheDocument();
  });

  it('marks the active mode option as selected (aria-pressed)', () => {
    setup('i2i');
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    expect(screen.getByTestId('generate-mode-i2i')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('generate-mode-t2i')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  // Popover item consistency (spec §9.4, user-ratified: copy the language /
  // theme switcher exactly). Their pattern is a gap-0.5 column of ghost
  // Buttons — the gap is what keeps the hover and selected highlights from
  // gluing into one block (user's screenshot). role=listbox / <li> were a
  // semantics lie (no listbox keyboard model was implemented) — the plain
  // button column matches LangSwitcher / ThemeToggle.
  it('lays the options out like the language/theme switchers (gap column, no fake listbox)', () => {
    setup('t2i');
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    const option = screen.getByTestId('generate-mode-i2i');
    expect(option.parentElement?.className).toContain('gap-0.5');
    expect(option.className).toContain('py-1.5');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  it('fires onChange with the picked mode when switching to the other', () => {
    const onChange = vi.fn();
    setup('t2i', onChange);
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    fireEvent.click(screen.getByTestId('generate-mode-i2i'));
    expect(onChange).toHaveBeenCalledWith('i2i');
  });

  it('does not fire onChange when picking the already-active mode', () => {
    // Avoids a redundant setNodeMode write (which would reset the model/params).
    const onChange = vi.fn();
    setup('t2i', onChange);
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    fireEvent.click(screen.getByTestId('generate-mode-t2i'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables the trigger (cannot open) when the catalog is empty', () => {
    // Set while the model catalog is empty (loading / failed) so a switch can't
    // resolve an empty model and clobber the node's stored model/params.
    const onChange = vi.fn();
    render(<ImageModeToggle value='t2i' onChange={onChange} disabled />);
    const trigger = screen.getByTestId('generate-mode-trigger');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('generate-mode-i2i')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  // #1796: the mode toggle is a Radix Popover whose Floating-UI auto-update does
  // not react to the ReactFlow viewport's CSS-transform pan/zoom, so an open
  // popover drifted off its trigger. It now calls useFollowCanvasViewport(open)
  // to follow the node like the ratio / camera pickers.
  describe('follows the canvas viewport while open (#1796)', () => {
    afterEach(() => {
      document
        .querySelectorAll('.react-flow__viewport')
        .forEach((n) => n.remove());
    });

    it('nudges a reposition on a viewport transform ONLY while open', async () => {
      const viewport = document.createElement('div');
      viewport.className = 'react-flow__viewport';
      viewport.style.transform = 'translate(0px, 0px) scale(1)';
      document.body.appendChild(viewport);
      const onResize = vi.fn();
      window.addEventListener('resize', onResize);
      try {
        setup('t2i');
        // Closed → inert: a pan must not dispatch a reposition.
        await panCanvasViewport(viewport, 'translate(-10px, 0px) scale(1)');
        expect(onResize).not.toHaveBeenCalled();
        // Open the popover, then pan → the hook nudges a resize.
        fireEvent.click(screen.getByTestId('generate-mode-trigger'));
        await panCanvasViewport(viewport, 'translate(-40px, -20px) scale(1)');
        expect(onResize).toHaveBeenCalled();
      } finally {
        window.removeEventListener('resize', onResize);
      }
    });
  });
});
