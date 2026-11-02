// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog on screen (inner#1860 A1, A4, A5, A7, A8, design §5.3,
 * §6.2): reached from the bubble bar of a mounted document, its buttons per
 * state, closing (close, Escape; not a click outside) aborting the fetch, the
 * custom instruction box and its Enter, the failure toast, the preview drawn
 * the way the body draws blocks, and the body untouched until insert or
 * replace.
 *
 * The network is the only thing replaced: `textToolsApi` is driven by hand
 * (`ai-stream-fake.ts`); the editor, the bar and the dialog are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { BlockNoteEditor } from '@blocknote/core';

import { t } from '@breatic/shared';

const stream = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/text-tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  textToolsApi: { stream, config },
}));

import { toast } from '@web/lib/toast';
import { BODY_SURFACE_CLASS } from '@web/spaces/document/build-document-editor';
import {
  closeShared,
  focusBody,
  hoverOpenSlot,
  mountDocumentEditor,
  openSharedBody,
  selectTextRange,
  sharedBodyMarkup,
  waitForBar,
  type HarnessEditor,
} from './bubble-bar-harness';
import { fakeStreams, type FakeStream } from './ai-stream-fake';

let calls: FakeStream[] = [];
let toastError: MockInstance<typeof toast.error>;

beforeEach(() => {
  stream.mockReset();
  config.mockReset();
  // Shown at once unless a case is about the reading pace.
  config.mockResolvedValue({ selectionMaxChars: 4000, contextMaxChars: 20000, revealCharsPerSecond: 1_000_000 });
  calls = fakeStreams(stream);
  toastError = vi.spyOn(toast, 'error').mockImplementation(() => '');
});

afterEach(() => {
  toastError.mockRestore();
  closeShared();
});

const BUTTONS = ['doc-ai-close', 'doc-ai-stop', 'doc-ai-retry', 'doc-ai-insert', 'doc-ai-replace'] as const;

/**
 * The dialog's buttons that are on screen.
 * @returns Their test ids, in a fixed order.
 */
function shownButtons(): string[] {
  return BUTTONS.filter((id) => screen.queryByTestId(id) !== null);
}

/**
 * Whether a button says it cannot be pressed now, whichever way it says so.
 * @param id - Its test id.
 * @returns True when disabled.
 */
function isDisabled(id: string): boolean {
  const button = screen.getByTestId(id) as HTMLButtonElement;
  return button.disabled || button.getAttribute('aria-disabled') === 'true';
}

/**
 * Opens a body in a project and selects some of it.
 * @param html - The body.
 * @param from - The first character.
 * @param to - One past the last.
 * @returns The editor.
 */
async function selected(html: string, from: number, to: number): Promise<HarnessEditor> {
  const editor = openSharedBody(html);
  mountDocumentEditor(editor, false, 'project-1');
  await selectAgain(editor, from, to);
  return editor;
}

/**
 * Selects again in an open body and waits for the bar.
 * @param editor - The editor.
 * @param from - The first character.
 * @param to - One past the last.
 */
async function selectAgain(editor: HarnessEditor, from: number, to: number): Promise<void> {
  act(() => {
    focusBody(editor);
    selectTextRange(editor, from, to);
  });
  await waitForBar();
}

/**
 * Presses a row of the AI menu and waits for the dialog.
 * @param row - The row's id: refine, expand, custom, …
 */
async function press(row: string): Promise<void> {
  const menu = await hoverOpenSlot('doc-bubble-ai');
  await act(async () => {
    fireEvent.click(menu.querySelector(`[data-testid="doc-bubble-ai-item-${row}"]`)!);
  });
  await waitFor(() => {
    expect(screen.getByTestId('doc-ai-dialog')).toBeInTheDocument();
  });
}

/**
 * Selects "hello" in "hello world" and presses Polish.
 * @param html - The body, "hello world" by default.
 * @returns The editor and the request it sent.
 */
async function polishing(html = '<p>hello world</p>'): Promise<{ editor: HarnessEditor; call: FakeStream }> {
  const editor = await selected(html, 0, 5);
  await press('refine');
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  return { editor, call: calls[0]! };
}

/**
 * Delivers frames of the current request.
 * @param call - The request.
 * @param texts - The text deltas, then done when `done` is set.
 * @param done - Whether the server then says done.
 */
