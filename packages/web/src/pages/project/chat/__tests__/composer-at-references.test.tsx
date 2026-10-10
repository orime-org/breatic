// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Typing `@` in the chat box picks one of the attached items and puts a
// reference to it in the words.

import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { attachmentMarker, getLocale, messageLength, setLocale } from '@breatic/shared';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';
import { CLIPBOARD_VERSION, serializeClipboard } from '@web/spaces/canvas/node-clipboard';
import type { TrayItem } from '@web/stores/chat-attachments';

/** The canvas's clipboard text for one picture node. */
const CANVAS_TEXT = serializeClipboard({
  version: CLIPBOARD_VERSION,
  picked: ['x'],
  nodes: [{ id: 'x', type: 'image', position: { x: 0, y: 0 }, data: { content: 'https://x/y.png' }, external: true }],
  edges: [],
});

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

/**
 * Lets a block's view render: TipTap draws a React node view a microtask after
 * the edit that made it, before the browser paints.
 * @returns Resolves once it has.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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

    await settle();
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

  it('takes the block out the moment its attachment is removed', async () => {
    const draft = `look ${attachmentMarker('a1')} here`;
    const { onChange, rerender } = setup({ draft, attachments: [cover] });
    await settle();
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

  it('keeps the block and shows the new name when the attachment is replaced', async () => {
    const draft = `look ${attachmentMarker('a1')}`;
    const { rerender } = setup({ draft, attachments: [cover] });

    rerender({ draft, attachments: [{ ...cover, name: 'cover-v2.png' }] });

    await settle();
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
      await settle();
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

  it('keeps a pasted block, counted as one with its spaces, when the paste is cut', async () => {
    const { onChange } = setup({ draft: 'y'.repeat(9_990), attachments: [cover] });
    act(() => {
      box().commands.focus('end');
      box().view.pasteHTML('ab<span data-reference-mention="" data-source-id="a1">x</span>cdefghijklmnop');
    });

    expect(String(onChange.mock.lastCall?.[0]).slice(9_990)).toBe(`ab ${attachmentMarker('a1')} cdefg`);
    await settle();
    expect(screen.getByTestId('chat-reference')).toHaveTextContent('cover.png');
  });

  it('counts a line break as one when a paste is cut', () => {
    const { onChange } = setup({ draft: 'y'.repeat(9_996) });
    act(() => {
      box().commands.focus('end');
      box().view.pasteHTML('<p>ab</p><p>cdef</p>');
    });

    expect(String(onChange.mock.lastCall?.[0]).slice(9_996)).toBe('ab\nc');
  });

  it('keeps a paste to itself while it is read-only', () => {
    const onPasteCanvas = vi.fn();
    const outside = vi.fn();
    document.addEventListener('paste', outside);
    try {
      setup({ turnPhase: 'sending', onPasteCanvas });
      fireEvent.paste(box().view.dom, {
        clipboardData: { files: [], getData: (type: string) => (type === 'text/plain' ? CANVAS_TEXT : '') },
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

      await settle();
      expect(screen.getByTestId('chat-reference').textContent).not.toBe('Image');
      expect(screen.getByTestId('chat-reference').textContent).not.toBe('');
    } finally {
      await act(async () => {
        await setLocale(before);
      });
    }
  });

  it('shows the current name on a block an undo brings back', async () => {
    const draft = `look ${attachmentMarker('a1')}`;
    const { onChange, rerender } = setup({ draft, attachments: [cover] });
    act(() => {
      const e = box();
      let at = -1;
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'referenceMention') at = pos;
      });
      e.view.dispatch(e.state.tr.delete(at, at + 1));
    });
    rerender({ draft: String(onChange.mock.lastCall?.[0]), attachments: [{ ...cover, name: 'cover-v2.png' }] });

    act(() => {
      const e = box();
      undo(e.state, e.view.dispatch);
    });

    await settle();
    expect(screen.getByTestId('chat-reference')).toHaveTextContent('cover-v2.png');
  });

  it('empties the box when the server takes the message and its attachments together', () => {
    const { onChange, rerender } = setup({ draft: `look ${attachmentMarker('a1')} here`, attachments: [cover] });

    // The server's first word clears the draft and the sent attachments in one render.
    rerender({ draft: '', attachments: [] });

    expect(box().state.doc.textContent).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('empties the box when the first word frees it in the same render that clears it', () => {
    const { onChange, rerender } = setup({
      turnPhase: 'sending',
      draft: `look ${attachmentMarker('a1')} here`,
      attachments: [cover],
    });

    rerender({ turnPhase: 'running', draft: '', attachments: [] });

    expect(box().state.doc.textContent).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not run the attachment rule on every keystroke', () => {
    const tray = [cover];
    const { onChange, rerender } = setup({ draft: '', attachments: tray });
    const seen: boolean[] = [];
    box().on('transaction', ({ transaction }) => seen.push(transaction.getMeta('composerAttachmentsChanged') === true));
    type('hi');
    rerender({ draft: String(onChange.mock.lastCall?.[0]), attachments: tray });

    expect(seen.filter(Boolean)).toHaveLength(0);
  });

  it('leaves the next conversation its own draft when the last one held a block', () => {
    const { onChange, rerender } = setup({
      conversationId: 'c1',
      draft: `look ${attachmentMarker('a1')} here`,
      attachments: [cover],
    });

    rerender({ conversationId: 'c2', draft: 'B words', attachments: [] });

    expect(box().state.doc.textContent).toBe('B words');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('undoes with Mod+Z and redoes with Shift as well', () => {
    setup();
    type('abc');
    // Mod is Cmd on a Mac and Ctrl elsewhere; this environment is not a Mac.
    const key = (extra: KeyboardEventInit): void => {
      act(() => {
        box().view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...extra }),
        );
      });
    };

    key({});
    expect(box().state.doc.textContent).toBe('');
    key({ shiftKey: true });
    expect(box().state.doc.textContent).toBe('abc');
  });

  it('keeps a list closed by a click elsewhere closed when an attachment before the @ is removed', async () => {
    const tray = [cover, brief];
    const { onChange, rerender } = setup({ draft: `${attachmentMarker('a1')} `, attachments: tray });
    act(() => box().commands.focus('end'));
    type('@b');
    await waitFor(() => expect(screen.getByTestId('reference-mention-option-a2')).toBeVisible());
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    rerender({ draft: String(onChange.mock.lastCall?.[0]), attachments: tray });

    rerender({ draft: String(onChange.mock.lastCall?.[0]), attachments: [brief] });

    expect(screen.queryByTestId('chat-reference')).toBeNull();
    expect(screen.getByTestId('reference-mention-option-a2')).not.toBeVisible();
  });

  it('keeps the highlighted row when another attachment becomes ready', async () => {
    const one: TrayItem = { ...cover, id: 'o1', name: 'one.png', chip: { ...cover.chip!, id: 'o1', name: 'one.png' } };
    const two: TrayItem = { ...cover, id: 'o2', name: 'two.png', chip: { ...cover.chip!, id: 'o2', name: 'two.png' } };
    const three: TrayItem = { id: 'o3', name: 'three.png', type: 'image', status: 'uploading' };
    const { onChange, rerender } = setup({ attachments: [one, two, three] });
    act(() => box().commands.focus('end'));
    type('@');
    await waitFor(() => screen.getByTestId('reference-mention-option-o2'));
    press('ArrowDown');
    const ready = { ...three, status: 'ready' as const, chip: { ...cover.chip!, id: 'o3', name: 'three.png' } };
    rerender({ draft: String(onChange.mock.lastCall?.[0]), attachments: [one, two, ready] });
    await waitFor(() => screen.getByTestId('reference-mention-option-o3'));

    press('Enter');

    const picked = String(onChange.mock.lastCall?.[0]);
    expect(picked).toContain(attachmentMarker('o2'));
    expect(picked).not.toContain(attachmentMarker('o1'));
  });

  it('breaks the line on Shift+Enter', () => {
    const { onSubmit } = setup({ draft: 'one' });
    act(() => box().commands.focus('end'));
    act(() => {
      box().view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(box().state.doc.childCount).toBe(2);
  });

  it('names the blocks a draft starts with, once, under StrictMode', async () => {
    const onChange = vi.fn();
    render(
      <React.StrictMode>
        {/* A draft as the box writes it: a block keeps a space on either side. */}
        <ChatComposer draft={`see ${attachmentMarker('a1')} `} attachments={[cover]} onChange={onChange} onSubmit={vi.fn()} />
      </React.StrictMode>,
    );

    await settle();
    expect(screen.getByTestId('chat-reference')).toHaveTextContent('cover.png');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes the list when the conversation changes', async () => {
    const tray = [cover];
    const { onChange, rerender } = setup({ conversationId: 'c1', attachments: tray });
    act(() => box().commands.focus('end'));
    type('@');
    await waitFor(() => expect(screen.getByTestId('reference-mention-option-a1')).toBeVisible());

    rerender({ conversationId: 'c2', draft: '', attachments: tray });

    expect(screen.queryByTestId('reference-mention-option-a1')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('picks a row with the spaces around its block when they fit under the limit', async () => {
    const { onChange } = setup({ draft: 'y'.repeat(9_997), attachments: [cover] });
    act(() => box().commands.focus('end'));
    type('@');
    await waitFor(() => screen.getByTestId('reference-mention-option-a1'));
    press('Enter');

    expect(String(onChange.mock.lastCall?.[0]).slice(9_995)).toBe(`yy ${attachmentMarker('a1')} `);
    expect(screen.queryByTestId('chat-composer-limit')).toBeNull();
  });

  it('refuses a pick whose block and spaces would pass the limit, keeping the words', async () => {
    const { onChange } = setup({ draft: 'y'.repeat(9_998), attachments: [cover] });
    act(() => box().commands.focus('end'));
    type('@');
    await waitFor(() => screen.getByTestId('reference-mention-option-a1'));
    press('Enter');

    expect(screen.queryByTestId('chat-reference')).toBeNull();
    expect(String(onChange.mock.lastCall?.[0])).toBe(`${'y'.repeat(9_998)}@`);
    expect(screen.getByTestId('chat-composer-limit')).toBeInTheDocument();
  });

  it('scrolls a cut paste into view and marks it as a paste, as an uncut one is', () => {
    setup({ draft: 'y'.repeat(9_990) });
    act(() => box().commands.focus('end'));
    const view = box().view;
    const dispatched: Transaction[] = [];
    const real = view.dispatch.bind(view);
    view.dispatch = (tr: Transaction): void => {
      if (tr.docChanged) dispatched.push(tr);
      real(tr);
    };
    fireEvent.paste(view.dom, {
      clipboardData: { files: [], getData: (kind: string) => (kind === 'text/plain' ? 'z'.repeat(50) : '') },
    });

    // The paste goes in as ProseMirror pastes, then its end is cut; both
    // leave the caret in view.
    expect(dispatched[0]?.scrolledIntoView).toBe(true);
    expect(dispatched[0]?.getMeta('uiEvent')).toBe('paste');
    expect(dispatched[0]?.getMeta('paste')).toBe(true);
    expect(dispatched.at(-1)?.scrolledIntoView).toBe(true);
    expect(box().state.doc.textContent).toHaveLength(10_000);
  });

  it('neither shows the list again nor picks from it while it is read-only', async () => {
    const { onChange, rerender } = setup({ attachments: [cover] });
    act(() => box().commands.focus('end'));
    type('look @co');
    await waitFor(() => screen.getByTestId('reference-mention-option-a1'));
    act(() => {
      screen.getByTestId('chat-composer-send').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    const draft = String(onChange.mock.lastCall?.[0]);
    rerender({ draft, attachments: [cover], turnPhase: 'sending' });

    const e = box();
    e.view.posAtCoords = (() => ({ pos: e.state.selection.from, inside: -1 })) as typeof e.view.posAtCoords;
    act(() => {
      e.view.dom.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(screen.getByTestId('reference-mention-option-a1')).not.toBeVisible();

    fireEvent.click(screen.getByTestId('reference-mention-option-a1'));
    press('Enter');
    expect(String(onChange.mock.lastCall?.[0])).toBe(draft);
    expect(screen.queryByTestId('chat-reference')).toBeNull();
  });

  it('does not open the list on a caret placed in an @ while it is read-only', () => {
    setup({ draft: 'look @co here', attachments: [cover], turnPhase: 'sending' });
    act(() => {
      const e = box();
      e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 9)));
    });

    const row = screen.queryByTestId('reference-mention-option-a1');
    expect(row !== null && row.closest<HTMLElement>('body > div')?.style.display !== 'none').toBe(false);
  });

  it('marks a block with its kind as an icon, and previews the attachment on hover', async () => {
    setup({ draft: `see ${attachmentMarker('a1')} `, attachments: [cover] });
    await settle();
    const block = screen.getByTestId('chat-reference');
    expect(block.querySelector('svg')).not.toBeNull();
    expect(block.textContent).toBe('cover.png');

    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(block, { pointerType: 'mouse' });
      act(() => {
        vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10);
      });
      expect(screen.getByTestId('hover-preview-content').querySelector('img')?.getAttribute('src')).toBe('u');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the clipboard alone when an empty box is selected and copied', () => {
    setup({ draft: '' });
    act(() => box().commands.selectAll());
    const setData = vi.fn();
    const event = fireEvent.copy(box().view.dom, { clipboardData: { clearData: vi.fn(), setData } });

    expect(setData).not.toHaveBeenCalled();
    expect(event).toBe(true);
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

  it('keeps the spaces around a pasted block when the paste is cut just after it', () => {
    const { onChange } = setup({ draft: 'x'.repeat(9_996), attachments: [cover] });
    act(() => {
      box().commands.focus('end');
      box().view.pasteHTML('<span data-reference-mention="" data-source-id="a1">x</span>zz');
    });

    expect(String(onChange.mock.lastCall?.[0]).slice(9_996)).toBe(` ${attachmentMarker('a1')} z`);
  });

  it('previews what an attachment holds now once it is attached again under the same id', async () => {
    const { rerender } = setup({ draft: `see ${attachmentMarker('a1')} `, attachments: [cover] });
    await settle();
    rerender({ attachments: [{ ...cover, chip: { ...cover.chip!, data_snapshot: { url: 'new' } } }] });
    await settle();

    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(screen.getByTestId('chat-reference'), { pointerType: 'mouse' });
      act(() => {
        vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10);
      });
      expect(screen.getByTestId('hover-preview-content').querySelector('img')?.getAttribute('src')).toBe('new');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pastes the plain text of a web page, its line breaks kept, when it holds no block', () => {
    const { onChange } = setup({ draft: '' });
    act(() => box().commands.focus('end'));
    const plain = 'def f():\n    return 1\n\nprint(f())';
    fireEvent.paste(box().view.dom, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === 'text/plain' ? plain : type === 'text/html' ? '<pre>def f():\n    return 1\n\nprint(f())</pre><br>' : '',
      },
    });

    expect(onChange).toHaveBeenLastCalledWith(plain);
  });

  it('copies lines out one line break apart and pastes them back as they were', () => {
    const { onChange } = setup({ draft: 'one\ntwo' });
    act(() => box().commands.selectAll());
    const written = new Map<string, string>();
    fireEvent.copy(box().view.dom, {
      clipboardData: { clearData: () => written.clear(), setData: (type: string, value: string) => written.set(type, value) },
    });
    expect(written.get('text/plain')).toBe('one\ntwo');

    act(() => box().commands.focus('end'));
    fireEvent.paste(box().view.dom, { clipboardData: { files: [], getData: (type: string) => written.get(type) ?? '' } });
    expect(onChange).toHaveBeenLastCalledWith('one\ntwoone\ntwo');
  });

  it('cuts a composition that ends past the limit as soon as it ends', async () => {
    const { onChange } = setup({ draft: `ab${'y'.repeat(9_997)}` });
    const view = box().view as unknown as { input: { composing: boolean } } & Editor['view'];
    act(() => {
      box().commands.focus('end');
      view.input.composing = true;
      view.dispatch(view.state.tr.insertText('한글').setMeta('composition', 1));
    });
    await act(async () => {
      view.input.composing = false;
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '한글', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onChange).toHaveBeenLastCalledWith(`ab${'y'.repeat(9_997)}한`);
  });

  it('cuts an overflowing composition from its own end even when the caret has moved first', () => {
    const { onChange } = setup({ draft: `ab${'y'.repeat(9_997)}` });
    const view = box().view as unknown as { input: { composing: boolean } } & Editor['view'];
    act(() => {
      box().commands.focus('end');
      view.input.composing = true;
      view.dispatch(view.state.tr.insertText('한글').setMeta('composition', 1));
      view.input.composing = false;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    });

    expect(onChange).toHaveBeenLastCalledWith(`ab${'y'.repeat(9_997)}한`);
  });
});
