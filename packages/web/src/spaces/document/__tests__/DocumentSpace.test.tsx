// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import * as Y from 'yjs';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { DocumentSpace } from '@web/spaces/document/DocumentSpace';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';

describe('DocumentSpace', () => {
  afterEach(() => {
    _resetForTests();
  });

  it('renders the editor mount and the toolbar', async () => {
    render(<DocumentSpace projectId='p1' spaceId='doc-1' />);
    expect(await screen.findByTestId('document-space')).toBeInTheDocument();
    expect(screen.getByTestId('document-toolbar')).toBeInTheDocument();
  });

  it('forwards projectId / spaceId via data attributes', async () => {
    render(<DocumentSpace projectId='alpha' spaceId='beta' />);
    const root = await screen.findByTestId('document-space');
    expect(root.getAttribute('data-project-id')).toBe('alpha');
    expect(root.getAttribute('data-space-id')).toBe('beta');
  });

  it('exposes history and formatting controls in the toolbar', async () => {
    render(<DocumentSpace projectId='p' spaceId='s' />);
    await screen.findByTestId('document-toolbar');
    for (const id of [
      'undo',
      'redo',
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

  it('binds the editor to THIS Space’s document, not some other doc', async () => {
    render(<DocumentSpace projectId='proj' spaceId='space-7' />);
    await screen.findByTestId('document-toolbar');

    // Reach the very document the container resolved — the manager hands out
    // one Y.Doc per name, so this is the same instance the editor is bound to.
    const fragment = documentBodyFragment(
      getDoc(docName.documentSpace('proj', 'space-7')),
    );
    act(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('written straight into the Y.Doc')]);
      fragment.push([para]);
    });

    // If the container had resolved the wrong document (or built its own), the
    // text would never reach the editor.
    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.textContent ?? '',
      ).toContain('written straight into the Y.Doc'),
    );
  });

  it('renders read-only for a viewer', async () => {
    render(<DocumentSpace projectId='p' spaceId='s' readOnly />);
    await screen.findByTestId('document-toolbar');

    await waitFor(() =>
      expect(
        document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),
      ).toBe('false'),
    );
  });
});
