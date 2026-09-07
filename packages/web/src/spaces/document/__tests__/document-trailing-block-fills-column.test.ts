// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The affordance under the last block reaches the whole space below it.
 *
 * BlockNote gives it a 30px strip. The editable surface is carried to the
 * bottom of the scroll viewport, and a press anywhere in that space opened a
 * paragraph before the migration — so the strip has to grow into the rest of
 * the column.
 *
 * These cases ask the DOM whether each selector in the chain MATCHES, which is
 * what a rule read off the stylesheet cannot answer: the widget is drawn at
 * `doc.content.size - 1`, so it sits inside the root `blockGroup` rather than
 * beside it, and a selector naming it as a child of `.ProseMirror` matched
 * nothing while reading perfectly well.
 *
 * Layout itself is measured in a browser (`tests/smoke/`); jsdom computes none.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const live: ReturnType<typeof buildDocumentEditor>[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  live.splice(0).forEach((editor) => {
    editor.unmount();
  });
  containers.splice(0).forEach((element) => {
    element.remove();
  });
});

/**
 * Opens a document under a `.doc-body-editor` wrapper, the way the Space does.
 * @returns The wrapper the rules are matched against.
 */
async function open(): Promise<HTMLElement> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  live.push(editor);
  const wrapper = document.createElement('div');
  wrapper.className = 'doc-body-editor';
  const surface = document.createElement('div');
  wrapper.appendChild(surface);
  document.body.appendChild(wrapper);
  containers.push(wrapper);
  editor.mount(surface);
  editor.replaceBlocks(editor.document, [
    { type: 'codeBlock', content: 'const a = 1' },
  ] as never);
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
  return wrapper;
}

describe('the selectors that give the affordance the rest of the column', () => {
  it('reaches the widget', async () => {
    const wrapper = await open();
    expect(
      wrapper.querySelector('.doc-body-editor .ProseMirror .bn-trailing-block'),
    ).not.toBeNull();
  });

  it('reaches the group the widget sits in', async () => {
    const wrapper = await open();
    // The hop between the editable surface and the widget: without it the
    // widget's `flex-grow` has no flex container to grow inside.
    expect(
      wrapper.querySelector('.doc-body-editor .ProseMirror > .bn-block-group'),
    ).not.toBeNull();
  });

  it('reaches the editable surface', async () => {
    const wrapper = await open();
    expect(wrapper.querySelector('.doc-body-editor .bn-editor')).not.toBeNull();
  });
});