async function streams(call: FakeStream, texts: readonly string[], done = false): Promise<void> {
  await act(async () => {
    for (const text of texts) call.emit({ type: 'text_delta', text });
    if (done) call.emit({ type: 'done' });
  });
}

/**
 * The words the preview shows.
 * @returns Its text.
 */
function previewText(): string {
  return screen.getByTestId('doc-ai-preview').textContent ?? '';
}

describe('while the result streams in', () => {
  it('shows the command name, close and stop', async () => {
    await polishing();

    expect(screen.getByTestId('doc-ai-title').textContent).toContain(t('spaces.document.commands.ai_refine'));
    expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-stop']);
  });

  it('shows the waiting dot until the first words arrive, and only the words after', async () => {
    const { call } = await polishing();
    const dialog = screen.getByTestId('doc-ai-dialog');

    expect(dialog.querySelectorAll('[data-testid="chat-waiting-dot"]')).toHaveLength(1);

    await streams(call, ['Hi']);

    await waitFor(() => {
      expect(previewText()).toContain('Hi');
    });
    expect(dialog.querySelector('[data-testid="chat-waiting-dot"]')).toBeNull();
  });

  it('shows no waiting dot once the run has ended without words', async () => {
    const { call } = await polishing();

    await streams(call, [], true);

    await waitFor(() => {
      expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-retry']);
    });
    expect(screen.getByTestId('doc-ai-dialog').querySelector('[data-testid="chat-waiting-dot"]')).toBeNull();
  });

  it('shows what arrived at a reading pace, and offers insert and replace once all of it is on screen', async () => {
    config.mockResolvedValue({ selectionMaxChars: 4000, contextMaxChars: 20000, revealCharsPerSecond: 60 });
    const { call } = await polishing();
    const long = 'word '.repeat(120).trim();

    await streams(call, [long], true);

    expect(shownButtons()).not.toContain('doc-ai-replace');
    await waitFor(() => {
      expect(shownButtons()).toContain('doc-ai-replace');
    }, { timeout: 5_000 });
    await waitFor(() => {
      expect(previewText()).toContain(long);
    });
  });

  it('offers stop while the answer is still being written after the server is done, and stop shows the rest at once', async () => {
    config.mockResolvedValue({ selectionMaxChars: 4000, contextMaxChars: 20000, revealCharsPerSecond: 60 });
    const { call } = await polishing();
    const long = 'word '.repeat(120).trim();
    await streams(call, [long], true);

    expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-stop']);
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-ai-stop'));
    });

    expect(shownButtons()).toContain('doc-ai-replace');
    await waitFor(() => {
      expect(previewText()).toContain(long);
    });
    expect(calls).toHaveLength(1);
  });

  it('shows each piece as it arrives and leaves the body as it was', async () => {
    const { call } = await polishing();
    const before = sharedBodyMarkup();

    await streams(call, ['Hi', ' there']);

    await waitFor(() => {
      expect(previewText()).toContain('Hi there');
    });
    expect(sharedBodyMarkup()).toBe(before);
  });
});

describe('when the result is complete', () => {
  it('offers close, retry, insert and replace, and the body is still as it was', async () => {
    const { call } = await polishing();
    const before = sharedBodyMarkup();

    await streams(call, ['Hello there.'], true);

    await waitFor(() => {
      expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-retry', 'doc-ai-insert', 'doc-ai-replace']);
    });
    expect(isDisabled('doc-ai-insert')).toBe(false);
    expect(isDisabled('doc-ai-replace')).toBe(false);
    expect(sharedBodyMarkup()).toBe(before);
  });

  it('offers only close and retry when the result is only blanks', async () => {
    const { call } = await polishing();

    await streams(call, ['  \n '], true);

    await waitFor(() => {
      expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-retry']);
    });
  });
});

describe('stop', () => {
  it('aborts the fetch and keeps what came, with retry, insert and replace', async () => {
    const { call } = await polishing();
    await streams(call, ['Hello']);

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-ai-stop'));
    });

    expect(call.signal?.aborted).toBe(true);
    expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-retry', 'doc-ai-insert', 'doc-ai-replace']);
    expect(previewText()).toContain('Hello');
  });

  it('before any text, leaves only close and retry', async () => {
    await polishing();

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-ai-stop'));
    });

    expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-retry']);
  });
});

