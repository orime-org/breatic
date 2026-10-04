// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Typing `@` in the chat box picks one of the attached items and puts a
// reference to it in the words (inner design 2026-10-04 §2, A1–A3, A6).

import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { attachmentMarker } from '@breatic/shared';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import type { TrayItem } from '@web/stores/chat-attachments';

const cover: TrayItem = {
  id: 'a1',
  name: 'cover.png',
  type: 'image',
  status: 'ready',
  chip: { id: 'a1', type: 'image', name: 'cover.png', data_snapshot: { url: 'u' } },
};
const brief: TrayItem = {
  id: 'a2',
  name: 'brief.pdf',
  type: 'text',
  status: 'ready',
  chip: { id: 'a2', type: 'text', name: 'brief.pdf', data_snapshot: { text: 't' } },
};
const pending: TrayItem = { id: 'a3', name: 'clip.mp4', type: 'video', status: 'uploading' };

type Props = Parameters<typeof ChatComposer>[0];

/**
 * Renders the box with the given props; the rest are spies.
 * @param props - What the test cares about.
 * @returns The spies and a way to re-render.
 */
function setup(props: Partial<Props> = {}): {
  onChange: ReturnType<typeof vi.fn>;
  onSubmit: ReturnType<typeof vi.fn>;
  rerender: (next: Partial<Props>) => void;
} {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const base: Props = { draft: '', onChange, onSubmit, onAbort: vi.fn(), ...props };
  const view = render(<ChatComposer {...base} />);
  return {
    onChange,
    onSubmit,
    rerender: (next) => view.rerender(<ChatComposer {...base} {...next} />),
  };
}

/**
 * The editor behind the box.
 * @returns The editor.
 */
function box(): Editor {
  const el = screen.getByTestId('chat-composer-textarea') as unknown as { editor?: Editor };
  if (!el.editor) throw new Error('no editor on the box');
  return el.editor;
}

/**
 * Types the way a keystroke does.
 * @param text - What to type.
 */
function type(text: string): void {
  act(() => {
    const e = box();
    e.view.dispatch(e.state.tr.insertText(text));
  });
}

/**
 * Presses a key in the box.
 * @param key - The key.
 */
function press(key: string): void {
  act(() => {
    box().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('@ in the chat box', () => {
  it('lists the attached items that are ready', async () => {
    setup({ attachments: [cover, pending] });
    type('@');

    await waitFor(() => expect(screen.getByTestId('reference-mention-option-a1')).toHaveTextContent('cover.png'));
    expect(screen.queryByTestId('reference-mention-option-a3')).toBeNull();
  });

  it('says so when nothing is ready to pick', async () => {
    setup({ attachments: [pending] });
    type('@');

    await waitFor(() => expect(screen.getByTestId('reference-mention-empty')).toBeInTheDocument());
  });

  it('puts a block with the name in the box and its marker in the draft', async () => {
    const { onChange } = setup({ attachments: [cover, brief] });
    type('see @');
    await waitFor(() => screen.getByTestId('reference-mention-option-a2'));
    press('ArrowDown');
    press('Enter');

    expect(screen.getByTestId('chat-reference')).toHaveTextContent('brief.pdf');
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining(attachmentMarker('a2')));
    expect(onChange.mock.lastCall?.[0]).not.toContain('@ ');
  });

  it('does not send on the Enter that picks', async () => {
    const { onSubmit } = setup({ draft: 'hi', attachments: [cover] });
    act(() => box().commands.focus('end'));
    type(' @');
    await waitFor(() => screen.getByTestId('reference-mention-option-a1'));
    press('Enter');

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('takes the block out the moment its attachment is removed', () => {
    const draft = `look ${attachmentMarker('a1')} here`;
    const { onChange, rerender } = setup({ draft, attachments: [cover] });
    expect(screen.getByTestId('chat-reference')).toBeInTheDocument();

    rerender({ draft, attachments: [] });

    expect(screen.queryByTestId('chat-reference')).toBeNull();
    expect(onChange.mock.lastCall?.[0]).not.toContain(attachmentMarker('a1'));
  });

  it('keeps the block and shows the new name when the attachment is replaced', () => {
    const draft = `look ${attachmentMarker('a1')}`;
    const { rerender } = setup({ draft, attachments: [cover] });

    rerender({ draft, attachments: [{ ...cover, name: 'cover-v2.png' }] });

    expect(screen.getByTestId('chat-reference')).toHaveTextContent('cover-v2.png');
  });

  it('does not open the list when the draft is written from outside', () => {
    const { rerender } = setup({ draft: '', attachments: [cover] });

    rerender({ draft: 'ask about @' });

    expect(box().state.doc.textContent).toBe('ask about @');
    expect(screen.queryByTestId('reference-mention-option-a1')).toBeNull();
  });

  it('counts a reference as one character against the limit', () => {
    setup({ draft: `${attachmentMarker('a1')}${'y'.repeat(9_998)}`, attachments: [cover] });
    act(() => box().commands.focus('end'));
    type('z');

    expect(box().state.doc.textContent.length).toBe(10_000);
  });
});
