// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A10: a media block answers the keys the way every block with no
 * text does. Selected, it goes with Backspace or Delete and undo brings it
 * back; a typed character changes nothing; Enter opens a line under it that
 * keeps its quote.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { BODY_PART } from '@web/spaces/document/document-node-selection-focus';
import {
  IN_SELECTION_CLASS,
  MEDIA_IN_SELECTION_CLASS,
} from '@web/spaces/document/document-selection-paint';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as this file reads it. */
interface Seen {
  type: string;
  props: Record<string, unknown>;
  content?: { text?: string }[];
}

const MEDIA = ['image', 'video', 'audio'] as const;

/**
 * Opens a focused editor holding Above, one media block, Below.
 * @param type - The media block's type.
 * @param quoted - Whether every block sits in a quote.
 * @returns The editor and its undo manager.
 */
function open(
  type: (typeof MEDIA)[number],
  quoted = false,
): { editor: Editor; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', props: { quoted }, content: 'Above' },
    { type, props: { quoted, url: 'https://cdn.example/a', name: 'a' } },
    { type: 'paragraph', props: { quoted }, content: 'Below' },
  ] as never);
  manager.stopCapturing();
  editor.prosemirrorView!.focus();
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === type) at = pos;
    return at < 0;
  });
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
  return { editor, manager };
}

/**
 * The document as `type:text` entries.
 * @param editor - The editor.
 * @returns One entry per top-level block.
 */
function shape(editor: Editor): string[] {
  return (editor.document as Seen[]).map(
    (b) => `${b.type}:${(b.content ?? []).map((c) => c.text ?? '').join('')}`,
  );
}

/**
 * Presses a key through the editor's own key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @returns Whether a handler took it.
 */
function press(editor: Editor, key: string): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

describe.each(MEDIA)('a selected %s block', (type) => {
  it.each(['Backspace', 'Delete'])('%s takes it away and undo brings it back', (key) => {
    const { editor, manager } = open(type);

    press(editor, key);
    expect(shape(editor)).toEqual(['paragraph:Above', 'paragraph:Below']);

    manager.undo();
    expect(shape(editor)).toEqual(['paragraph:Above', `${type}:`, 'paragraph:Below']);
  });

  it('a character key changes nothing', () => {
    const { editor } = open(type);

    press(editor, 'x');

    expect(shape(editor)).toEqual(['paragraph:Above', `${type}:`, 'paragraph:Below']);
  });

  it('Enter opens an empty line under it that keeps its quote', () => {
    const { editor } = open(type, true);

    press(editor, 'Enter');

    const blocks = editor.document as Seen[];
    expect(shape(editor)).toEqual([
      'paragraph:Above',
      `${type}:`,
      'paragraph:',
      'paragraph:Below',
    ]);
    expect(blocks[2]!.props['quoted']).toBe(true);
  });
});

describe.each(MEDIA)('a %s block in the selection is framed, not filled', (type) => {
  /**
   * Whether the media block's element carries the framed look, and not the
   * band a divider gets.
   * @param editor - The editor.
   * @returns True when it does.
   */
  function painted(editor: Editor): boolean {
    const element = editor.prosemirrorView!.dom.querySelector(`[data-content-type="${type}"]`)!;
    return (
      element.classList.contains(MEDIA_IN_SELECTION_CLASS) &&
      !element.classList.contains(IN_SELECTION_CLASS)
    );
  }

  it('when it is clicked, which selects it: it draws its own frame, and no band', () => {
    const { editor } = open(type);
    const element = editor.prosemirrorView!.dom.querySelector(`[data-content-type="${type}"]`)!;

    // The frame comes with the corner knobs and the toolbar off the block's
    // own selected state, so the selection paint stays off it.
    expect(element.classList.contains('ProseMirror-selectednode')).toBe(true);
    expect(element.classList.contains(MEDIA_IN_SELECTION_CLASS)).toBe(false);
    expect(element.classList.contains(IN_SELECTION_CLASS)).toBe(false);
  });

  it('when a range runs over it', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, view.state.doc.content.size - 3)),
    );

    expect(painted(editor)).toBe(true);
  });
});

