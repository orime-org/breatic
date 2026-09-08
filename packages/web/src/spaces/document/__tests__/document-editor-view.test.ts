// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A19/A20 的共用那半: what the overlays get when they ask for the view.
 *
 * Three states, and the middle one is the only one with anything on screen.
 * The two that have not got a view answer the same way here on purpose — an
 * overlay asks this to find something to anchor to, and "not yet" and "not any
 * more" are the same answer to that question.
 *
 * The case that matters is the last one, because the obvious implementation
 * passes the first two and fails it: `prosemirrorView` hands back an object in
 * ALL THREE states, so a `try` around the getter alone reports a live view for
 * an editor that has been torn down, and the overlay then raises on the next
 * property it touches.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  viewOf,
  domElementOf,
} from '@web/spaces/document/document-editor-view';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * An editor bound to a fresh document, not yet mounted.
 * @returns The editor.
 */
function build(): ReturnType<typeof buildDocumentEditor> {
  const doc = new Y.Doc();
  return buildDocumentEditor({ fragment: documentBodyFragment(doc) });
}

/**
 * Puts the given editor into a container in the page.
 * @param editor - The editor to mount.
 */
function mount(editor: ReturnType<typeof buildDocumentEditor>): void {
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
}

describe('asking an editor for its view', () => {
  it('answers null before it has been mounted', () => {
    const editor = build();

    expect(viewOf(editor)).toBeNull();
    expect(domElementOf(editor)).toBeNull();
  });

  it('answers the view while it is mounted', () => {
    const editor = build();
    mount(editor);
    mounted.push(editor);

    expect(viewOf(editor)).not.toBeNull();
    expect(domElementOf(editor)?.isConnected).toBe(true);
  });

  it('answers null once it has been unmounted', () => {
    const editor = build();
    mount(editor);
    editor.unmount();

    expect(viewOf(editor)).toBeNull();
    expect(domElementOf(editor)).toBeNull();
  });

  it('answers the view again after being mounted a second time', () => {
    // The eviction the cache does is an unmount, and a tab reopened afterwards
    // mounts the same editor again. An answer that stuck at null would leave
    // the overlays with nothing to anchor to for the rest of the session.
    const editor = build();
    mount(editor);
    editor.unmount();
    mount(editor);
    mounted.push(editor);

    expect(viewOf(editor)).not.toBeNull();
    expect(domElementOf(editor)?.isConnected).toBe(true);
  });
});
