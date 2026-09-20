// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A3: a viewer gets no strip.
 *
 * Every command off it writes to the document, so a viewer who could reach
 * the strip would be editing a document they are only allowed to read.
 *
 * WHY THE CARRIER IS STOOD IN FOR HERE. Mounted for real it draws nothing
 * until a pointer is over a row, and jsdom lays out nothing for a pointer to
 * be over; a test written against the real one passes whether the gate is
 * there or not — measured, taking the gate out left it green. What is in
 * question is the gate, so the strip is replaced with something that says
 * "I was mounted", and the gate is what the two cases read.
 *
 * The other gate is the library's own: `SideMenu.ts:220` declines to answer a
 * pointer while the editor is not editable. That one is not ours and is not
 * asserted here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';

import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

vi.mock('@web/spaces/document/DocumentBlockControls', () => ({
  /**
   * Stands in for the strip, saying only that it was mounted.
   * @returns The marker.
   */
  DocumentBlockControls: (): React.JSX.Element => (
    <div data-testid='block-strip-mounted' />
  ),
}));

describe('who the strip is mounted for', () => {
  const NAME = 'project-p/document-gate';
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name: NAME, caretProvider: { awareness } }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('mounts them for someone who can write', async () => {
    render(<DocumentEditor handle={handle} />);

    await waitFor(() =>
      expect(screen.getByTestId('block-strip-mounted')).toBeInTheDocument(),
    );
  });

  it('withholds them from a viewer', () => {
    render(<DocumentEditor handle={handle} readOnly />);

    expect(screen.queryByTestId('block-strip-mounted')).toBeNull();
  });
});
