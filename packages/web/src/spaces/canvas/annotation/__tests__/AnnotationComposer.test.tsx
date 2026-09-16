// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AnnotationComposer } from '@web/spaces/canvas/annotation/AnnotationComposer';
import { NOTE_BOX_MAX_HEIGHT } from '@web/spaces/canvas/annotation/caps';

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
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
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

  it('stays open when Escape only dismisses an IME candidate window', () => {
    const box = open();
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue('镜头');
  });

  it('leaves the keystroke to the IME that reports owning it', () => {
    // The platform says so on the keystroke itself. Reading it there is what
    // the canvas, the crop overlay and the chat composer all do, and it
    // cannot fall out of step with the IME the way a stored copy can.
    const box = open();
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue('镜头');
  });

  it('throws them away on blur too — nothing here existed yet', () => {
    const box = open();
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.blur(box);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps them when the whole window loses focus', () => {
    // Leaving the browser is not "I am done here". The box discards on blur
    // because a press elsewhere is the only ending it has, and A2 names the
    // two ways out as Escape and clicking elsewhere — switching to another
    // application is neither, and what is in this box exists nowhere else, so
    // there is nothing to undo. `relatedTarget` cannot tell a window switch
    // from a click on something unfocusable, so the question is whether the
    // document still has focus at all. Same criterion the text node's editor
    // asks (`TextNodeEditor.tsx`).
    const box = open();
    fireEvent.change(box, { target: { value: 'half a thought' } });
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    fireEvent.blur(box);

    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue('half a thought');
    hasFocus.mockRestore();
  });

  it('keeps them when the blur is an IME candidate window opening', () => {
    // §6.2's one criterion covers every way out of this box, and a blur is
    // the way out that carries no answer of its own — a keystroke says
    // `isComposing`, a focus loss says nothing. Some engines take focus to
    // the candidate window mid-composition, and taking that as "the person
    // is done" would drop what they are in the middle of typing.
    const box = open();
    fireEvent.compositionStart(box);
    fireEvent.change(box, { target: { value: '镜头' } });
    fireEvent.blur(box);
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue('镜头');
    // And once the IME hands the words back, the box is ordinary again.
    fireEvent.compositionEnd(box);
    fireEvent.blur(box);
    expect(onClose).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps the draft when the press lands on the box own padding', () => {
    // The shell is 8px of padding and a border around the textarea, and a
    // press on any of it moves focus to <body>, which used to blur the box
    // and throw the words away. Repositioning the caret by clicking near the
    // text is the ordinary way to miss by 4px.
    const box = open();
    fireEvent.change(box, { target: { value: 'make this slower' } });
    const shell = screen.getByTestId('annotation-composer');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    shell.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets the press through when it lands on the box itself', () => {
    // The textarea is the one thing in here allowed to take focus.
    const box = open();
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    box.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
  });

  it('puts the caret in the box without being asked', () => {
    // Somebody pressed the tool and then clicked a spot. Typing is the next
    // thing they mean to do.
    expect(open()).toHaveFocus();
  });

  it('never scrolls itself -- the panel around it does', () => {
    // A textarea left to scroll itself draws the browser's scrollbar, which
    // is a different shape in every engine, and every visible scroller in
    // this app belongs to `ScrollArea` (packages/web/CLAUDE.md). Measured on
    // a real board before this: all three of the note's boxes scrolled
    // themselves, against the chat composer next door, which does not.
    const box = open();
    const viewport = screen
      .getByTestId('annotation-composer-scroller')
      .querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    // The cap belongs on the element that scrolls, not on the Root, which
    // clips instead.
    expect(viewport?.className).toContain(NOTE_BOX_MAX_HEIGHT);
    expect(
      viewport?.querySelector('[data-testid="annotation-composer-input"]'),
    ).not.toBeNull();
    // Always as tall as what is written, so there is nothing for it to
    // scroll past.
    expect(box.style.height).not.toBe('');
  });

  it('claims the wheel for the draft', () => {
    // Round 8, measured on a board: with 216px of draft below the cap and
    // 208px of room above the caret, a wheel over the box left its scrollTop
    // on 208 and panned the canvas 60px instead. `nowheel` is what hands the
    // wheel to the words, and it is on every other scroller in this feature.
    open();
    expect(
      screen.getByTestId('annotation-composer-scroller').className,
    ).toContain('nowheel');
  });
});
