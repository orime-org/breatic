// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A join's clip row with the real hover card: hovering a clip previews it as a
 * generation slot does, the add tile's tip rides the same card, and no card
 * opens or stays while a tile is being dragged.
 */

import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '@breatic/shared';
import type { MiniToolSlotValue } from '@breatic/shared/mini-tools';

import { joinToolFor } from '@web/spaces/canvas/mini-tool/join';
import { JoinClipRow } from '@web/spaces/canvas/mini-tool/JoinClipRow';
import { renderWithTooltips } from '@web/test-utils/render-with-tooltips';

// The viewport follower reaches for the ReactFlow DOM, which is not mounted here.
vi.mock('@web/spaces/canvas/generate/use-follow-canvas-viewport', () => ({
  useFollowCanvasViewport: () => {},
}));

afterEach(() => {
  vi.useRealTimers();
});

const SLOT = joinToolFor('audio')?.slots.find((slot) => slot.many);

/**
 * A clip as a pick holds it.
 * @param id - Its node id.
 * @returns The slot value.
 */
function clip(id: string): MiniToolSlotValue {
  return { url: `https://cdn/${id}.mp3`, duration: 5, nodeId: id, name: id.toUpperCase() } as MiniToolSlotValue;
}

/** Mounts the row on three clips, with fake timers for the card's delays. */
function mount(): void {
  if (SLOT === undefined) throw new Error('no audio join slot');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderWithTooltips(
    <JoinClipRow slot={SLOT} clips={[clip('a'), clip('b'), clip('c')]} cap={5} picking={false} onPick={() => {}} onMove={() => {}} onRemove={() => {}} />,
  );
}

/**
 * Lets the card's open or close delay pass.
 */
async function wait(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1200);
  });
}

/**
 * The grab area of a clip's tile, which the hover card hangs on.
 * @param id - The clip's node id.
 * @returns The element.
 */
function grab(id: string): HTMLElement {
  return screen.getByTestId(`join-tile-${id}`).querySelector('.cursor-grab') as HTMLElement;
}

describe('JoinClipRow — hover cards', () => {
  it('previews a hovered clip with its player', async () => {
    mount();
    fireEvent.pointerEnter(grab('b'));
    await wait();
    const card = screen.getByTestId('hover-preview-content');
    expect(card.querySelector('audio')).not.toBeNull();
  });

  it('shows the add tile\'s tip on the hover card, with no tooltip of its own', async () => {
    mount();
    fireEvent.pointerEnter(screen.getByTestId('join-add'));
    await wait();
    expect(screen.getByTestId('hover-preview-content')).toHaveTextContent(t(SLOT?.bannerKey ?? 'missing'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes the card when the tile under it starts to drag, and opens none on another tile while it drags', async () => {
    mount();
    const tile = grab('a');
    fireEvent.pointerEnter(tile);
    await wait();
    expect(screen.getByTestId('hover-preview-content')).toBeInTheDocument();
    fireEvent.pointerDown(tile, { button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { clientX: 40, clientY: 10 });
    await wait();
    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
    fireEvent.pointerEnter(grab('b'));
    await wait();
    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
    // Drop, and let dnd-kit take its document listeners down on its own timer:
    // its click blocker would otherwise swallow every click in later files.
    fireEvent.pointerUp(document, { button: 0, isPrimary: true, clientX: 40, clientY: 10 });
    await wait();
  });
});
