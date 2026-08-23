// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The entry at the body's top right corner, which holds the commands whose
 * object is the whole document.
 *
 * One "…" button is all that stays on screen (user 2026-08-22); the commands
 * appear when it opens. The menu-system ruling's §2.1 survey is the reason:
 * whole-document commands sit behind a single "…" in five of the six products
 * it looked at. What opens today is two snapshot commands, neither of them
 * working yet (task #19).
 *
 * Their not-open-yet state copies `ComingEntry` (`StudioAccountMenu.tsx:99-119`)
 * item by item: dimmed, `aria-disabled`, does nothing when clicked, a cursor
 * that says so, and a note badge that stays put. HTML `disabled` is what this
 * avoids — it drops the item out of the focus order, and a control meant to be
 * discovered has to stay in it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

const ITEM_IDS = ['doc-doc-menu-restore-snapshot', 'doc-doc-menu-save-snapshot'];

describe('the whole-document command entry', () => {
  const NAME = 'project-p/document-menu-entry';
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

  it('keeps one button on screen, whatever it will come to hold', () => {
    // Export, document settings and clear-the-document are all headed here.
    // What this pins is that the resting footprint stays one button however
    // many of them arrive.

    render(<DocumentEditor editor={editor} />);
    expect(screen.getByTestId('doc-doc-menu-trigger')).toBeInTheDocument();
    for (const id of ITEM_IDS) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('opens onto exactly those two commands', async () => {
    // The whole set at once: an item added or dropped has to turn this red,
    // and two separate existence checks leave a gap for it to slip through.

    const user = userEvent.setup();
    render(<DocumentEditor editor={editor} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    await screen.findByTestId('doc-doc-menu-save-snapshot');

    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-doc-menu-"]'),
    )
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id !== 'doc-doc-menu-trigger');

    expect(ids.sort()).toEqual(ITEM_IDS);
  });

  it('把两条都标成尚未开放：可聚焦、变暗、带一枚说明徽章', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor editor={editor} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));

    for (const id of ITEM_IDS) {
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
    render(<DocumentEditor editor={editor} />);
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));

    for (const id of ITEM_IDS) {
      const item = await screen.findByTestId(id);
      expect(item.hasAttribute('disabled')).toBe(false);
      expect(item.getAttribute('data-disabled')).toBeNull();
    }
  });

  it('does nothing when an item is clicked', async () => {
    const user = userEvent.setup();
    render(<DocumentEditor editor={editor} />);
    const before = editor.getHTML();
    await user.click(screen.getByTestId('doc-doc-menu-trigger'));
    const item = await screen.findByTestId('doc-doc-menu-save-snapshot');
    await user.click(item);

    // The menu stays put (`onSelect` calls preventDefault) and the document
    // is untouched.
    expect(screen.getByTestId('doc-doc-menu-save-snapshot')).toBeInTheDocument();
    expect(editor.getHTML()).toBe(before);
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
    render(<DocumentEditor editor={editor} />);
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
    render(<DocumentEditor editor={editor} />);
    const label = screen
      .getByTestId('doc-doc-menu-trigger')
      .getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).not.toBe('');
  });
});
