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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  cleanup();
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
        <div data-region='space'>
          <DocumentEditor handle={{ editor, surface }} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} />
        </div>
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
    // Hidden, still mounted: its folded headings come back with it.
    expect(screen.getByTestId('doc-outline-column')).not.toBeVisible();
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
    expect(editor.prosemirrorView!.hasFocus()).toBe(true);
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

describe('round 1 of the implementation review (breatic#1427)', () => {
  it('leaves full screen alone for an Escape outside the editor that something else already took', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    const id = enter(editor);
    const exit = await screen.findByTestId('doc-table-fullscreen-exit');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();

    exit.dispatchEvent(event);

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });

  it('keeps the place in a long table when its Space is hidden and shown again', async () => {
    const { editor, surface } = open();
    /**
     * The area inside a Space tab that can be hidden.
     * @param hidden - Whether the tab is hidden.
     * @returns The element tree.
     */
    const tab = (hidden: boolean): React.JSX.Element => (
      <React.Activity mode={hidden ? 'hidden' : 'visible'}>{area(editor, surface, false)}</React.Activity>
    );
    const { rerender } = render(tab(false));
    enter(editor);
    await screen.findByTestId('doc-table-fullscreen-exit');
    const scrolled = vi.spyOn(Element.prototype, 'scrollTo');

    rerender(tab(true));
    rerender(tab(false));

    expect(scrolled).not.toHaveBeenCalledWith({ top: 0 });
    scrolled.mockRestore();
  });
});

describe('round 2 of the implementation review (breatic#1427)', () => {
  it('leaves full screen alone for the Escape that comes right after an input method ends outside the editor', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    const id = enter(editor);
    const exit = await screen.findByTestId('doc-table-fullscreen-exit');

    exit.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    fireEvent.keyDown(exit, { key: 'Escape' });

    expect(tableFullscreenIn(editor.prosemirrorState).table).toBe(id);
  });

  it('keeps an open comment panel mounted and hidden, so it comes back as it was', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    await userEvent.click(screen.getByTestId('doc-doc-menu-trigger'));
    await userEvent.click(await screen.findByTestId('doc-doc-menu-comments'));
    const rail = await screen.findByTestId('doc-comment-rail');

    enter(editor);

    await waitFor(() => expect(rail).not.toBeVisible());
    expect(rail.isConnected).toBe(true);
    fireEvent.click(await screen.findByTestId('doc-table-fullscreen-exit'));
    await waitFor(() => expect(screen.getByTestId('doc-comment-rail')).toBe(rail));
    expect(rail).toBeVisible();
  });

  /**
   * Gives an element a fixed box.
   * @param element - The element.
   * @param top - Its top.
   * @param height - Its height.
   */
  function boxAt(element: Element, top: number, height: number): void {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
  }

  it('scrolls back to the table at the distance it stood at on entry', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    const viewport = surface.closest('[data-radix-scroll-area-viewport]')!;
    const table = surface.querySelector('[data-node-type=\'docTable\']')!;
    boxAt(viewport, 100, 600);
    boxAt(table, 400, 200);
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 1000, writable: true });
    const id = tableId(editor);
    act(() => {
      setTableFullscreen(editor, { table: id, scrollTop: 1000, offset: 60 });
    });
    const scrolled = vi.spyOn(viewport, 'scrollTo');

    fireEvent.click(await screen.findByTestId('doc-table-fullscreen-exit'));

    // The table's top stood 60 below the scroller's top: 1000 + (400 - 100) - 60.
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 1240 }));
  });

  it('scrolls back to where the body was when the table went away', async () => {
    const { editor, surface } = open();
    render(area(editor, surface, false));
    const viewport = surface.closest('[data-radix-scroll-area-viewport]')!;
    const id = tableId(editor);
    act(() => {
      setTableFullscreen(editor, { table: id, scrollTop: 777, offset: 60 });
    });
    const scrolled = vi.spyOn(viewport, 'scrollTo');

    act(() => {
      editor.removeBlocks([id]);
    });

    await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ top: 777 }));
  });
});
