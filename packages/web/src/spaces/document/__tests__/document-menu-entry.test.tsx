// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The entry at the body's top right corner, which holds the commands whose
 * object is the whole document.
 *
 * One "…" button is all that stays on screen (user 2026-08-22); the commands
 * appear when it opens. The menu-system ruling's §2.1 survey is the reason:
 * whole-document commands sit behind a single "…" in five of the six products
 * it looked at. What opens today is the comment panel's row (#18) and two
 * snapshot commands, neither of those working yet (task #19).
 *
 * The not-open-yet state is dimmed, `aria-disabled`, does nothing when
 * clicked, a cursor that says so, and a note badge that stays put. HTML `disabled` is what this
 * avoids — it drops the item out of the focus order, and a control meant to be
 * discovered has to stay in it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/** The rows that stand for commands which are not open yet. */
const COMING_IDS = ['doc-doc-menu-restore-snapshot', 'doc-doc-menu-save-snapshot'];

/** Every row, the working one among them. */
const ITEM_IDS = [...COMING_IDS, 'doc-doc-menu-comments'].sort();

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
    render(<DocumentEditor handle={handle} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await screen.findByTestId('doc-doc-menu-save-snapshot');

    // The menu's own items, rather than everything sharing their test-id
    // prefix: a row is free to carry marks and labels inside it, and counting
    // by prefix would read each of those as another command.
    const ids = Array.from(document.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.getAttribute('data-testid'),
    );

    expect(ids.sort()).toEqual(ITEM_IDS);
  });

  it('marks both snapshot rows as not open yet: focusable, dimmed, badged', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));

    for (const id of COMING_IDS) {
      const item = await screen.findByTestId(id);
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item.className).toContain('cursor-not-allowed');
      expect(item.querySelector('.opacity-50')).not.toBeNull();
      // 说明这一条为什么点不动的那枚徽章。只断言它有字 —— 钉住某种语言
      // 等于钉住测试环境的 locale。
      const note = item.querySelector('.text-2xs');
      expect(note).not.toBeNull();
      expect(note?.textContent?.trim()).toBeTruthy();
    }
  });

  it('reaches the items by keyboard, so no HTML disabled', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));

    for (const id of COMING_IDS) {
      const item = await screen.findByTestId(id);
      expect(item.hasAttribute('disabled')).toBe(false);
      expect(item.getAttribute('data-disabled')).toBeNull();
    }
  });

  it('does nothing when an item is clicked', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor handle={handle} />);
    const before = JSON.stringify(handle.editor.document);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    const item = await screen.findByTestId('doc-doc-menu-save-snapshot');
    await user.click(item);

    // The menu stays put (`onSelect` calls preventDefault) and the document
    // is untouched.
    expect(screen.getByTestId('doc-doc-menu-save-snapshot')).toBeInTheDocument();
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
    await screen.findByTestId('doc-doc-menu-save-snapshot');

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
