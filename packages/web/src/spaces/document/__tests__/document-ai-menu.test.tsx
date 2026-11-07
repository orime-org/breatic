// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bubble bar's AI menu once its text commands work (inner#1860, design
 * §5.2): six working rows, translate and change tone each opening a second
 * level without closing the menu, the storyboard and illustration rows as
 * they were, an opener named plainly "AI", and no AI group at all — separator
 * included — over a selection of table cells. Each working row sends the
 * request the server's contract reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { t } from '@breatic/shared';

const stream = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/text-tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  textToolsApi: { stream, config },
}));

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
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

let calls: FakeStream[] = [];

beforeEach(() => {
  stream.mockReset();
  config.mockReset();
  config.mockResolvedValue({ selectionMaxChars: 4000, contextMaxChars: 20000 });
  calls = fakeStreams(stream);
});

afterEach(() => {
  closeShared();
});

/**
 * Opens a body in a project, selects some of it, and waits for the bar.
 * @param html - The body.
 * @param from - The first character selected.
 * @param to - One past the last.
 * @returns The editor.
 */
async function selected(html: string, from: number, to: number): Promise<HarnessEditor> {
  const editor = openSharedBody(html);
  mountDocumentEditor(editor, false, 'project-1');
  act(() => {
    focusBody(editor);
    selectTextRange(editor, from, to);
  });
  await waitForBar();
  return editor;
}

/**
 * Presses a row of the AI menu.
 * @param row - The row's test id.
 */
async function press(row: string): Promise<void> {
  const menu = await hoverOpenSlot('doc-bubble-ai');
  await act(async () => {
    fireEvent.click(menu.querySelector(`[data-testid="${row}"]`)!);
  });
}

/**
 * Opens a row's second level by hovering it, and presses an item there.
 * @param row - The row with a second level: translate or tone.
 * @param item - The item's test id.
 */
async function pressInSecondLevel(row: 'translate' | 'tone', item: string): Promise<void> {
  const menu = await hoverOpenSlot('doc-bubble-ai');
  act(() => {
    fireEvent.pointerEnter(menu.querySelector(`[data-testid="doc-bubble-ai-item-${row}"]`)!);
  });
  const panel = await waitFor(() => screen.getByTestId(`doc-bubble-ai-${row}-menu`));
  await act(async () => {
    fireEvent.click(panel.querySelector(`[data-testid="${item}"]`)!);
  });
}

describe('the AI opener', () => {
  it('is named plainly AI, no longer "not open yet"', async () => {
    await selected('<p>hello world</p>', 0, 5);

    const label = screen.getByTestId('doc-bubble-ai').getAttribute('aria-label');
    expect(label).toBe(t('spaces.document.commands.ai'));
    expect(label).not.toBe(t('spaces.document.commands.comingLabel', { name: t('spaces.document.commands.ai') }));
  });
});

