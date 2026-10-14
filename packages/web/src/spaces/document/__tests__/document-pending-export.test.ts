// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A pending media block leaves the body as one line of text: its name and
 * that its upload is not finished (inner#1351 design §5.10). It has no
 * address to export, and an empty `<img>` tells the Agent or another app
 * nothing.
 */

import { AllSelection } from '@tiptap/pm/state';
import { selectedFragmentToHTML } from '@blocknote/core';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, t } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blockItem, selectionItem } from '@web/spaces/document/document-to-agent';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens a body holding a pending block of this type between two lines.
 * @param type - The media type.
 * @returns The editor.
 */
function open(type: 'image' | 'video' | 'audio'): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'Above' },
    { type, props: { url: '', uploadId: 'u1', name: 'Hero', caption: 'Hero' } },
    { type: 'paragraph', content: 'Below' },
  ] as never);
  return editor;
}

const LINE = (): string => t('spaces.document.media.pendingExport', { name: 'Hero' });

describe.each(['image', 'video', 'audio'] as const)('a pending %s block', (type) => {
  it('exports to outside HTML as its name and that the upload is not finished, with no media element', () => {
    const editor = open(type);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    const { externalHTML } = selectedFragmentToHTML(view, editor);
    expect(externalHTML).toContain(LINE());
    expect(externalHTML).not.toMatch(/<(img|video|audio)\b/);
  });

  it('goes to the Agent as that line, from a selection and from the block itself', () => {
    const editor = open(type);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(JSON.stringify(selectionItem(editor))).toContain(LINE());
    const id = (editor.document as unknown as { id: string }[])[1]!.id;
    expect(JSON.stringify(blockItem(editor, id))).toContain(LINE());
  });
});
