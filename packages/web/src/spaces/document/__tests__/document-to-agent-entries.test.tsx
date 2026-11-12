// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two ways a document hands its words to the agent (inner#936): the
 * bubble bar over a selection and the block handle's menu over one block.
 * Each sits right after its Comment entry and hands one text item to
 * `attachToChat` for the project the document is in.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import type { TrayItem } from '@web/stores/chat-attachments';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { TABLE_MENU_ROWS } from '@web/spaces/document/document-block-menu-rows';
import { DocumentProjectProvider } from '@web/spaces/document/document-project-context';
import type {
  HandleEditor,
  PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import {
  closeShared,
  focusBody,
  mountDocumentEditor,
  openSharedBody,
  selectBlockText,
  selectTextRange,
  waitForBar,
} from '@web/spaces/document/__tests__/bubble-bar-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { addToAgentTool, selectionItem } from '@web/spaces/document/document-to-agent';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';

const attachToChat = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _items: readonly TrayItem[]): Promise<void> => undefined),
);
vi.mock('@web/stores/attach-to-chat', () => ({ attachToChat }));

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  attachToChat.mockClear();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  closeShared();
});

/**
 * The first item handed to the tray in the first call.
 * @returns The item.
 */
function handed(): TrayItem {
  return attachToChat.mock.calls[0]![1][0]!;
}

describe('the bubble bar entry', () => {
  it('sits with the AI menu, right before it, with Comment alone at the far right', async () => {
    const editor = openSharedBody('<p>alpha bravo</p>');
    mountDocumentEditor(editor, false, 'project-1');
    focusBody(editor);
    selectBlockText(editor, 'alpha bravo');
    await waitForBar();

    const ids = [...document.querySelectorAll('[data-testid^="doc-bubble-"]')]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id?.startsWith('doc-bubble-sep-') || id?.startsWith('doc-bubble-tool-') || id === 'doc-bubble-ai');
    expect(ids.slice(-5)).toEqual([
      'doc-bubble-sep-ai',
      'doc-bubble-tool-addToAgent',
      'doc-bubble-ai',
      'doc-bubble-sep-comment',
      'doc-bubble-tool-comment',
    ]);
  });

  it('hands the selected words to the project the document is in', async () => {
    const editor = openSharedBody('<p>alpha bravo</p>');
    mountDocumentEditor(editor, false, 'project-1');
    focusBody(editor);
    selectBlockText(editor, 'alpha bravo');
    await waitForBar();

    fireEvent.click(screen.getByTestId('doc-bubble-tool-addToAgent'));

    await waitFor(() => expect(attachToChat).toHaveBeenCalledTimes(1));
    expect(attachToChat.mock.calls[0]![0]).toBe('project-1');
    expect(handed().chip?.data_snapshot).toEqual({ text: 'alpha bravo' });
    expect(handed().name).toBe('alpha bravo');
  });

  it('is unavailable over a selection of spaces only', async () => {
    const editor = openSharedBody('<p>a   b</p>');
    mountDocumentEditor(editor, false, 'project-1');
    focusBody(editor);
    selectTextRange(editor, 1, 4);
    await waitForBar();

    const entry = screen.getByTestId('doc-bubble-tool-addToAgent');
    expect((entry as HTMLButtonElement).disabled || entry.getAttribute('aria-disabled') === 'true').toBe(true);

    // Greyed, it still takes the press (it shows its name on hover), and the
    // press does nothing.
    fireEvent.click(entry);
    expect(attachToChat).not.toHaveBeenCalled();
  });

  it('hands a selection of spaces over an uploaded picture, which it holds', () => {
    const editor = openWith([
      { type: 'paragraph', content: '  ' },
      { type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } },
      { type: 'paragraph', content: '' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, view.state.doc.content.size - 3)));

    expect(addToAgentTool.canRun(editor as never)).toBe(true);
    expect(selectionItem(editor as never).chip?.data_snapshot).toMatchObject({ text: expect.stringContaining('https://cdn.test/a.png') });
  });

  it('hands a drag from spaces into a table whose only content is an uploaded picture, which takes the table whole', () => {
    const picture = { type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } };
    const editor = openWith([
      { type: 'paragraph', content: '  ' },
      tableBlock({ rows: [{ cells: ['', { blocks: [picture] }] }] }),
      { type: 'paragraph', content: '' },
    ]);
    const view = editor.prosemirrorView!;
    let firstCell = -1;
    view.state.doc.descendants((node, pos) => {
      if (firstCell < 0 && node.type.name === 'docTableCell') firstCell = pos;
      return firstCell < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, firstCell + 4)));

    expect(selectionItem(editor as never).chip?.data_snapshot).toMatchObject({ text: expect.stringContaining('https://cdn.test/a.png') });
    expect(addToAgentTool.canRun(editor as never)).toBe(true);
  });

  it('is unavailable over a selection of spaces over a picture still uploading', () => {
    const editor = openWith([
      { type: 'paragraph', content: '  ' },
      { type: 'image', props: { uploadId: 'up-1', url: '', name: 'a.png' } },
      { type: 'paragraph', content: '' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, view.state.doc.content.size - 3)));

    expect(addToAgentTool.canRun(editor as never)).toBe(false);
  });

  it('is not shown to a viewer', async () => {
    const editor = openSharedBody('<p>alpha bravo</p>');
    mountDocumentEditor(editor, true, 'project-1');
    focusBody(editor);
    selectBlockText(editor, 'alpha bravo');

    // The wait an editor's bar always comes up within (the cases above) runs
    // out with no bar at all.
    await expect(waitForBar()).rejects.toThrow();
    expect(screen.queryByTestId('doc-bubble-tool-addToAgent')).toBeNull();
  });
});

