// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AnnotationPin } from '@web/spaces/canvas/annotation/AnnotationPin';
import { PIN_SCREEN_SIZE } from '@web/spaces/canvas/annotation/pin-geometry';

const onToggle = vi.fn();

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
      onToggle={onToggle}
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

  it('holds the face at one size whether or not the name has landed', () => {
    // The ground and the avatar are the same circle; a reader watching a board
    // load should see a face appear, not the pin's middle change size.
    drawPin({ authorName: '' });
    const ground = screen.getByTestId('annotation-pin-ground');
    expect(screen.queryByTestId('annotation-pin-avatar')).toBeNull();
    expect(ground.className).toContain('size-5');
  });

  it('names nobody while the name is still being resolved', () => {
    // §8.7.1 asks for a plain ground here, holding still. The initials rule
    // answers '?' for a blank name, which would put a question mark on every
    // pin on the board until `GET /users` lands, and for good on a note whose
    // author has been deleted.
    drawPin({ authorName: '' });
    expect(screen.queryByText('?')).toBeNull();
  });

  it('keeps its size and shape while the name is still being resolved', () => {
    // `useUserProfiles` answers with an empty map while in flight, and for a
    // soft-deleted account it never answers at all. Neither is a reason for a
    // pin to go missing or to change shape — where the note is matters more
    // than who wrote it.
    const pin = drawPin({ authorName: '' });
    expect(screen.getByTestId('annotation-pin-ground')).toBeInTheDocument();
    expect(pin.style.width).toBe(`${PIN_SCREEN_SIZE}px`);
  });

  it('carries the reply count, and only when somebody has replied', () => {
    drawPin({ replyCount: 3 });
    expect(screen.getByTestId('annotation-pin-count')).toHaveTextContent('3');
  });

  it('draws no count on a note nobody has answered', () => {
    drawPin({ replyCount: 0 });
    expect(screen.queryByTestId('annotation-pin-count')).toBeNull();
  });

  it('shows the lock when this note is frozen', () => {
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
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('opens the sticky from the keyboard', async () => {
    // The button answers Enter and Space itself, which is what makes the pin
    // reachable without a pointer at all. That it is the ONLY stop on a note —
    // xyflow's node wrapper hands its focusability away — is a wiring fact and
    // is measured on a board (`canvas-annotation.spec.ts`, the keyboard case).
    const user = userEvent.setup();
    const pin = drawPin();
    pin.focus();
    await user.keyboard('{Enter}');
    expect(onToggle).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(2);
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
