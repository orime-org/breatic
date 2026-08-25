// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The editor chrome: the scrolling body, the whole-document entry, the bubble
 * bar. The editor comes from the container, so these tests drive a real one
 * through the real user path — no test-only hooks into the component.
 *
 * ## Where the two viewer tests went
 *
 * Two tests here used to pin that the toolbar's controls were all disabled for
 * a viewer, and that clicking one changed nothing in the shared document. The
 * toolbar is gone, and with it the entry point they named.
 * `selection-bubble-bar.test.tsx` carries that ground now (A7): a viewer never
 * sees the bar at all, so there is no control on that path to click. What was
 * deleted is the tests, not the invariant.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { Awareness } from 'y-protocols/awareness';

import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

describe('DocumentEditor', () => {
  const NAME = 'project-p/document-chrome';
  let doc: Y.Doc;
  let awareness: Awareness;
  let editor: Editor;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name: NAME, caretProvider: { awareness } }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    editor = result.current!.editor;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('renders one chrome element beside the body: the scroller', () => {
    // The top toolbar is gone (task #129). This counts what the shell renders
    // rather than naming test ids the toolbar used to carry — those queries
    // went vacuous the moment it was deleted. Anything new added as a direct
    // child of the shell turns this red. Two things do NOT: the bubble bar,
    // which only renders while a selection exists, and anything portalled out.
    const { container } = render(<DocumentEditor editor={editor} />);
    const children = [...container.firstElementChild!.children];

    expect(children).toHaveLength(1);
    expect(children[0]).toHaveClass(BODY_SCROLLER_CLASS);
  });

  it('puts the whole-document entry inside the scroller, ahead of the page', () => {
    // Inside, so a wheel over it finds the body the way the browser normally
    // does. Ahead of the page, so it sticks to the top edge while the text
    // scrolls under it.
    render(<DocumentEditor editor={editor} />);
    const viewport = document.querySelector(
      `.${BODY_SCROLLER_CLASS} [data-radix-scroll-area-viewport]`,
    )!;
    const trigger = screen.getByTestId('doc-doc-menu-trigger');
    const content = screen.getByTestId('document-editor-content');

    expect(viewport.contains(trigger)).toBe(true);
    expect(viewport.firstElementChild!.contains(trigger)).toBe(true);
    expect(
      trigger.compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the body and the whole-document entry', () => {
    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
  });

});
