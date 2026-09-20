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
import * as React from 'react';
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

/**
 * What the colour panel was handed, render by render.
 *
 * The panel is memoised, so the menu owes it props that keep their identity
 * while nothing they say has moved — `packages/web/CLAUDE.md` calls a memo
 * that can never bail a defect of its own. This records them from inside.
 */
const panelProps = vi.hoisted(
  () => [] as { face: unknown; onSet: unknown; onClear: unknown }[],
);

vi.mock('@web/spaces/document/document-colour-panel', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@web/spaces/document/document-colour-panel')
    >();
  const Real = actual.DocumentColourPanel;
  return {
    ...actual,
    DocumentColourPanel: (props: React.ComponentProps<typeof Real>) => {
      panelProps.push({
        face: props.face,
        onSet: props.onSet,
        onClear: props.onClear,
      });
      return <Real {...props} />;
    },
  };
});

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  panelProps.length = 0;
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
 * Puts the reader's caret in one block and leaves it there.
 * @param editor - The editor.
 * @param index - Which block.
 */
function caretIn(editor: Editor, index: number): void {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  const range = selectionOverBlockContent(doc, blocks(editor)[index]!.id);
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, range.from)),
  );
}

/**
 * Puts the reader's caret in the second block, where the block handle's own
 * condition says it cannot be — which is the point: every reading the rows do
 * has to ignore it.
 * @param editor - The editor.
 */
function caretElsewhere(editor: Editor): void {
  caretIn(editor, 1);
}

/**
 * Opens the menu over one block.
 * @param editor - The editor.
 * @param index - Which block the pointer is over.
 * @returns What the menu was handed to close itself with.
 */
function openMenuOver(
  editor: Editor,
  index: number,
): { close: () => void; again: () => void } {
  const close = vi.fn();
  const block = blocks(editor)[index]!;
  // A fresh element each time: React skips a subtree handed the very same
  // element object, so reusing one would re-render nothing and measure
  // nothing.
  const tree = (): React.JSX.Element => (
    <DropdownMenu open>
      <DropdownMenuTrigger />
      <DropdownMenuContent>
        <DocumentBlockMenu
          editor={editor as unknown as HandleEditor}
          block={block as unknown as PressedBlock}
          close={close}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const { rerender } = render(tree());
  return {
    close,
    again: () => {
      rerender(tree());
    },
  };
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
    // The caret sits in the FIRST block, which is left-aligned, while the
    // menu opens over the second, which is centred: a reading that answered
    // about the reader would tick `left` here.
    caretIn(editor, 0);
    openMenuOver(editor, 1);

    fireEvent.click(screen.getByTestId('doc-block-row-align'));

    expect(
      screen.getByTestId('doc-block-align-center').getAttribute('data-ticked'),
    ).toBe('true');
    expect(
      screen.getByTestId('doc-block-align-left').getAttribute('data-ticked'),
    ).toBeNull();
  });

  it('takes a colour off the hovered block from the default cell', () => {
    const editor = open();
    editor.updateBlock(blocks(editor)[0]!.id as never, {
      content: [
        { type: 'text', text: 'alpha words', styles: { textColor: 'blue' } },
      ],
    } as never);
    caretElsewhere(editor);
    openMenuOver(editor, 0);

    fireEvent.click(screen.getByTestId('doc-block-row-color'));
    fireEvent.click(screen.getByTestId('doc-block-color-text-default'));

    runStyles(editor, 0).forEach((styles) => {
      expect(styles['textColor']).toBeUndefined();
    });
  });

  it('reads the hovered row again at press time, not at menu-open time', () => {
    const editor = open();
    caretElsewhere(editor);
    openMenuOver(editor, 0);
    fireEvent.click(screen.getByTestId('doc-block-row-align'));
    // A co-editor puts a row above the one the menu is about, which moves
    // every position after it. The menu stays open on the same row.
    editor.insertBlocks(
      [{ type: 'paragraph', content: 'arrived first' }] as never,
      blocks(editor)[0]!.id as never,
      'before',
    );

    fireEvent.click(screen.getByTestId('doc-block-align-right'));

    // The new row first, then the one the menu was about carrying the press,
    // then the centred one the fixture opens with.
    expect(blocks(editor).map((row) => row.props['textAlignment'])).toEqual([
      'left',
      'right',
      'center',
      'left',
      // A code block carries no alignment prop at all.
      undefined,
      'left',
    ]);
  });

  it('reads the hovered row again when a colour is pressed', () => {
    const editor = open();
    caretElsewhere(editor);
    openMenuOver(editor, 0);
    fireEvent.click(screen.getByTestId('doc-block-row-color'));
    // A co-editor puts a row above the one the menu is about, which moves
    // every position after it.
    editor.insertBlocks(
      [{ type: 'paragraph', content: 'arrived first' }] as never,
      blocks(editor)[0]!.id as never,
      'before',
    );

    fireEvent.click(screen.getByTestId('doc-block-color-text-red'));

    expect(runStyles(editor, 1).length).toBeGreaterThan(0);
    runStyles(editor, 1).forEach((styles) => {
      expect(styles['textColor']).toBe('red');
    });
    runStyles(editor, 0).forEach((styles) => {
      expect(styles['textColor']).toBeUndefined();
    });
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

describe('what the memoised colour panel is handed', () => {
  // All three props keep their identity across a render that changed nothing,
  // which is what lets the panel's own `React.memo` bail. A reading rebuilt
  // per render, or a callback written inline in the JSX, would be a new
  // reference every time and the memo would never hold.
  it('keeps every prop while nothing it says has moved', () => {
    const editor = open();
    const { again } = openMenuOver(editor, 0);
    fireEvent.click(screen.getByTestId('doc-block-row-color'));
    const before = panelProps.length;

    again();

    expect(panelProps.length).toBeGreaterThan(before);
    const first = panelProps[before - 1]!;
    const second = panelProps[panelProps.length - 1]!;
    expect(second.face).toBe(first.face);
    expect(second.onSet).toBe(first.onSet);
    expect(second.onClear).toBe(first.onClear);
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

  // All three keys Radix opens a submenu with, not just the arrow: its own
  // handler treats Enter and Space the same way, so cancelling one of the
  // three leaves two ways in.
  it.each(['ArrowRight', 'Enter', ' '])(
    'refuses to open a greyed colour row on %s',
    (key) => {
      const editor = open();
      openMenuOver(editor, 3);

      fireEvent.keyDown(screen.getByTestId('doc-block-row-color'), { key });

      expect(screen.queryByTestId('doc-block-color-text-red')).toBeNull();
    },
  );
});
