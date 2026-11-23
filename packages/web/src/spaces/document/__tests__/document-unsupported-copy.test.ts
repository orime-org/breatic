// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A copy or a drag of a selection that holds a stand-in block: what an older
 * build could not read is written out as an empty element naming it, so the
 * rest of the selection still reaches the clipboard.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AllSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { written, type Editor } from '@web/spaces/document/__tests__/paste-harness';

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding these blocks, everything selected.
 * @param blocks - The body.
 * @returns The editor.
 */
function openAllSelected(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  const view = editor.prosemirrorView;
  view.focus();
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  return editor;
}

describe('a selection holding a stand-in block', () => {
  const body = [
    { type: 'paragraph', content: 'before' },
    { type: 'unsupportedBlock', props: { originalName: 'futureBlock' } },
    { type: 'paragraph', content: 'after' },
  ];

  it('copies the words around it', () => {
    const editor = openAllSelected(body);

    const plain = written(editor.prosemirrorView.dom, 'copy')['text/plain'] ?? '';

    expect(plain).toContain('before');
    expect(plain).toContain('after');
  });

  it('gives a drag of it the plain text a copy writes', () => {
    const editor = openAllSelected(body);
    const dragged = written(editor.prosemirrorView.dom, 'dragstart');

    expect(dragged['text/plain']).toBe(written(editor.prosemirrorView.dom, 'copy')['text/plain']);
  });
});

describe('a stand-in block on the page', () => {
  it('names its type where BlockNote finds a block from the element under the pointer', () => {
    const editor = openAllSelected([{ type: 'paragraph', content: 'before' }, { type: 'unsupportedBlock', props: { originalName: 'futureBlock' } }]);

    const element = editor.prosemirrorView.dom.querySelector('[data-unsupported-block]');

    expect(element?.getAttribute('data-content-type')).toBe('unsupportedBlock');
  });
});
