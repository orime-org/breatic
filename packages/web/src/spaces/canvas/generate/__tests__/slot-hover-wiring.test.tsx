// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * That a filled slot's hover preview is actually WIRED (#1946).
 *
 * Kept apart from `generate-tools.test.tsx`, which stubs `HoverPreview` out to
 * read the props the slot declares. That stub is the right tool for "what does
 * the slot say it holds" and the wrong one for "does hovering open anything":
 * it renders a plain div, so it never exercises Radix's `asChild` cloning —
 * and a wrapper that swallowed those cloned props left every filled slot
 * unable to open its card while the whole suite stayed green (Gate 2 round 2).
 *
 * So this file uses the REAL HoverPreview and asks the only question that
 * catches a broken trigger chain: after a pointer enter, is the card there?
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AudioLines } from 'lucide-react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { SlotTool } from '@web/spaces/canvas/generate/generate-tools';

// The viewport follower reaches for the ReactFlow DOM, which is not mounted
// here; the wiring under test is unrelated to it.
vi.mock('@web/spaces/canvas/generate/use-follow-canvas-viewport', () => ({
  useFollowCanvasViewport: () => {},
}));

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Renders a slot with the real preview and hovers it.
 * @param overrides - Props overriding the defaults.
 * @returns The slot button, after the hover delay has elapsed.
 */
async function hoverSlot(
  overrides: Partial<React.ComponentProps<typeof SlotTool>> = {},
): Promise<HTMLElement> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(
    <TooltipProvider delayDuration={100}>
      <SlotTool
        testId='slot'
        thumbnailTestId='slot-thumb'
        clearTestId='slot-clear'
        Icon={AudioLines}
        onPick={() => {}}
        onClear={() => {}}
        active={false}
        disabled={false}
        clearLabel='Remove driving audio'
        label='Driving audio'
        tip='Pick an audio clip'
        {...overrides}
      />
    </TooltipProvider>,
  );
  const btn = screen.getByTestId('slot');
  fireEvent.pointerEnter(btn);
  await act(async () => {
    vi.advanceTimersByTime(1200);
  });
  return btn;
}

describe('SlotTool — hovering a filled slot really opens its preview', () => {
  it('opens the card for an audio pick', async () => {
    await hoverSlot({ pick: { kind: 'audio', url: 'https://cdn/voice.m4a' } });
    expect(screen.getByTestId('hover-preview-content')).toBeInTheDocument();
  });

  it('opens the card for an image pick', async () => {
    await hoverSlot({
      pick: {
        kind: 'image',
        url: 'https://cdn/face.png',
        thumbnail: 'https://cdn/face.png',
      },
    });
    expect(screen.getByTestId('hover-preview-content')).toBeInTheDocument();
  });

  it('opens NO card for an empty slot', async () => {
    await hoverSlot();
    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
  });

  it('opens NO card for a filled slot that is disabled', async () => {
    await hoverSlot({
      pick: { kind: 'image', url: 'https://cdn/face.png' },
      disabled: true,
    });
    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
  });
});
