// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chain that carries the body and the panel to the bottom (#18, A4 · A18).
 *
 * One rule in `index.css` gives the wrapper Radix mounts the page into its
 * height, and everything below it inherits that height as a flex item. The
 * rule names its target by what it holds, so it stops matching the moment
 * something is put in between — and nothing fails when it does: the text
 * still reads, the panel still draws, and the only sign is that neither of
 * them reaches the bottom of the viewport any more. Measured 2026-09-23 with
 * the panel open: the editable surface was 54.5px tall inside an 870px
 * viewport.
 *
 * So these ask whether each selector in the chain MATCHES the DOM the Space
 * actually renders. Layout itself is measured in a browser (`tests/smoke/`);
 * jsdom computes none.
 */

import { render, screen, waitFor, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { selectorEndingIn } from '@web/spaces/document/__tests__/index-css-rules';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

// Read from the stylesheet rather than retyped: a case holding its own copy
// of the selector passes while the rule that ships matches nothing.
const GROWN = selectorEndingIn('.doc-body-editor)');

describe('what carries the body to the bottom of the scroller', () => {
  const NAME = 'project-p/document-fills-scroller';
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({
        doc,
        name: NAME,
        caretProvider: { awareness },
        readWho: () => ({ role: 'editor', viewerId: 'u1' }),
      }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /** Renders the Space with one line in the body. */
  function show(): void {
    render(<DocumentEditor handle={handle} myRole='editor' />);
    act(() => {
      handle.editor.replaceBlocks(handle.editor.document, [
        { type: 'paragraph', content: 'alpha bravo charlie' },
      ] as never);
    });
  }

  it('names exactly one wrapper', () => {
    show();
    expect(document.querySelectorAll(GROWN)).toHaveLength(1);
  });

  it('still names it once the panel is beside the text', async () => {
    show();
    await userEvent.click(screen.getByTestId('doc-doc-menu-trigger'));
    await userEvent.click(await screen.findByTestId('doc-doc-menu-comments'));
    await screen.findByTestId('doc-comment-rail');

    expect(document.querySelectorAll(GROWN)).toHaveLength(1);
  });

  it('hands its height on through every element between it and the text', () => {
    // A wrapper that grows carries nothing on its own: each element between
    // it and the editable surface has to be a flex item that stretches.
    show();
    const grown = document.querySelector(GROWN)!;
    const surface = document.querySelector('.doc-body-editor')!;

    for (let at = surface.parentElement; at !== grown; at = at!.parentElement) {
      expect(at).not.toBeNull();
      // `flex-1` and nothing else: `-` is a word boundary, so a pattern that
      // also accepts a bare `flex` accepts `flex-none`, which is the shape
      // that broke this chain in the first place.
      expect(at!.className).toMatch(/\bflex-1\b/);
    }
  });
});
