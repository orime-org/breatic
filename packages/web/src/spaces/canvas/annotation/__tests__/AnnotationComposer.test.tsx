// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AnnotationComposer } from '@web/spaces/canvas/annotation/AnnotationComposer';

const onCommit = vi.fn();
const onClose = vi.fn();

/**
 * Mount the box that opens where somebody clicked.
 * @returns The textarea it focuses.
 */
function open(): HTMLElement {
  render(<AnnotationComposer onCommit={onCommit} onClose={onClose} />);
  return screen.getByTestId('annotation-composer-input');
}

describe('the box that opens at the drop point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands the words over on Enter and closes', () => {
    const box = open();
    fireEvent.change(box, { target: { value: 'a cooler shot here' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('a cooler shot here');
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the Enter that confirms an IME candidate to itself', () => {
    const box = open();
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('takes Shift+Enter as a line, not as a submit', () => {
    const box = open();
    fireEvent.change(box, { target: { value: 'first line' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('writes nothing for a body that is only whitespace', () => {
    // Yjs never holds a note with a blank body (§6.3), so a blank Enter is
    // not a note — the box stays up and the caret stays where it was.
    const box = open();
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('throws the words away on Escape', () => {
    const box = open();
    fireEvent.change(box, { target: { value: 'never mind' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('throws them away on blur too — nothing here existed yet', () => {
    const box = open();
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.blur(box);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('puts the caret in the box without being asked', () => {
    // Somebody pressed the tool and then clicked a spot. Typing is the next
    // thing they mean to do.
    expect(open()).toHaveFocus();
  });
});
