// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The editor chrome: toolbar + body. The editor instance is supplied by the
 * container, so these tests drive a real one through the real user path — no
 * test-only hooks into the component.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  render,
  renderHook,
  screen,
  waitFor,
  act,
} from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/** Reads a fragment's plain text, paragraphs joined by a newline. */
function textOf(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => node.toString().replace(/<[^>]*>/g, ''))
    .join('\n');
}

describe('DocumentEditor', () => {
  let doc: Y.Doc;
  let fragment: Y.XmlFragment;
  let editor: Editor;

  beforeEach(async () => {
    doc = new Y.Doc();
    fragment = doc.getXmlFragment('content');
    const { result } = renderHook(() => useDocumentEditor({ fragment }));
    await waitFor(() => expect(result.current).not.toBeNull());
    editor = result.current as Editor;
  });
  afterEach(() => {
    doc.destroy();
  });

  it('renders the toolbar and the editor body', () => {
    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('document-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
  });

  it('disables undo and redo while there is nothing on the stack', () => {
    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('doc-tool-undo')).toBeDisabled();
    expect(screen.getByTestId('doc-tool-redo')).toBeDisabled();
  });

  it('enables undo after this client edits — the button tracks stack depth', async () => {
    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('doc-tool-undo')).toBeDisabled();

    act(() => {
      editor.commands.setContent('<p>typed</p>');
    });

    // The button must react to the stack growing. A toolbar that reads
    // `can().undo()` once at mount would stay disabled here forever.
    await waitFor(() =>
      expect(screen.getByTestId('doc-tool-undo')).not.toBeDisabled(),
    );
  });

  it('undoes the edit when the toolbar button is clicked', async () => {
    render(<DocumentEditor editor={editor} />);

    act(() => {
      editor.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(textOf(fragment)).toContain('typed'));
    await waitFor(() =>
      expect(screen.getByTestId('doc-tool-undo')).not.toBeDisabled(),
    );

    act(() => {
      screen.getByTestId('doc-tool-undo').click();
    });

    await waitFor(() => expect(textOf(fragment)).not.toContain('typed'));
  });

  it('offers redo after an undo, and redo restores the content', async () => {
    render(<DocumentEditor editor={editor} />);

    act(() => {
      editor.commands.setContent('<p>typed</p>');
    });
    await waitFor(() => expect(textOf(fragment)).toContain('typed'));

    act(() => {
      editor.commands.undo();
    });
    await waitFor(() => expect(textOf(fragment)).not.toContain('typed'));

    // Redo must light up here with no further editing. Reading availability off
    // the transaction stream fails exactly this assertion — see
    // use-document-history for the measurement.
    await waitFor(() =>
      expect(screen.getByTestId('doc-tool-redo')).not.toBeDisabled(),
    );

    act(() => {
      screen.getByTestId('doc-tool-redo').click();
    });
    await waitFor(() => expect(textOf(fragment)).toContain('typed'));
  });

  it('keeps the existing formatting toggles', () => {
    render(<DocumentEditor editor={editor} />);
    for (const id of [
      'bold',
      'italic',
      'strike',
      'bullet-list',
      'ordered-list',
      'quote',
    ]) {
      expect(screen.getByTestId(`doc-tool-${id}`)).toBeInTheDocument();
    }
  });
});