/**
 * Opens a mounted editor holding the blocks given.
 * @param blocks - The document.
 * @returns The editor.
 */
function openWith(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * A one-row table holding the two cells given.
 * @param cells - The cells' words.
 * @returns The block.
 */
function table(cells: [string, string]): unknown {
  return tableBlock({ rows: [{ cells }] });
}

/** Two rows: words, then an empty one. */
const TWO_ROWS = [
  { type: 'paragraph', content: 'alpha bravo' },
  { type: 'paragraph', content: '' },
];

/**
 * Opens the block menu over one block, inside a project.
 * @param editor - The editor.
 * @param index - Which block.
 * @param rows - The rows to draw; a block's grip rows when left out.
 * @returns The close callback the menu was handed.
 */
function openMenuOver(
  editor: Editor,
  index: number,
  rows?: typeof TABLE_MENU_ROWS,
): () => void {
  const close = vi.fn();
  const block = (editor.document as unknown as PressedBlock[])[index]!;
  render(
    <DocumentProjectProvider projectId='project-1'>
      <DropdownMenu open>
        <DropdownMenuTrigger />
        <DropdownMenuContent>
          <DocumentBlockMenu
            editor={editor as unknown as HandleEditor}
            block={block}
            close={close}
            rows={rows}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </DocumentProjectProvider>,
  );
  return close;
}

describe('the block menu row', () => {
  it('sits right after Comment and before Delete', () => {
    const editor = openWith(TWO_ROWS);
    openMenuOver(editor, 0);

    const rows = [...document.querySelectorAll('[data-testid^="doc-block-row-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    const at = rows.indexOf('doc-block-row-addToAgent');
    expect(at).toBe(rows.indexOf('doc-block-row-comment') + 1);
    expect(rows[at + 1]).toBe('doc-block-row-delete');
  });

  it('hands the block to the project and closes the menu', async () => {
    const editor = openWith(TWO_ROWS);
    const close = openMenuOver(editor, 0);
    const id = (editor.document as unknown as PressedBlock[])[0]!.id;

    fireEvent.click(screen.getByTestId('doc-block-row-addToAgent'));

    await waitFor(() => expect(attachToChat).toHaveBeenCalledTimes(1));
    expect(attachToChat.mock.calls[0]![0]).toBe('project-1');
    expect(handed().id).toBe(`document-block-${id}`);
    expect(handed().chip?.data_snapshot).toEqual({ text: 'alpha bravo' });
    expect(close).toHaveBeenCalled();
  });

  it('is unavailable over a row with no words, like Comment', () => {
    const editor = openWith(TWO_ROWS);
    openMenuOver(editor, 1);

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('doc-block-row-comment').getAttribute('aria-disabled')).toBe('true');
  });

  it('is unavailable over a row of spaces only, as the bubble bar entry is, while Comment works', () => {
    const editor = openWith([{ type: 'paragraph', content: '   ' }]);
    openMenuOver(editor, 0);

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('doc-block-row-comment').getAttribute('aria-disabled')).not.toBe('true');
  });

  // The row hands itself with the rows nested under it, so what those rows
  // hold is something to hand over as well.
  const NESTED: Record<string, unknown> = {
    'a list item of spaces with words nested under it': {
      type: 'bulletListItem',
      content: '   ',
      children: [{ type: 'bulletListItem', content: 'Shot list' }],
    },
    'an empty heading with words nested under it': {
      type: 'heading',
      content: '',
      children: [{ type: 'paragraph', content: 'Shot list' }],
    },
    'a row of spaces with an uploaded picture nested under it': {
      type: 'paragraph',
      content: '   ',
      children: [{ type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } }],
    },
  };

  it.each(Object.entries(NESTED))('hands %s over with what is nested', async (_kind, row) => {
    const editor = openWith([row]);
    openMenuOver(editor, 0);
    const id = (editor.document as unknown as PressedBlock[])[0]!.id;

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(screen.getByTestId('doc-block-row-addToAgent'));

    await waitFor(() => expect(attachToChat).toHaveBeenCalledTimes(1));
    expect(handed().id).toBe(`document-block-${id}`);
    expect(handed().chip?.data_snapshot).toEqual({ text: blocksMarkdown(editor, [editor.getBlock(id)!]) });
  });

  it('is unavailable over an empty row with only empty rows nested under it', () => {
    const editor = openWith([{ type: 'paragraph', content: ' ', children: [{ type: 'paragraph', content: '  ' }] }]);
    openMenuOver(editor, 0);

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the table entry\'s menu row', () => {
  it('sits right after Comment and before Delete', () => {
    const editor = openWith([table(['', 'cell text'])]);
    openMenuOver(editor, 0, TABLE_MENU_ROWS);

    const rows = [...document.querySelectorAll('[data-testid^="doc-block-row-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    const at = rows.indexOf('doc-block-row-addToAgent');
    expect(at).toBe(rows.indexOf('doc-block-row-comment') + 1);
    expect(rows[at + 1]).toBe('doc-block-row-delete');
  });

  it('hands the whole table to the project', async () => {
    const editor = openWith([table(['', 'cell text'])]);
    const close = openMenuOver(editor, 0, TABLE_MENU_ROWS);
    const id = (editor.document as unknown as PressedBlock[])[0]!.id;
    const markdown = blocksMarkdown(editor, [editor.getBlock(id)!]);

    fireEvent.click(screen.getByTestId('doc-block-row-addToAgent'));

    await waitFor(() => expect(attachToChat).toHaveBeenCalledTimes(1));
    expect(handed().id).toBe(`document-block-${id}`);
    expect(handed().name).toBe('cell text');
    expect(handed().chip?.data_snapshot).toEqual({ text: markdown });
    expect(markdown).toContain('cell text');
    expect(close).toHaveBeenCalled();
  });

  it('is unavailable over a table with no words, like Comment', () => {
    const editor = openWith([table(['', ''])]);
    openMenuOver(editor, 0, TABLE_MENU_ROWS);

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('doc-block-row-comment').getAttribute('aria-disabled')).toBe('true');
  });

  it('hands a table whose only content is an uploaded picture', async () => {
    const picture = { type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } };
    const editor = openWith([tableBlock({ rows: [{ cells: ['', { blocks: [picture] }] }] })]);
    openMenuOver(editor, 0, TABLE_MENU_ROWS);

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(screen.getByTestId('doc-block-row-addToAgent'));

    await waitFor(() => expect(attachToChat).toHaveBeenCalledTimes(1));
    expect(handed().chip?.data_snapshot).toMatchObject({ text: expect.stringContaining('https://cdn.test/a.png') });
  });

  it('is unavailable over a table whose cells hold spaces only, while Comment works', () => {
    const editor = openWith([table(['   ', ' '])]);
    openMenuOver(editor, 0, TABLE_MENU_ROWS);

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('doc-block-row-comment').getAttribute('aria-disabled')).not.toBe('true');
  });
});
