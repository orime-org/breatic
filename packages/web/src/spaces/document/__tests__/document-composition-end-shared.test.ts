// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The body's composition-end tracker can be read by other key handlers
 * (inner#1125 design 5.4): a menu that opens on the commit itself still sees
 * the composition that just ended, so the 13 Chrome sends after it is left to
 * the input method.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { compositionEndOf } from '@web/spaces/document/document-enter';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

describe('the composition-end tracker of the body', () => {
  it('reports a composition that just ended to any reader, until the next task', async () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(editor);

    const tracker = compositionEndOf(editor as never);
    expect(tracker).toBeDefined();
    expect(tracker?.justEnded()).toBe(false);

    editor.prosemirrorView.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '、' }));
    expect(tracker?.justEnded()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracker?.justEnded()).toBe(false);
  });
});
