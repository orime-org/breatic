// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The snapshot panel's code arrives in its own chunk (inner#1129); when that
 * chunk cannot be fetched (a tab left open across a deploy, a dropped
 * connection) the panel says so in its place and the page stays.
 */

import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

vi.mock('@web/spaces/document/DocumentVersionArea', () => {
  throw new Error('chunk gone');
});

describe('a snapshot panel that cannot load', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let handle: DocumentEditorHandle;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    const { result } = renderHook(() =>
      useDocumentEditor({ doc, name: 'project-p/version-unavailable', caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }) }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    handle = result.current!;
  });

  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('says so in the panel and closes back to the body', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} scope={{ projectId: 'p', spaceId: 's' }} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await user.click(await screen.findByTestId('doc-doc-menu-restore-snapshot'));

    expect(await screen.findByTestId('doc-version-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
    await user.click(screen.getByTestId('doc-version-close'));

    expect(screen.queryByTestId('doc-version-unavailable')).toBeNull();
    expect(screen.getByTestId('document-body-column').className).not.toContain('invisible');
  });
});
