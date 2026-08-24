// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import type { RenderResult } from '@testing-library/react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AudioLines } from 'lucide-react';

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
 * A slot with the real preview, at whatever fill state the caller passes.
 * @param overrides - Props overriding the defaults.
 * @returns The element tree to render.
 */
function slotTree(
  overrides: Partial<React.ComponentProps<typeof SlotTool>> = {},
): React.JSX.Element {
  return (
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
  );
}

/**
 * Renders a slot with the real preview and hovers it.
 * @param overrides - Props overriding the defaults.
 * @returns The slot button, after the hover delay has elapsed.
 */
async function hoverSlot(
  overrides: Partial<React.ComponentProps<typeof SlotTool>> = {},
): Promise<HTMLElement> {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(slotTree(overrides));
  const btn = screen.getByTestId('slot');
  fireEvent.pointerEnter(btn);
  await act(async () => {
    vi.advanceTimersByTime(1200);
  });
  return btn;
}

/**
 * Hovers a slot the way a mouse does and lets the open delay elapse. Radix's
 * HoverCard trigger opens off `pointerenter` (react-hover-card dist :91).
 * @param btn - The slot button.
 */
async function mouseOver(btn: HTMLElement): Promise<void> {
  fireEvent.pointerEnter(btn);
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
}

/**
 * Moves the pointer off a slot and lets any close animation settle.
 * @param btn - The slot button.
 */
async function mouseOut(btn: HTMLElement): Promise<void> {
  fireEvent.pointerLeave(btn);
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
}

/**
 * Re-renders the same slot at a different fill state and settles the timers.
 * @param view - The render result to update.
 * @param overrides - Props for the new state.
 */
async function refill(
  view: RenderResult,
  overrides: Partial<React.ComponentProps<typeof SlotTool>>,
): Promise<void> {
  view.rerender(slotTree(overrides));
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
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

  it('opens the card on an empty slot too, carrying the hint', async () => {
    // The empty slot's hover surface is the same card, saying what to go pick
    // — the job a tooltip used to do beside it (#1946).
    await hoverSlot();
    expect(screen.getByTestId('hover-preview-content')).toHaveTextContent(
      'Pick an audio clip',
    );
  });

  it('opens NO card for a filled slot that is disabled', async () => {
    await hoverSlot({
      pick: { kind: 'image', url: 'https://cdn/face.png' },
      disabled: true,
    });
    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
  });
});

describe('SlotTool — the card answers the pointer, never restored focus', () => {
  it('stays shut when the app focuses the slot after a pick ends', async () => {
    // A slot IS a pick trigger: ending a pick returns focus to it by testId
    // (CanvasSpace onExitPick over PICK_PURPOSE_UI), reached by Escape and by
    // the pick banner's Exit button. Radix HoverCard opens on focus and closes
    // only on pointer-leave or blur, so a card opened this way sits over the
    // canvas with the pointer nowhere near it until something else takes focus.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(slotTree({ pick: { kind: 'audio', url: 'https://cdn/voice.m4a' } }));

    screen.getByTestId('slot').focus();
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
  });

  it('stays shut on a focused empty slot too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(slotTree({}));

    screen.getByTestId('slot').focus();
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
  });
});

describe('SlotTool — nothing pops on a slot the pointer has left', () => {
  const AUDIO = { kind: 'audio', url: 'https://cdn/voice.m4a' } as const;

  it('stays shut after a filled slot is hovered, left, and then cleared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(slotTree({ pick: AUDIO }));
    const btn = screen.getByTestId('slot');

    // The gesture this change exists for: hovering a filled slot to preview it.
    await mouseOver(btn);
    await mouseOut(btn);

    // The slot empties — a collaborator clearing it, or an undo. The pointer is
    // elsewhere by now, so nothing about this slot should appear.
    await refill(view, {});

    expect(screen.queryByText('Pick an audio clip')).toBeNull();
  });

  it('stays shut after an empty slot is hovered, left, filled, and cleared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(slotTree({}));
    const btn = screen.getByTestId('slot');

    await mouseOver(btn);
    expect(screen.getByText('Pick an audio clip')).toBeInTheDocument();
    await mouseOut(btn);

    await refill(view, { pick: AUDIO });
    await refill(view, {});

    expect(screen.queryByText('Pick an audio clip')).toBeNull();
  });
});