describe('a failure', () => {
  it('toasts once and leaves close and retry over an empty result', async () => {
    const { call } = await polishing();
    await streams(call, ['Hel']);

    await act(async () => {
      call.fail();
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-retry']);
    expect(previewText()).not.toContain('Hel');
    expect(screen.getByTestId('doc-ai-dialog')).toBeInTheDocument();
  });

  it('from an error event fails the same way', async () => {
    const { call } = await polishing();

    await act(async () => {
      call.emit({ type: 'error', message: 'The model is unavailable.' });
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-retry']);
  });

  it('retry sends the request again, as a new one', async () => {
    const { call } = await polishing();
    await act(async () => {
      call.fail();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-ai-retry'));
    });

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]!.body).toEqual(call.body);
    expect(shownButtons()).toEqual(['doc-ai-close', 'doc-ai-stop']);
  });
});

describe('closing', () => {
  it('Escape closes the dialog and aborts the fetch', async () => {
    const { call } = await polishing();

    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('doc-ai-dialog'), { key: 'Escape' });
    });

    expect(screen.queryByTestId('doc-ai-dialog')).toBeNull();
    expect(call.signal?.aborted).toBe(true);
  });

  it('one Escape in the body closes the dialog and the body keeps the keyboard', async () => {
    const { editor, call } = await polishing();
    const view = editor.prosemirrorView!;
    act(() => {
      view.focus();
    });

    await act(async () => {
      fireEvent.keyDown(view.dom, { key: 'Escape' });
    });

    expect(screen.queryByTestId('doc-ai-dialog')).toBeNull();
    expect(call.signal?.aborted).toBe(true);
    expect(view.hasFocus()).toBe(true);
  });

  it('Escape typed in a field outside the dialog and the body leaves it open', async () => {
    const { call } = await polishing();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();

    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' });
    });

    expect(screen.getByTestId('doc-ai-dialog')).toBeInTheDocument();
    expect(call.signal?.aborted).toBe(false);
    field.remove();
  });

  it('the close button closes the dialog and aborts the fetch', async () => {
    const { call } = await polishing();

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-ai-close'));
    });

    expect(screen.queryByTestId('doc-ai-dialog')).toBeNull();
    expect(call.signal?.aborted).toBe(true);
  });

  it('a click outside the dialog does not close it', async () => {
    const { editor, call } = await polishing();

    for (const target of [editor.prosemirrorView!.dom, document.body]) {
      await act(async () => {
        fireEvent.pointerDown(target);
        fireEvent.mouseDown(target);
        fireEvent.pointerUp(target);
        fireEvent.mouseUp(target);
        fireEvent.click(target);
      });
    }

    expect(screen.getByTestId('doc-ai-dialog')).toBeInTheDocument();
    expect(call.signal?.aborted).toBe(false);
  });

  it('a new command from the bar closes the open dialog, aborting its request, and opens the new one', async () => {
    const { editor, call } = await polishing();

    await selectAgain(editor, 6, 11);
    await press('expand');

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(call.signal?.aborted).toBe(true);
    expect(calls[1]!.body).toMatchObject({ tool: 'expand', selection: 'world' });
    expect(screen.getAllByTestId('doc-ai-dialog')).toHaveLength(1);
  });
});

describe('how long a session lives', () => {
  it('lives on while its Space tab is hidden, request and all, and shows again with it', async () => {
    const editor = openSharedBody('<p>hello world</p>');
    const setHidden = mountDocumentEditor(editor, false, 'project-1', true);
    await selectAgain(editor, 0, 5);
    await press('refine');
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    act(() => {
      setHidden(true);
    });
    expect(calls[0]!.signal?.aborted).toBe(false);
    act(() => {
      setHidden(false);
    });
    await streams(calls[0]!, ['Hi'], true);

    await waitFor(() => {
      expect(previewText()).toContain('Hi');
    });
    expect(shownButtons()).toContain('doc-ai-replace');
  });

  it('keeps drawing the words that come after its tab was hidden and shown again', async () => {
    const editor = openSharedBody('<p>hello world</p>');
    const setHidden = mountDocumentEditor(editor, false, 'project-1', true);
    await selectAgain(editor, 0, 5);
    await press('refine');
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await streams(calls[0]!, ['Before']);
    await waitFor(() => {
      expect(previewText()).toContain('Before');
    });
    // Hidden while a parse is still waiting its turn.
    await streams(calls[0]!, [' mid']);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    act(() => {
      setHidden(true);
    });
    act(() => {
      setHidden(false);
    });
    await streams(calls[0]!, [' after']);

    await waitFor(() => {
      expect(previewText()).toContain('Before mid after');
    });
  });

  it('ends with the editor, aborting its request', async () => {
    const { editor, call } = await polishing();

    act(() => {
      editor.unmount();
    });

    expect(call.signal?.aborted).toBe(true);
  });
});

