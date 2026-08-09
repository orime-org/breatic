// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The title block cannot be removed, moved or duplicated.
 *
 * This is the invariant the whole document structure rests on. The body below
 * the title is allowed to hold nothing at all, which is only safe because the
 * title is always there — so every gesture that could plausibly take it away
 * gets its own case here rather than a single "select all and delete" that
 * would pass for the wrong reason.
 *
 * These run the real schema over a real Yjs fragment. What they do NOT cover
 * is the keyboard behaviour at the boundary between the title and the body —
 * that lives in `document-title-keymap.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
});

/**
 * A document seeded exactly as the backend seeds one, with a live editor over
 * it.
 * @param title - The title text the Space was created with.
 * @param bodyBlocks - Node names to append after the title, if any.
 * @returns The fragment and the editor bound to it.
 */
function openSeeded(
  title: string,
  bodyBlocks: readonly string[] = [],
): { body: Y.XmlFragment; editor: Editor } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document', title));
  const body = documentBodyFragment(doc);
  bodyBlocks.forEach((name) => {
    const el = new Y.XmlElement(name);
    el.insert(0, [new Y.XmlText(name)]);
    body.push([el]);
  });
  const editor = new Editor({ extensions: buildDocumentExtensions({ fragment: body }) });
  editors.push(editor);
  return { body, editor };
}

describe('the title block survives every gesture that could remove it', () => {
  it('is what a seeded document opens with', () => {
    const { editor } = openSeeded('Storyboard v3');
    expect(editor.state.doc.child(0).type.name).toBe('title');
    expect(editor.state.doc.child(0).textContent).toBe('Storyboard v3');
    // No body block was seeded and the editor did not invent one.
    expect(editor.state.doc.childCount).toBe(1);
  });

  it('survives select-all followed by delete', () => {
    const { body, editor } = openSeeded('Storyboard v3', ['paragraph']);
    editor.commands.selectAll();
    editor.commands.deleteSelection();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
  });

  it('survives a delete over the document’s whole range', () => {
    const { body, editor } = openSeeded('Storyboard v3', ['paragraph']);
    editor.commands.deleteRange({ from: 0, to: editor.state.doc.content.size });
    expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
  });

  it('survives a delete aimed at exactly the title node', () => {
    const { body, editor } = openSeeded('Storyboard v3', ['paragraph']);
    const before = body.length;
    editor.commands.deleteRange({ from: 0, to: editor.state.doc.child(0).nodeSize });
    // The BLOCK is what cannot go. Its text can: a range over the title is
    // the user selecting their own title and deleting it, which is ordinary
    // editing and allowed.
    expect(body.length).toBe(before);
    expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
  });

  it('survives being selected as a node and deleted', () => {
    // The sharper version of the case above: not a range over the title's
    // content, but the node itself picked out and removed.
    const { body, editor } = openSeeded('Storyboard v3', ['paragraph']);
    editor.commands.setNodeSelection(0);
    editor.commands.deleteSelection();
    expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
  });

  it('does not go away when backspace is pressed at its very start', () => {
    const { body, editor } = openSeeded('Storyboard v3');
    editor.commands.setTextSelection(1);
    editor.commands.keyboardShortcut('Backspace');
    expect(body.length).toBe(1);
    expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
    expect(editor.state.doc.child(0).textContent).toBe('Storyboard v3');
  });

  it('cannot be created a second time in the body', () => {
    const { editor } = openSeeded('Storyboard v3', ['paragraph']);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
      type: 'title',
      content: [{ type: 'text', text: 'second' }],
    });
    const titles = [...Array(editor.state.doc.childCount).keys()].filter(
      (i) => editor.state.doc.child(i).type.name === 'title',
    );
    expect(titles).toEqual([0]);
  });

  it('refuses every mark the body accepts', () => {
    const { body, editor } = openSeeded('Storyboard v3');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.toggleBold();
    editor.commands.toggleItalic();
    editor.commands.toggleStrike();
    expect(body.toString()).toBe('<title>Storyboard v3</title>');
  });

  it('refuses to be turned into another kind of block', () => {
    const { body, editor } = openSeeded('Storyboard v3');
    editor.commands.setTextSelection(2);
    editor.commands.toggleHeading({ level: 2 });
    editor.commands.toggleBulletList();
    editor.commands.toggleBlockquote();
    expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
  });

  it('leaves the body free to hold no blocks at all', () => {
    const { body, editor } = openSeeded('Storyboard v3', ['paragraph']);
    const titleSize = editor.state.doc.child(0).nodeSize;
    editor.commands.deleteRange({ from: titleSize, to: editor.state.doc.content.size });
    // The editor must NOT put a paragraph back: an empty body is legal, and a
    // repair here would be a write that counts as a user edit.
    expect(body.length).toBe(1);
    expect(editor.state.doc.childCount).toBe(1);
  });
});

describe('the caret cannot fall out of the front of the document', () => {
  it('the left arrow at the title’s start leaves a text selection, not a gap', () => {
    // A gap cursor sits BETWEEN blocks and holds no text. There is nothing
    // before the title for one to sit in, so landing there means the caret is
    // somewhere the user cannot type — it looks like an ordinary caret and
    // swallows what they write. ProseMirror only offers that position next to
    // a node it cannot enter, which `isolating` made the title into.
    const { editor } = openSeeded('ABCDE');
    editor.commands.setTextSelection(1);
    editor.view.someProp('handleKeyDown', (f) =>
      f(editor.view, new KeyboardEvent('keydown', { key: 'ArrowLeft' })),
    );

    expect(editor.state.selection.constructor.name).toBe('TextSelection');
  });
});
