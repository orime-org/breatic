// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The entry at the body's top right corner, which holds the commands whose
 * object is the whole document.
 *
 * One "…" button is all that stays on screen (user 2026-08-22); the commands
 * appear when it opens. The menu-system ruling's §2.1 survey is the reason:
 * whole-document commands sit behind a single "…" in five of the six products
 * it looked at. It holds the comment panel's row (#18) and the two snapshot
 * commands (inner#1129): a viewer, who has nothing to save, sees only the one
 * that opens the snapshot panel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, screen, waitFor } from '@testing-library/react';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/** Every row an editor sees. */
const ITEM_IDS = ['doc-doc-menu-comments', 'doc-doc-menu-restore-snapshot', 'doc-doc-menu-save-snapshot'];

/** The document the snapshot rows are for. */
const SCOPE = { projectId: 'p', spaceId: 's' };

/**
 * The menu's own items, rather than everything sharing their test-id prefix.
 * @returns Their test ids, sorted.
 */
function menuItems(): (string | null)[] {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.getAttribute('data-testid')).sort();
}

describe('the whole-document command entry', () => {
  const NAME = 'project-p/document-menu-entry';
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

  it('keeps one button on screen, whatever it will come to hold', () => {
    // Export, document settings and clear-the-document are all headed here.
    // What this pins is that the resting footprint stays one button however
    // many of them arrive.

    render(<DocumentEditor handle={handle} />);
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
    for (const id of ITEM_IDS) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('opens onto exactly those three commands', async () => {
    // The whole set at once: an item added or dropped has to turn this red,
    // and two separate existence checks leave a gap for it to slip through.
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} scope={SCOPE} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await screen.findByTestId('doc-doc-menu-save-snapshot');

    expect(menuItems()).toEqual(ITEM_IDS);
  });

  it('shows a viewer only the way into the snapshots', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} scope={SCOPE} readOnly />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await screen.findByTestId('doc-doc-menu-restore-snapshot');

    expect(menuItems()).toEqual(['doc-doc-menu-comments', 'doc-doc-menu-restore-snapshot']);
  });

  it('draws no snapshot rows for a body with no document behind it', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await screen.findByTestId('doc-doc-menu-comments');

    expect(menuItems()).toEqual(['doc-doc-menu-comments']);
  });

  it('opens the name dialog from the save row, leaving the document as it was', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} scope={SCOPE} />);
    const before = JSON.stringify(handle.editor.document);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await user.click(await screen.findByTestId('doc-doc-menu-save-snapshot'));

    expect(await screen.findByTestId('doc-snapshot-name-dialog')).toBeInTheDocument();
    expect(JSON.stringify(handle.editor.document)).toBe(before);
  });

  it('leaves the rest of the page reachable while the menu is open', async () => {
    // A modal menu shuts the page off in two ways at once, and this pins both:
    // pointer events off the body, and everything outside the menu marked
    // aria-hidden. The first is what made the dismissing click reach nothing,
    // so people had to click twice to get the caret back.
    //
    // These are Radix's marks rather than the behaviour itself — jsdom does no
    // hit-testing, so it cannot answer whether a click lands. What it can do is
    // notice both marks disappearing at once, which no reimplementation gets to
    // do quietly. The behaviour is pinned in `document-command-entry.spec.ts`
    // ("clicking the body both dismisses the menu and lands the caret"),
    // which runs a real browser.
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await screen.findByTestId('doc-doc-menu-comments');

    expect(document.body.style.pointerEvents).not.toBe('none');
    expect(
      screen.getByTestId('document-editor-content').closest('[aria-hidden]'),
    ).toBeNull();
  });

  it('gives the trigger a name that can be read out', () => {
    // An icon-only button with no visible text: without aria-label it is a
    // square.
    render(<DocumentEditor handle={handle} />);
    const label = screen
      .getByTestId('doc-doc-menu-trigger')
      .getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).not.toBe('');
  });
});
