// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the user sees of a table opened full screen (breatic#1427, design
 * §5.1 and §5.4): the row that opens it, the editor area covering the window
 * with only the table, the way out, and the entries full screen leaves out.
 *
 * TDD: red because nothing opens a table full screen yet.
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent, t } from '@breatic/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { TABLE_MENU_ROWS } from '@web/spaces/document/document-block-menu-rows';
import type { HandleEditor, PressedBlock } from '@web/spaces/document/document-handle-commands';
import { DocumentProjectProvider } from '@web/spaces/document/document-project-context';
import { setTableFullscreen, tableFullscreenIn } from '@web/spaces/document/document-table-fullscreen';
import { waitForBar } from '@web/spaces/document/__tests__/bubble-bar-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/** A two by two table between two paragraphs. */
const BODY = [
  { type: 'paragraph', content: 'Before' },
  tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
  { type: 'paragraph', content: 'After' },
];

/**
 * An editor holding {@link BODY}, mounted on its own surface.
 * @returns The editor and the surface it is mounted on.
 */
function open(): { editor: Editor; surface: HTMLElement } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const surface = document.createElement('div');
  document.body.appendChild(surface);
  editor.mount(surface);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, BODY as never);
  return { editor, surface };
}

/**
 * The editor area, the way the document Space draws it.
 * @param editor - The editor.
 * @param surface - Its surface.
 * @param readOnly - True for a viewer.
 * @returns The element tree.
 */
function area(editor: Editor, surface: HTMLElement, readOnly: boolean): React.JSX.Element {
  return (
    <TooltipProvider>
      <DocumentProjectProvider projectId='project-1'>
        <DocumentEditor handle={{ editor, surface }} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} />
      </DocumentProjectProvider>
    </TooltipProvider>
  );
}

/**
 * The first table's block id.
 * @param editor - The editor.
 * @returns The id.
 */
function tableId(editor: Editor): string {
  return (editor.document as unknown as { id: string; type: string }[]).find((block) => block.type === 'docTable')!.id;
}

/**
 * Opens the table full screen.
 * @param editor - The editor.
 * @returns The table's id.
 */
function enter(editor: Editor): string {
  const id = tableId(editor);
  act(() => {
    setTableFullscreen(editor, { table: id, scrollTop: 0, offset: 0 });
  });
  return id;
}

describe('the table entry\'s full-screen row', () => {
  it('comes first, named Full screen', () => {
    expect(TABLE_MENU_ROWS[0]).toMatchObject({ id: 'fullscreen', labelKey: 'spaces.document.table.fullscreen' });
    expect(t('spaces.document.table.fullscreen')).toBe('Full screen');
  });

  it('opens the table full screen and closes the menu', () => {
    const { editor } = open();
    const close = vi.fn();
    const block = (editor.document as unknown as PressedBlock[]).find((b) => b.type === 'docTable')!;
    render(
      <DocumentProjectProvider projectId='project-1'>
        <DropdownMenu open>
          <DropdownMenuTrigger />
          <DropdownMenuContent>
            <DocumentBlockMenu editor={editor as unknown as HandleEditor} block={block} close={close} rows={TABLE_MENU_ROWS} />
          </DropdownMenuContent>
        </DropdownMenu>
      </DocumentProjectProvider>,
    );

    fireEvent.click(screen.getByTestId('doc-block-row-fullscreen'));

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(block.id);
    expect(close).toHaveBeenCalled();
  });
});

describe('the editor area in full screen', () => {
  it('covers the window, showing the table and the way out, without the outline or the document menu', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    expect(screen.getByTestId('doc-outline-column')).toBeInTheDocument();

    enter(editor);

    await waitFor(() => expect(document.querySelector('[data-table-fullscreen]')).not.toBeNull());
    expect(screen.queryByTestId('doc-outline-column')).toBeNull();
    expect(screen.queryByTestId('doc-doc-menu-trigger')).toBeNull();
    const exit = screen.getByTestId('doc-table-fullscreen-exit');
    expect(exit.getAttribute('aria-label')).toBe(t('spaces.document.table.exitFullscreen'));
  });

  it('marks the table it shows', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));

    enter(editor);

    await waitFor(() => expect(surface.querySelector('.doc-table[data-fullscreen-table]')).not.toBeNull());
    expect(surface.querySelectorAll('[data-fullscreen-table]')).toHaveLength(1);
  });

  it('goes back to the body on the way-out button', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    enter(editor);
    const exit = await screen.findByTestId('doc-table-fullscreen-exit');

    fireEvent.click(exit);

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBeNull();
    await waitFor(() => expect(document.querySelector('[data-table-fullscreen]')).toBeNull());
    expect(screen.getByTestId('doc-outline-column')).toBeInTheDocument();
  });

  it('goes back to the body on an Escape pressed outside the editor', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    enter(editor);
    const exit = await screen.findByTestId('doc-table-fullscreen-exit');
    exit.focus();

    fireEvent.keyDown(exit, { key: 'Escape' });

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBeNull();
  });

  it('stays on an Escape an input method is using', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    const id = enter(editor);
    const exit = await screen.findByTestId('doc-table-fullscreen-exit');

    fireEvent.keyDown(exit, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(exit, { key: 'Escape', keyCode: 229 });

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });

  it('goes back to the body when the editor turns read-only', async () => {
    const { editor, surface } = open();
    const { rerender } = render(area(editor, surface, false));
    enter(editor);
    await screen.findByTestId('doc-table-fullscreen-exit');

    rerender(area(editor, surface, true));

    await waitFor(() => expect(tableFullscreenIn(editor.prosemirrorState).table).toBeNull());
  });

  it('leaves Comment and Add to Agent out of the bubble bar over words in a cell', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    enter(editor);
    const view = editor.prosemirrorView!;
    let from = -1;
    view.state.doc.descendants((node, pos) => {
      if (from < 0 && node.isText && node.text === 'a1') from = pos;
      return from < 0;
    });
    act(() => {
      view.dom.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 2)));
    });
    await waitForBar();

    expect(screen.queryByTestId('doc-bubble-tool-comment')).toBeNull();
    expect(screen.queryByTestId('doc-bubble-tool-addToAgent')).toBeNull();
    expect(screen.getByTestId('doc-bubble-ai')).toBeInTheDocument();
  });

  it('keeps Comment and Add to Agent in the bubble bar in the body', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    const view = editor.prosemirrorView!;
    let from = -1;
    view.state.doc.descendants((node, pos) => {
      if (from < 0 && node.isText && node.text === 'a1') from = pos;
      return from < 0;
    });
    act(() => {
      view.dom.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 2)));
    });
    await waitForBar();

    expect(screen.getByTestId('doc-bubble-tool-comment')).toBeInTheDocument();
    expect(screen.getByTestId('doc-bubble-tool-addToAgent')).toBeInTheDocument();
  });
});