describe.each(MEDIA)('a selected %s block when the focus moves', (type) => {
  it('stops being selected once the focus leaves the body', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    outside.focus();

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.$from.parent.textContent).toBe('Below');
    outside.remove();
    vi.restoreAllMocks();
  });

  /** Lets the tasks already queued run, and the ones they queue. */
  async function settle(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
    await new Promise((done) => setTimeout(done, 0));
  }

  it('stays selected when a layer of its own closes and the focus comes back to the body a task later', async () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    const { layer, inside } = layerOpenedFrom(view.dom.querySelector(`[data-content-type="${type}"]`)!);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    inside.focus();

    // The layer lets go of the focus, and hands it back as Radix does: in a
    // timeout queued after the focus fell to nothing.
    inside.blur();
    setTimeout(() => {
      view.focus();
    }, 0);
    await settle();

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    layer.remove();
    vi.restoreAllMocks();
  });

  it('stops being selected when the focus falls to nothing and stays there, a click on the page around it', async () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    (view.dom as HTMLElement).blur();
    await settle();

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    vi.restoreAllMocks();
  });

  it('stays selected when the window itself loses the focus', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    view.dom.blur();

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    vi.restoreAllMocks();
  });

  it('stays selected while the focus moves into a part of the body drawn outside it, the full-screen picture', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    const part = document.createElement('div');
    part.setAttribute(BODY_PART, '');
    part.tabIndex = -1;
    document.body.appendChild(part);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    part.focus();

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    part.remove();
    vi.restoreAllMocks();
  });

  /**
   * A layer drawn outside the body, as a menu is, with what opened it.
   * @param trigger - Where the element that opened it sits.
   * @returns The layer and a focusable element inside it.
   */
  function layerOpenedFrom(trigger: Element): { layer: HTMLElement; inside: HTMLElement } {
    const layer = document.createElement('div');
    layer.id = `layer-${String(Math.random()).slice(2)}`;
    const inside = document.createElement('button');
    layer.appendChild(inside);
    document.body.appendChild(layer);
    const opener = document.createElement('span');
    opener.setAttribute('aria-controls', layer.id);
    trigger.appendChild(opener);
    return { layer, inside };
  }

  it('stays selected while the focus moves into a layer opened from inside the body, the player volume', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    const { layer, inside } = layerOpenedFrom(view.dom.querySelector(`[data-content-type="${type}"]`)!);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    inside.focus();

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    layer.remove();
    vi.restoreAllMocks();
  });

  it('stays selected while the focus moves into a submenu of such a layer', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    const outer = layerOpenedFrom(view.dom.querySelector(`[data-content-type="${type}"]`)!);
    const sub = layerOpenedFrom(outer.layer);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    sub.inside.focus();

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    outer.layer.remove();
    sub.layer.remove();
    vi.restoreAllMocks();
  });

  it('stays selected while the focus moves to the strip beside the body, the row handle and its menu', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    // The area around the editable element that the row handles stand in.
    const area = document.createElement('div');
    area.setAttribute(BODY_PART, '');
    document.body.appendChild(area);
    const strip = document.createElement('div');
    area.appendChild(strip);
    const handle = document.createElement('button');
    strip.appendChild(handle);
    const menu = layerOpenedFrom(strip);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    handle.focus();
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    menu.inside.focus();
    expect(view.state.selection).toBeInstanceOf(NodeSelection);

    // From there to the top bar is leaving the body.
    const bar = document.createElement('button');
    document.body.appendChild(bar);
    bar.focus();
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    bar.remove();
    menu.layer.remove();
    area.remove();
    vi.restoreAllMocks();
  });

  it('stops being selected when the focus moves into a layer opened from outside the body, a top-bar menu', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    const { layer, inside } = layerOpenedFrom(bar);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    inside.focus();

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    layer.remove();
    bar.remove();
    vi.restoreAllMocks();
  });

  it('stays selected while the focus moves to something inside the body, its toolbar or caption', () => {
    const { editor } = open(type);
    const view = editor.prosemirrorView!;
    const inside = document.createElement('input');
    view.dom.querySelector(`[data-content-type="${type}"]`)!.appendChild(inside);

    inside.focus();

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    inside.remove();
  });
});
