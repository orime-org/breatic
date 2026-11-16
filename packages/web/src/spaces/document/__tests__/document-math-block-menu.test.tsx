// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1423 A7, design §6.2 and §6.5: the block handle menu over a formula.
 *
 * A formula is not a text block for these rows: like a media block it
 * cannot become another type or be quoted, has no alignment or colour of its
 * own and holds no words a comment could mark. Duplicate, insert below, add to
 * Agent and delete act on it as on any block.
 * `canCommentOver` is the same answer for any range over a formula.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
import { canCommentOver } from '@web/spaces/document/document-comment-target';
import { DocumentProjectProvider } from '@web/spaces/document/document-project-context';
import type { HandleEditor, PressedBlock } from '@web/spaces/document/document-handle-commands';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';

type Editor = ReturnType<typeof buildDocumentEditor>;

/** A block as `editor.document` hands it back. */
interface Seen {
  readonly id: string;
}

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * An editor holding a formula block and a paragraph with an inline formula.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'mathBlock', props: { source: '\\frac{a}{b}' } },
    { type: 'paragraph', content: [{ type: 'math', props: { source: 'E = mc^2' } }] },
  ] as never);
  return editor;
}

/**
 * Opens the menu over one block.
 * @param editor - The editor.
 * @param index - Which block the pointer is over.
 */
function openMenuOver(editor: Editor, index: number): void {
  const block = (editor.document as unknown as Seen[])[index]!;
  render(
    // Add to Agent is drawn only inside a project.
    <DocumentProjectProvider projectId='project-1'>
      <DropdownMenu open>
        <DropdownMenuTrigger />
        <DropdownMenuContent>
          <DocumentBlockMenu
            editor={editor as unknown as HandleEditor}
            block={block as unknown as PressedBlock}
            close={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </DocumentProjectProvider>,
  );
}

/**
 * Whether a row of the open menu reads as greyed.
 * @param id - The row's id.
 * @returns True when it carries `aria-disabled="true"`.
 */
function greyed(id: string): boolean {
  return screen.getByTestId(`doc-block-row-${id}`).getAttribute('aria-disabled') === 'true';
}

describe('the handle menu over a formula block', () => {
  it.each(['align', 'color', 'comment'])('greys %s', (id) => {
    const editor = open();
    openMenuOver(editor, 0);
    expect(greyed(id)).toBe(true);
  });

  it.each(['duplicate', 'insertBelow', 'addToAgent', 'delete'])('leaves %s live', (id) => {
    const editor = open();
    openMenuOver(editor, 0);
    expect(greyed(id)).toBe(false);
  });

  it('greys every row of the block type submenu, as over a media block', () => {
    const editor = open();
    openMenuOver(editor, 0);

    fireEvent.click(screen.getByTestId('doc-block-row-blockType'));

    for (const id of ['paragraph', 'heading-1', 'heading-2', 'heading-3', 'code-block', 'bullet-list', 'task-list', 'ordered-list', 'quote']) {
      expect(screen.getByTestId(`doc-block-type-${id}`).getAttribute('aria-disabled')).toBe('true');
    }
  });
});

describe('a comment over a formula', () => {
  it('cannot land on a formula block', () => {
    const editor = open();
    const { doc } = editor.prosemirrorState;
    const id = (editor.document as unknown as Seen[])[0]!.id;
    expect(canCommentOver(doc, selectionOverBlockContent(doc, id))).toBe(false);
  });

  it('cannot land on an inline formula', () => {
    const editor = open();
    const { doc } = editor.prosemirrorState;
    let at = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'math') at = pos;
      return true;
    });
    expect(at).toBeGreaterThan(0);
    expect(canCommentOver(doc, TextSelection.create(doc, at, at + 1))).toBe(false);
  });
});
