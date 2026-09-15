// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AnnotationEntry } from '@web/spaces/canvas/annotation/AnnotationEntry';

const onDraft = vi.fn();
const onEdit = vi.fn();
const onDelete = vi.fn();

/**
 * Mount one entry with its rewrite box open.
 * @param editing - The draft text in the box.
 * @returns The entry's root and the box inside it.
 */
function openTheBox(editing = 'the shot before this one'): {
  entry: HTMLElement;
  box: HTMLElement;
} {
  render(
    <AnnotationEntry
      content='the shot before this one'
      createdAt={1}
      authorName='Ada'
      rights={{ canEdit: true, canDelete: true }}
      editing={editing}
      onEdit={onEdit}
      onDelete={onDelete}
      onDraft={onDraft}
      testId='entry'
    />,
  );
  return {
    entry: screen.getByTestId('entry'),
    box: screen.getByTestId('entry-input'),
  };
}

describe('the box that rewrites an entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the rewrite on Enter, the way the other two boxes do', () => {
    // One state machine, three uses (§6.2): the new-note box, the reply box
    // and this one share a transition table whose Enter cell reads "write it
    // and close". A reader learns Enter-writes-it from the box that creates
    // the note; the same key on the same sticky, in a box that looks the same,
    // means the same thing.
    const { box } = openTheBox();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onDraft).toHaveBeenCalledWith({ type: 'save' });
  });

  it('takes Shift+Enter as a line inside the rewrite', () => {
    const { box } = openTheBox();
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onDraft).not.toHaveBeenCalledWith({ type: 'save' });
  });

  it('keeps the Enter that confirms an IME candidate to itself', () => {
    const { box } = openTheBox('镜头');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('throws the rewrite away on Escape', () => {
    const { box } = openTheBox();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onDraft).toHaveBeenCalledWith({ type: 'escape' });
  });

  it('leaves a press alone once the box is closed', () => {
    // Nothing to protect then, and the press is how the reader selects the
    // words or reaches for the menu.
    render(
      <AnnotationEntry
        content='the shot before this one'
        createdAt={1}
        authorName='Ada'
        rights={{ canEdit: true, canDelete: true }}
        onEdit={onEdit}
        onDelete={onDelete}
        onDraft={onDraft}
        testId='settled'
      />,
    );
    const press = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    screen.getByTestId('settled').dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
  });
});