describe('the keyboard', () => {
  it('goes to the dialog as it shows, and Tab can reach its buttons', async () => {
    await polishing();
    const dialog = screen.getByTestId('doc-ai-dialog');

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('stays in the dialog when the button holding it goes away', async () => {
    const { call } = await polishing();
    act(() => {
      screen.getByTestId('doc-ai-stop').focus();
    });

    await streams(call, ['Hi'], true);

    await waitFor(() => {
      expect(shownButtons()).toContain('doc-ai-replace');
    });
    expect(screen.getByTestId('doc-ai-dialog').contains(document.activeElement)).toBe(true);
  });

  it('goes back to the body when the dialog closes', async () => {
    const { editor } = await polishing();
    await waitFor(() => {
      expect(screen.getByTestId('doc-ai-dialog').contains(document.activeElement)).toBe(true);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-ai-close'));
    });

    expect(editor.prosemirrorView!.hasFocus()).toBe(true);
  });
});

describe('the custom instruction', () => {
  /**
   * Opens the dialog on a custom instruction and writes one.
   * @param words - What the reader writes.
   * @returns The box.
   */
  async function writing(words: string): Promise<HTMLTextAreaElement> {
    await selected('<p>hello world</p>', 0, 5);
    await press('custom');
    const box = screen.getByTestId('doc-ai-instructions') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: words } });
    return box;
  }

  it('starts with only the box and close', async () => {
    await writing('');

    expect(shownButtons()).toEqual(['doc-ai-close']);
    expect(stream).not.toHaveBeenCalled();
  });

  it('Enter starts it with the instruction; the title stays and the instruction stays on as a read-only line', async () => {
    const box = await writing('Make it rhyme');
    const title = screen.getByTestId('doc-ai-title').textContent;

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]!.body).toEqual({ tool: 'custom', project_id: 'project-1', selection: 'hello', document: 'hello world', instructions: 'Make it rhyme' });
    expect(screen.getByTestId('doc-ai-title').textContent).toBe(title);
    expect(title).not.toContain('spaces.document');
    const line = screen.getByTestId('doc-ai-instruction');
    expect(line.textContent).toContain('Make it rhyme');
    expect(line.matches('textarea, input, [contenteditable="true"]')).toBe(false);
    expect(line.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
    expect(screen.queryByTestId('doc-ai-instructions')).toBeNull();
  });

  it('Shift+Enter makes a new line and starts nothing', async () => {
    const box = await writing('Make it rhyme');

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 13, shiftKey: true });
    });

    expect(stream).not.toHaveBeenCalled();
    expect(screen.getByTestId('doc-ai-instructions')).toBeInTheDocument();
  });

  it('Enter with nothing written starts nothing', async () => {
    const box = await writing('   ');

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    });

    expect(stream).not.toHaveBeenCalled();
  });

  it('an Escape that belongs to the input method leaves the dialog and the instruction', async () => {
    const box = await writing('Make it rhyme');

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Escape', keyCode: 27, isComposing: true });
      fireEvent.keyDown(box, { key: 'Escape', keyCode: 229 });
      fireEvent.compositionStart(box);
      fireEvent.compositionEnd(box);
      fireEvent.keyDown(box, { key: 'Escape', keyCode: 27 });
    });

    expect(screen.getByTestId('doc-ai-dialog')).toBeInTheDocument();
    expect((screen.getByTestId('doc-ai-instructions') as HTMLTextAreaElement).value).toBe('Make it rhyme');
  });

  it('an Enter that belongs to the input method starts nothing', async () => {
    const box = await writing('Make it rhyme');

    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 13, isComposing: true });
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
      fireEvent.compositionStart(box);
      fireEvent.compositionEnd(box);
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    });

    expect(stream).not.toHaveBeenCalled();

    // The key the reader presses after the composition's own has gone by is theirs.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
  });
});

