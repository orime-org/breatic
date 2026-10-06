// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { documentBodyFragment } from '@breatic/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
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
  waitForBar,
} from '@web/spaces/document/__tests__/bubble-bar-harness';

const attachToChat = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _items: readonly unknown[]): Promise<void> => undefined),
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

/** The first item handed to the tray in the first call. */
function handed(): { id: string; name: string; chip?: { data_snapshot: unknown } } {
  const call = attachToChat.mock.calls[0] as unknown as [string, Array<{ id: string; name: string; chip?: { data_snapshot: unknown } }>];
  return call[1][0]!;
}

describe('the bubble bar entry', () => {
  it('sits right after Comment', async () => {
    const editor = openSharedBody('<p>alpha bravo</p>');
    mountDocumentEditor(editor, false, 'project-1');
    focusBody(editor);
    selectBlockText(editor, 'alpha bravo');
    await waitForBar();

    const ids = [...document.querySelectorAll('[data-testid^="doc-bubble-tool-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ids.indexOf('doc-bubble-tool-addToAgent')).toBe(ids.indexOf('doc-bubble-tool-comment') + 1);
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
 * Opens a mounted editor holding two blocks: words, then an empty row.
 * @returns The editor.
 */
function openBlocks(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha bravo' },
    { type: 'paragraph', content: '' },
  ] as never);
  return editor;
}

/**
 * Opens the block menu over one block, inside a project.
 * @param editor - The editor.
 * @param index - Which block.
 * @returns The close callback the menu was handed.
 */
function openMenuOver(editor: Editor, index: number): () => void {
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
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </DocumentProjectProvider>,
  );
  return close;
}

describe('the block menu row', () => {
  it('sits right after Comment and before Delete', () => {
    const editor = openBlocks();
    openMenuOver(editor, 0);

    const rows = [...document.querySelectorAll('[data-testid^="doc-block-row-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    const at = rows.indexOf('doc-block-row-addToAgent');
    expect(at).toBe(rows.indexOf('doc-block-row-comment') + 1);
    expect(rows[at + 1]).toBe('doc-block-row-delete');
  });

  it('hands the block to the project and closes the menu', async () => {
    const editor = openBlocks();
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
    const editor = openBlocks();
    openMenuOver(editor, 1);

    expect(screen.getByTestId('doc-block-row-addToAgent').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('doc-block-row-comment').getAttribute('aria-disabled')).toBe('true');
  });
});