describe('the AI menu over a text selection', () => {
  it('still lists the eight rows, the storyboard and illustration rows among them', async () => {
    await selected('<p>hello world</p>', 0, 5);
    const menu = await hoverOpenSlot('doc-bubble-ai');

    const rows = [...menu.querySelectorAll('[data-testid^="doc-bubble-ai-item-"]')].map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual([
      'doc-bubble-ai-item-refine',
      'doc-bubble-ai-item-expand',
      'doc-bubble-ai-item-shorten',
      'doc-bubble-ai-item-translate',
      'doc-bubble-ai-item-tone',
      'doc-bubble-ai-item-storyboard',
      'doc-bubble-ai-item-illustrate',
      'doc-bubble-ai-item-custom',
    ]);
  });

  it.each([
    ['refine', 'polish'],
    ['expand', 'expand'],
    ['shorten', 'shorten'],
  ])('%s opens the dialog and asks the server for %s with the selection and its document', async (row, tool) => {
    await selected('<p>hello world</p>', 0, 5);
    const before = sharedBodyMarkup();

    await press(`doc-bubble-ai-item-${row}`);

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]!.body).toEqual({ tool, project_id: 'project-1', selection: 'hello', document: 'hello world' });
    expect(screen.getByTestId('doc-ai-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-bubble-ai-menu')).toBeNull();
    expect(sharedBodyMarkup()).toBe(before);
  });

  it('translate opens its languages on hover, and a language asks for that language', async () => {
    await selected('<p>hello world</p>', 0, 5);

    await pressInSecondLevel('translate', 'doc-bubble-ai-translate-item-ja');

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]!.body).toEqual({ tool: 'translate', project_id: 'project-1', selection: 'hello', document: 'hello world', language: 'ja' });
    expect(screen.getByTestId('doc-ai-title').textContent).toContain(t('spaces.document.commands.ai_translate'));
    expect(screen.getByTestId('doc-ai-title').textContent).toContain('日本語');
  });

  it('translate offers the five languages of the contract', async () => {
    await selected('<p>hello world</p>', 0, 5);
    const menu = await hoverOpenSlot('doc-bubble-ai');
    act(() => {
      fireEvent.pointerEnter(menu.querySelector('[data-testid="doc-bubble-ai-item-translate"]')!);
    });
    const panel = await waitFor(() => screen.getByTestId('doc-bubble-ai-translate-menu'));

    expect([...panel.querySelectorAll('[data-testid^="doc-bubble-ai-translate-item-"]')].map((row) => row.getAttribute('data-testid'))).toEqual([
      'doc-bubble-ai-translate-item-en',
      'doc-bubble-ai-translate-item-zh-CN',
      'doc-bubble-ai-translate-item-zh-TW',
      'doc-bubble-ai-translate-item-ja',
      'doc-bubble-ai-translate-item-ko',
    ]);
  });

  it('change tone opens its five tones, and a tone asks for a rewrite in it', async () => {
    await selected('<p>hello world</p>', 0, 5);
    const menu = await hoverOpenSlot('doc-bubble-ai');
    act(() => {
      fireEvent.pointerEnter(menu.querySelector('[data-testid="doc-bubble-ai-item-tone"]')!);
    });
    const panel = await waitFor(() => screen.getByTestId('doc-bubble-ai-tone-menu'));
    expect([...panel.querySelectorAll('[data-testid^="doc-bubble-ai-tone-item-"]')].map((row) => row.getAttribute('data-testid'))).toEqual([
      'doc-bubble-ai-tone-item-professional',
      'doc-bubble-ai-tone-item-casual',
      'doc-bubble-ai-tone-item-straightforward',
      'doc-bubble-ai-tone-item-confident',
      'doc-bubble-ai-tone-item-friendly',
    ]);

    await act(async () => {
      fireEvent.click(panel.querySelector('[data-testid="doc-bubble-ai-tone-item-professional"]')!);
    });

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]!.body).toEqual({ tool: 'rewrite', project_id: 'project-1', selection: 'hello', document: 'hello world', style: 'professional' });
  });

  it.each(['translate', 'tone'])('pressing %s opens its second level and leaves the menu open', async (row) => {
    await selected('<p>hello world</p>', 0, 5);
    const menu = await hoverOpenSlot('doc-bubble-ai');

    await act(async () => {
      fireEvent.click(menu.querySelector(`[data-testid="doc-bubble-ai-item-${row}"]`)!);
    });

    expect(screen.getByTestId('doc-bubble-ai-menu')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId(`doc-bubble-ai-${row}-menu`)).toBeInTheDocument();
    });
    expect(stream).not.toHaveBeenCalled();
    expect(screen.queryByTestId('doc-ai-dialog')).toBeNull();
  });

  it('custom instruction opens the dialog asking for the instruction, and sends nothing yet', async () => {
    await selected('<p>hello world</p>', 0, 5);

    await press('doc-bubble-ai-item-custom');

    await waitFor(() => {
      expect(screen.getByTestId('doc-ai-instructions')).toBeInTheDocument();
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(['storyboard', 'illustrate'])('%s is unchanged: it opens no dialog and sends nothing', async (row) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await selected('<p>hello world</p>', 0, 5);

      await press(`doc-bubble-ai-item-${row}`);

      expect(stream).not.toHaveBeenCalled();
      expect(screen.queryByTestId('doc-ai-dialog')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Opens a mounted editor holding a 2 x 2 table, in a project.
 * @returns The editor.
 */
function openTable(): HarnessEditor {
  const editor = openSharedBody('');
  mountDocumentEditor(editor, false, 'project-1');
  act(() => {
    editor.replaceBlocks(editor.document, [
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
    ] as never);
  });
  focusBody(editor);
  return editor;
}

/**
 * The positions before the table's cells.
 * @param editor - The editor.
 * @returns Them, in order.
 */
function cells(editor: HarnessEditor): number[] {
  const out: number[] = [];
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.type.name === 'docTableCell') out.push(pos);
    return true;
  });
  return out;
}

describe('the AI group over table cells', () => {
  it('is not there, nor its separator, while cells are selected', async () => {
    const editor = openTable();
    const view = editor.prosemirrorView!;
    const at = cells(editor);
    act(() => {
      view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, at[0]!, at[1]!)));
    });
    await waitForBar();

    expect(screen.queryByTestId('doc-bubble-ai')).toBeNull();
    expect(screen.queryByTestId('doc-bubble-sep-ai')).toBeNull();
  });

  it('is there over words selected inside one cell', async () => {
    const editor = openTable();
    const view = editor.prosemirrorView!;
    let first = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (first < 0 && node.isText && node.text === 'a1') first = pos;
      return first < 0;
    });
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, first, first + 2)));
    });
    await waitForBar();

    expect(screen.getByTestId('doc-bubble-ai')).toBeInTheDocument();
    expect(screen.getByTestId('doc-bubble-sep-ai')).toBeInTheDocument();
  });
});
