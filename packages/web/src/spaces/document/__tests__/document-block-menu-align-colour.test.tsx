// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #995: the block handle menu's two new rows, wired.
 *
 * Both open what the bubble bar opens — the same three alignment rows, the
 * same colour panel — and both act on the block the pointer is over rather
 * than on the reader's selection (A5). The handle is on screen only while the
 * reader holds no selection (`DocumentBlockHandle.tsx:125`), so "reads the
 * hovered block" is not a refinement here: reading the state instead would
 * answer about the reader's caret every single time.
 *
 * A row that cannot act owes three things (`document-bubble-slots.tsx`), and
 * in a menu the first of them means the submenu does not open at all. Radix's
 * `MenuSubTrigger` consults `props.disabled` and `event.defaultPrevented` and
 * nothing else, so `aria-disabled` alone would draw a row that greys and
 * opens anyway.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import type {
  HandleEditor,
  PressedBlock,
} from '@web/spaces/document/document-handle-commands';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface Seen {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content?: readonly { readonly styles?: Record<string, unknown> }[];
}

/**
 * An editor holding one block of each kind these cases need.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha words' },
    { type: 'paragraph', content: 'elsewhere', props: { textAlignment: 'center' } },
    { type: 'bulletListItem', content: 'an item' },
    { type: 'codeBlock', content: 'some code' },
    { type: 'paragraph', content: '' },
  ] as never);
  return editor;
}

/** Every block, as the document holds it. */
function blocks(editor: Editor): Seen[] {
  return editor.document as unknown as Seen[];
}

/**
 * Puts the reader's caret in the second block, where the block handle's own
 * condition says it cannot be — which is the point: every reading the rows do
 * has to ignore it.
 * @param editor - The editor.
 */
function caretElsewhere(editor: Editor): void {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  const range = selectionOverBlockContent(doc, blocks(editor)[1]!.id);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, range.from)),
  );
}

/**
 * Opens the menu over one block.
 * @param editor - The editor.
 * @param index - Which block the pointer is over.
 * @returns What the menu was handed to close itself with.
 */
function openMenuOver(editor: Editor, index: number): { close: () => void } {
  const close = vi.fn();
  const block = blocks(editor)[index]!;
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger />
      <DropdownMenuContent>
        <DocumentBlockMenu
          editor={editor as unknown as HandleEditor}
          block={block as unknown as PressedBlock}
          close={close}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return { close };
}

/** The styles on every run of one block. */
function runStyles(editor: Editor, index: number): Record<string, unknown>[] {
  return (blocks(editor)[index]!.content ?? []).map((run) => run.styles ?? {});
}

describe('the two rows are there and open what the bubble bar opens', () => {
  it('holds an alignment row and a colour row', () => {
    const editor = open();
    openMenuOver(editor, 0);

    expect(screen.getByTestId('doc-block-row-align')).toBeTruthy();
    expect(screen.getByTestId('doc-block-row-color')).toBeTruthy();
  });

  it('opens the same three alignment rows', () => {
    const editor = open();
    openMenuOver(editor, 0);

    fireEvent.click(screen.getByTestId('doc-block-row-align'));

    ['left', 'center', 'right'].forEach((id) => {
      expect(screen.getByTestId(`doc-block-align-${id}`)).toBeTruthy();
    });
  });

  it('opens the colour panel', () => {
    const editor = open();
    openMenuOver(editor, 0);

    fireEvent.click(screen.getByTestId('doc-block-row-color'));

    expect(screen.getByTestId('doc-block-color-text-red')).toBeTruthy();
    expect(screen.getByTestId('doc-block-color-fill-none')).toBeTruthy();
    expect(screen.getByTestId('doc-block-color-reset')).toBeTruthy();
  });
});

describe('both rows act on the hovered block', () => {
  it('aligns the hovered block, leaving the reader’s caret block alone', () => {
    const editor = open();
    caretElsewhere(editor);
    const { close } = openMenuOver(editor, 0);

    fireEvent.click(screen.getByTestId('doc-block-row-align'));
    fireEvent.click(screen.getByTestId('doc-block-align-right'));

    expect(blocks(editor)[0]!.props['textAlignment']).toBe('right');
    expect(blocks(editor)[1]!.props['textAlignment']).toBe('center');
    expect(close).toHaveBeenCalled();
  });

  it('colours every run of the hovered block, not the reader’s', () => {
    const editor = open();
    caretElsewhere(editor);
    const { close } = openMenuOver(editor, 0);

    fireEvent.click(screen.getByTestId('doc-block-row-color'));
    fireEvent.click(screen.getByTestId('doc-block-color-text-red'));

    expect(runStyles(editor, 0).length).toBeGreaterThan(0);
    runStyles(editor, 0).forEach((styles) => {
      expect(styles['textColor']).toBe('red');
    });
    runStyles(editor, 1).forEach((styles) => {
      expect(styles['textColor']).toBeUndefined();
    });
    expect(close).toHaveBeenCalled();
  });

  it('ticks the alignment the hovered block is on', () => {
    const editor = open();
    caretElsewhere(editor);
    openMenuOver(editor, 1);

    fireEvent.click(screen.getByTestId('doc-block-row-align'));

    expect(
      screen.getByTestId('doc-block-align-center').getAttribute('data-ticked'),
    ).toBe('true');
    expect(
      screen.getByTestId('doc-block-align-left').getAttribute('data-ticked'),
    ).toBeNull();
  });

  it('marks the colour cell the hovered block carries', () => {
    const editor = open();
    editor.updateBlock(blocks(editor)[0]!.id as never, {
      content: [
        { type: 'text', text: 'alpha words', styles: { textColor: 'blue' } },
      ],
    } as never);
    caretElsewhere(editor);
    openMenuOver(editor, 0);

    fireEvent.click(screen.getByTestId('doc-block-row-color'));

    expect(
      screen.getByTestId('doc-block-color-text-blue').getAttribute('data-selected'),
    ).toBe('true');
  });
});

describe('a row that cannot act', () => {
  it('greys the alignment row on a list item and refuses to open it', () => {
    const editor = open();
    const row = (() => {
      openMenuOver(editor, 2);
      return screen.getByTestId('doc-block-row-align');
    })();

    expect(row.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(row);

    expect(screen.queryByTestId('doc-block-align-left')).toBeNull();
  });

  it('leaves the alignment row live on a paragraph', () => {
    const editor = open();
    openMenuOver(editor, 0);

    expect(
      screen.getByTestId('doc-block-row-align').getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('greys both rows on a code block', () => {
    const editor = open();
    openMenuOver(editor, 3);

    expect(
      screen.getByTestId('doc-block-row-align').getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByTestId('doc-block-row-color').getAttribute('aria-disabled'),
    ).toBe('true');
  });

  // An empty paragraph can be centred — the caret goes with it — but it holds
  // no run to colour, so a colour press would be a control that looks usable
  // and does nothing (R7).
  it('keeps alignment live on an empty block and greys colour', () => {
    const editor = open();
    caretElsewhere(editor);
    openMenuOver(editor, 4);

    expect(
      screen.getByTestId('doc-block-row-align').getAttribute('aria-disabled'),
    ).toBeNull();
    expect(
      screen.getByTestId('doc-block-row-color').getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('refuses to open a greyed colour row by keyboard as well', () => {
    const editor = open();
    openMenuOver(editor, 3);

    const row = screen.getByTestId('doc-block-row-color');
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    expect(screen.queryByTestId('doc-block-color-text-red')).toBeNull();
  });
});
