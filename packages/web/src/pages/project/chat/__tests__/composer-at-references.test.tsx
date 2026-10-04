// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Typing `@` in the chat box picks one of the attached items and puts a
// reference to it in the words.

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import { attachmentMarker, getLocale, messageLength, setLocale } from '@breatic/shared';

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
  const el = screen.getByTestId('chat-composer-box') as unknown as { editor?: Editor };
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
    expect(onChange.mock.lastCall?.[0]).toBe('look  here');
  });

  it('does not let an undo bring back a block whose attachment is gone', () => {
    const draft = `look ${attachmentMarker('a1')} here`;
    const { rerender } = setup({ draft, attachments: [cover] });
    act(() => {
      const e = box();
      let at = -1;
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'referenceMention') at = pos;
      });
      e.view.dispatch(e.state.tr.delete(at, at + 1));
    });
    rerender({ draft: 'look  here', attachments: [] });

    act(() => {
      const e = box();
      undo(e.state, e.view.dispatch);
    });

    expect(screen.queryByTestId('chat-reference')).toBeNull();
  });

  it('keeps the block and shows the new name when the attachment is replaced', () => {
    const draft = `look ${attachmentMarker('a1')}`;
    const { rerender } = setup({ draft, attachments: [cover] });

    rerender({ draft, attachments: [{ ...cover, name: 'cover-v2.png' }] });

    expect(screen.getByTestId('chat-reference')).toHaveTextContent('cover-v2.png');
  });

  it('does not open the list when the draft is written from outside', async () => {
    const { rerender } = setup({ draft: '', attachments: [cover] });
    act(() => box().commands.focus('end'));

    rerender({ draft: 'ask about @' });

    expect(box().state.doc.textContent).toBe('ask about @');
    // The list is built for the `@` all the same; what matters is that the
    // reader is not shown one they never asked for.
    expect(await screen.findByTestId('reference-mention-option-a1')).not.toBeVisible();
  });

  it('counts a reference as one character against the limit', () => {
    // Nine thousand nine hundred and ninety-nine as the reader sees it: the
    // block counts once, its marker is far longer.
    const { onChange } = setup({ draft: `y ${attachmentMarker('a1')} ${'y'.repeat(9_995)}`, attachments: [cover] });
    act(() => box().commands.focus('end'));
    type('z');
    type('q');

    const last = String(onChange.mock.lastCall?.[0]);
    expect(last.endsWith('z')).toBe(true);
    expect(messageLength([cover], last)).toBe(10_000);
  });

  it('sends on Enter once the list was hidden by a click elsewhere', async () => {
    const onChange = vi.fn();
    const { onSubmit, rerender } = setup({ attachments: [cover], onChange });
    act(() => box().commands.focus('end'));
    type('hi @co');
    await waitFor(() => screen.getByTestId('reference-mention-option-a1'));
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(screen.getByTestId('reference-mention-option-a1')).not.toBeVisible();
    rerender({ draft: String(onChange.mock.lastCall?.[0]), attachments: [cover] });

    press('Enter');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(box().state.doc.childCount).toBe(1);
  });

  it('shows each row with the icon of its kind', async () => {
    setup({ attachments: [cover] });
    type('@');

    const row = await screen.findByTestId('reference-mention-option-a1');
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row).toHaveTextContent(/^cover\.png$/);
  });

  it('names an attachment with no name after its kind, never a node count', async () => {
    const bare: TrayItem = {
      id: 'b1',
      name: '',
      type: 'image',
      status: 'ready',
      chip: { id: 'b1', type: 'image', name: '', data_snapshot: { url: 'u' } },
    };
    setup({ attachments: [bare] });
    type('@');

    const row = await screen.findByTestId('reference-mention-option-b1');
    expect(row).toHaveTextContent('Image');
    expect(row).not.toHaveTextContent(/node/i);
  });

  it('pastes a reference block for something not attached as plain words', () => {
    setup({ attachments: [cover] });
    act(() => {
      box().commands.focus();
      box().view.pasteHTML('make <span data-reference-mention="" data-source-id="node-1"></span> run');
    });

    expect(screen.queryByTestId('chat-reference')).toBeNull();
    expect(box().state.doc.textContent).toBe('make run');
  });

  it('cuts a paste holding a block down to the room left instead of refusing it', () => {
    const { onChange } = setup({ draft: 'y'.repeat(9_998), attachments: [cover] });
    act(() => {
      box().commands.focus('end');
      box().view.pasteHTML('ab<span data-reference-mention="" data-source-id="a1">cover.png</span>');
    });

    expect(String(onChange.mock.lastCall?.[0])).toBe(`${'y'.repeat(9_998)}ab`);
  });

  it('brings an open list up to date when an attachment becomes ready', async () => {
    const { rerender } = setup({ attachments: [pending] });
    act(() => box().commands.focus('end'));
    type('@');
    await waitFor(() => expect(screen.getByTestId('reference-mention-empty')).toBeVisible());

    rerender({ attachments: [{ ...pending, status: 'ready', chip: { id: 'a3', type: 'video', name: 'clip.mp4', data_snapshot: {} } }] });

    await waitFor(() => expect(screen.getByTestId('reference-mention-option-a3')).toBeVisible());
  });

  it('renames a block in the language just picked', async () => {
    const before = getLocale();
    const bare: TrayItem = {
      id: 'b1',
      name: '',
      type: 'image',
      status: 'ready',
      chip: { id: 'b1', type: 'image', name: '', data_snapshot: { url: 'u' } },
    };
    try {
      setup({ draft: `see ${attachmentMarker('b1')}`, attachments: [bare] });
      const english = screen.getByTestId('chat-reference').textContent;

      await act(async () => {
        await setLocale('zh-CN');
      });

      await waitFor(() => expect(screen.getByTestId('chat-reference').textContent).not.toBe(english));
    } finally {
      await act(async () => {
        await setLocale(before);
      });
    }
  });

  it('cuts a paste to the room left, counting an emoji as the two it costs', () => {
    const { onChange } = setup({ draft: 'y'.repeat(9_997) });
    act(() => box().commands.focus('end'));
    fireEvent.paste(box().view.dom, {
      clipboardData: { files: [], getData: (type: string) => (type === 'text/plain' ? '\u{1F600}ok' : '') },
    });

    expect(onChange).toHaveBeenLastCalledWith(`${'y'.repeat(9_997)}\u{1F600}o`);
  });

  it('keeps a paste to itself while it is read-only', () => {
    const onPasteCanvas = vi.fn();
    const outside = vi.fn();
    document.addEventListener('paste', outside);
    try {
      setup({ turnPhase: 'sending', onPasteCanvas });
      fireEvent.paste(box().view.dom, {
        clipboardData: { files: [], getData: (type: string) => (type === 'text/plain' ? '__breatic_canvas_nodes__:[]' : '') },
      });
    } finally {
      document.removeEventListener('paste', outside);
    }

    expect(outside).not.toHaveBeenCalled();
    expect(onPasteCanvas).not.toHaveBeenCalled();
  });

  it('takes a block out with one Backspace', () => {
    setup({ draft: `see ${attachmentMarker('a1')}`, attachments: [cover] });
    act(() => box().commands.focus('end'));
    press('Backspace');

    expect(screen.queryByTestId('chat-reference')).toBeNull();
  });

  it('leaves the last conversation\'s typing out of undo once the conversation changes', () => {
    const { onChange, rerender } = setup({ conversationId: 'c1', draft: '' });
    type('abc');
    const typed = String(onChange.mock.lastCall?.[0]);

    // The next conversation's draft happens to read the same.
    rerender({ conversationId: 'c2', draft: typed });
    act(() => {
      const e = box();
      undo(e.state, e.view.dispatch);
    });

    expect(box().state.doc.textContent).toBe('abc');
  });

  it('names a pasted block after its attachment in the language now on screen', async () => {
    const before = getLocale();
    const bare: TrayItem = {
      id: 'b1',
      name: '',
      type: 'image',
      status: 'ready',
      chip: { id: 'b1', type: 'image', name: '', data_snapshot: { url: 'u' } },
    };
    try {
      setup({ attachments: [bare] });
      await act(async () => {
        await setLocale('zh-CN');
      });
      act(() => {
        box().commands.focus();
        box().view.pasteHTML('<span data-reference-mention="" data-source-id="b1">Image</span>');
      });

      expect(screen.getByTestId('chat-reference').textContent).not.toBe('Image');
      expect(screen.getByTestId('chat-reference').textContent).not.toBe('');
    } finally {
      await act(async () => {
        await setLocale(before);
      });
    }
  });

  it('shows the current name on a block an undo brings back', () => {
    const draft = `look ${attachmentMarker('a1')}`;
    const { rerender } = setup({ draft, attachments: [cover] });
    act(() => {
      const e = box();
      let at = -1;
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'referenceMention') at = pos;
      });
      e.view.dispatch(e.state.tr.delete(at, at + 1));
    });
    rerender({ draft: 'look ', attachments: [{ ...cover, name: 'cover-v2.png' }] });

    act(() => {
      const e = box();
      undo(e.state, e.view.dispatch);
    });

    expect(screen.getByTestId('chat-reference')).toHaveTextContent('cover-v2.png');
  });

  it('copies a block as its name in plain text', () => {
    setup({ draft: `look at ${attachmentMarker('a1')} please`, attachments: [cover] });
    act(() => box().commands.selectAll());
    const written = new Map<string, string>();
    fireEvent.copy(box().view.dom, {
      clipboardData: { clearData: () => written.clear(), setData: (type: string, value: string) => written.set(type, value) },
    });

    expect(written.get('text/plain')).toBe('look at cover.png please');
  });
});