describe('when the original words or their block go (A7)', () => {
  it('the words deleted, the block still there: replace is disabled, insert is not', async () => {
    const { editor, call } = await polishing('<p>hello world</p><p>second line</p>');
    await streams(call, ['Hi.'], true);

    const view = editor.prosemirrorView!;
    let from = -1;
    view.state.doc.descendants((node, pos) => {
      if (from < 0 && node.isText && (node.text ?? '').startsWith('hello')) from = pos;
      return from < 0;
    });
    act(() => {
      view.dispatch(view.state.tr.delete(from, from + 'hello'.length));
    });

    await waitFor(() => {
      expect(isDisabled('doc-ai-replace')).toBe(true);
    });
    expect(isDisabled('doc-ai-insert')).toBe(false);
  });

  it('the whole block deleted: both are disabled', async () => {
    const { editor, call } = await polishing('<p>hello world</p><p>second line</p>');
    await streams(call, ['Hi.'], true);

    act(() => {
      editor.removeBlocks([(editor.document as Array<{ id: string }>)[0]!.id]);
    });

    await waitFor(() => {
      expect(isDisabled('doc-ai-insert')).toBe(true);
    });
    expect(isDisabled('doc-ai-replace')).toBe(true);
  });

  it('the block deleted and then undone: insert is available again, replace stays off', async () => {
    const { editor, call } = await polishing('<p>hello world</p><p>second line</p>');
    await streams(call, ['Hi.'], true);
    act(() => {
      editor.removeBlocks([(editor.document as Array<{ id: string }>)[0]!.id]);
    });
    await waitFor(() => {
      expect(isDisabled('doc-ai-insert')).toBe(true);
    });

    act(() => {
      editor.undo();
    });

    await waitFor(() => {
      expect(isDisabled('doc-ai-insert')).toBe(false);
    });
    expect(isDisabled('doc-ai-replace')).toBe(true);
  });
});

describe('the preview', () => {
  it('leaves outside media out, as insert and replace do, and never loads them', async () => {
    const { call } = await polishing();

    await streams(call, ['![a cat](https://elsewhere.example/cat.png)\n\nA cat.'], true);

    await waitFor(() => {
      expect(previewText()).toContain('A cat.');
    });
    const preview = screen.getByTestId('doc-ai-preview');
    expect(preview.querySelector('img[src*="elsewhere.example"]')).toBeNull();
    expect(preview.innerHTML).not.toContain('elsewhere.example');
  });

  it('draws the result as the body draws blocks, inside copies of the body\'s own elements', async () => {
    const { call } = await polishing();

    await streams(call, ['**Bold** words\n\n- item one'], true);

    const preview = screen.getByTestId('doc-ai-preview');
    await waitFor(() => {
      expect(preview.querySelector('strong')?.textContent).toBe('Bold');
    });
    expect(preview.querySelector('.doc-preview-shell')).not.toBeNull();
    expect(preview.querySelector(`.doc-preview-shell.${BODY_SURFACE_CLASS}`)).not.toBeNull();
    expect(preview.querySelectorAll('.bn-block-content').length).toBeGreaterThanOrEqual(2);
    expect(preview.textContent).toContain('item one');
  });

  it('parses a burst of pieces fewer times than they arrived, and shows the latest', async () => {
    const parse = vi.spyOn(BlockNoteEditor.prototype, 'tryParseMarkdownToBlocks');
    try {
      const { call } = await polishing();
      const pieces = Array.from({ length: 40 }, (_, i) => `w${String(i)} `);

      await streams(call, pieces);

      await waitFor(() => {
        expect(previewText()).toContain('w39');
      });
      expect(previewText()).toContain('w0 w1');
      const ours = parse.mock.calls.filter(([markdown]) => String(markdown).startsWith('w0'));
      expect(ours.length).toBeGreaterThan(0);
      expect(ours.length).toBeLessThan(pieces.length);
      // The last parse taken is of the whole text, not of an earlier part.
      expect(String(ours.at(-1)![0]).trim()).toBe(pieces.join('').trim());
    } finally {
      parse.mockRestore();
    }
  });
});
