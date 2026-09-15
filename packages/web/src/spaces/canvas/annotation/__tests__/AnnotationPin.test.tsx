// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AnnotationPin } from '@web/spaces/canvas/annotation/AnnotationPin';
import { PIN_SCREEN_SIZE } from '@web/spaces/canvas/annotation/pin-geometry';

const onOpen = vi.fn();

/**
 * Draw one pin.
 * @param props - What differs from a plain unanswered note by somebody named.
 * @returns The pin element.
 */
function drawPin(props: Partial<React.ComponentProps<typeof AnnotationPin>> = {}): HTMLElement {
  render(
    <AnnotationPin
      authorName='Ada Lovelace'
      avatarUrl={null}
      replyCount={0}
      zoom={1}
      onOpen={onOpen}
      {...props}
    />,
  );
  return screen.getByTestId('annotation-pin');
}

describe('the pin a collapsed annotation is', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wears the face of whoever raised the note', () => {
    // Fixed on the author for good: the last person to reply changes with
    // every reply, so the same pin would keep changing face (§8.7.1).
    drawPin();
    expect(screen.getByTestId('annotation-pin-avatar')).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('keeps its size and shape while the name is still being resolved', () => {
    // `useUserProfiles` answers with an empty map while in flight, and for a
    // soft-deleted account it never answers at all. Neither is a reason for a
    // pin to go missing or to change shape — where the note is matters more
    // than who wrote it.
    drawPin({ authorName: '' });
    expect(screen.getByTestId('annotation-pin-avatar')).toBeInTheDocument();
  });

  it('carries the reply count, and only when somebody has replied', () => {
    drawPin({ replyCount: 3 });
    expect(screen.getByTestId('annotation-pin-count')).toHaveTextContent('3');
  });

  it('draws no count on a note nobody has answered', () => {
    drawPin({ replyCount: 0 });
    expect(screen.queryByTestId('annotation-pin-count')).toBeNull();
  });

  it('shows the lock when this note or its group is frozen', () => {
    drawPin({ locked: true });
    expect(screen.getByTestId('annotation-pin-lock')).toBeInTheDocument();
  });

  it('draws no lock on a note that is not frozen', () => {
    drawPin();
    expect(screen.queryByTestId('annotation-pin-lock')).toBeNull();
  });

  it('opens the sticky when clicked', async () => {
    const user = userEvent.setup();
    await user.click(drawPin());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens the sticky from the keyboard', async () => {
    // xyflow's own node key handling calls `handleNodeClick` on Enter and
    // never `onClick` (@xyflow/react@12.11.2 index.mjs:2282-2295), so Tab to a
    // pin and Enter would only select it — and three of this task's four verbs
    // (reply, edit, delete) need the sticky open first (§8.7.3, D1).
    const user = userEvent.setup();
    const pin = drawPin();
    pin.focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('is sized in flow pixels, so what xyflow measures is what the reader sees', () => {
    // The box is the pin. `offsetWidth` is the only number xyflow reads
    // (@xyflow/system@0.0.79:854), so marquee selection, group geometry, the
    // minimap and the sticky's anchor all follow for free.
    const pin = drawPin({ zoom: 0.5 });
    expect(pin.style.width).toBe(`${PIN_SCREEN_SIZE / 0.5}px`);
    expect(pin.style.height).toBe(`${PIN_SCREEN_SIZE / 0.5}px`);
  });
});
