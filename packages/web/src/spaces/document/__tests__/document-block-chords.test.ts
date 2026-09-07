// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A9: the nine chords do what the nine rows do.
 *
 * A key printed beside a row has to do what the row does (user 2026-08-29), so
 * both come off one table and every case here presses the key and clicks the
 * row on the same starting block, then compares.
 *
 * Six of the nine arrive bound to something else — `Mod-Alt-0` from the
 * paragraph block, `Mod-Alt-1/2/3` from the heading block, and BlockNote's
 * list blocks carry `Mod-Shift-7/8/9`, though those three were replaced when
 * the ordered item was rebuilt. Each built-in binding sets the block to that
 * type unconditionally, which contradicts §3.2 in two places: pressing a row
 * the block already has is a cancel, and an ordered item becoming a heading
 * keeps its number.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentChordsExtension } from '@web/spaces/document/document-block-chords';
import { runBlockType } from '@web/spaces/document/document-block-run';
import {
  BLOCK_TYPE_SHORTCUTS,
} from '@web/spaces/document/document-block-type-shortcuts';
import type { ShortcutSpec } from '@web/spaces/canvas/format-shortcut';
import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * Opens an editor holding one block, with the caret in it.
 * @param block - The block to put in.
 * @param withChords - Whether to register our chord bindings.
 * @returns The editor.
 */
function open(
  block: Readonly<Record<string, unknown>>,
  withChords = true,
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: withChords ? [documentChordsExtension()] : [],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [block] as never);
  const first = (editor.document as unknown as ReadBlock[])[0]!;
  editor.setTextCursorPosition(first.id, 'end');
  return editor;
}

/** What a US layout puts on `event.key` when the digit is pressed with Shift. */
const SHIFTED_DIGIT: Record<string, string> = { '7': '&', '8': '*', '9': '(' };

/**
 * The character a browser reports for this chord's base key.
 *
 * A browser reports what the press PRODUCED, never the key's label: Shift+b
 * sends `B`, and Shift+8 on a US layout sends `*`. Sending the label instead
 * takes a route no press in a browser ever takes.
 * @param spec - The chord.
 * @returns That character.
 */
function produced(spec: ShortcutSpec): string {
  if (spec.shift !== true) {
    return spec.key.toLowerCase();
  }
  return SHIFTED_DIGIT[spec.key] ?? spec.key.toUpperCase();
}

/**
 * Presses a chord at the editor.
 * @param editor - The editor.
 * @param spec - The chord.
 * @returns Whether a handler claimed the key.
 */
function press(
  editor: ReturnType<typeof buildDocumentEditor>,
  spec: ShortcutSpec,
): boolean {
  const view = editor.prosemirrorView!;
  const single = spec.key.length === 1;
  const event = new KeyboardEvent('keydown', {
    key: single ? produced(spec) : spec.key,
    // The unshifted key, which is the only route the four shifted chords
    // match by — `keydownHandler` looks the produced character up first,
    // misses, and falls back to `base[event.keyCode]`.
    keyCode: single ? spec.key.toUpperCase().charCodeAt(0) : 0,
    ctrlKey: spec.mod === true,
    altKey: spec.alt === true,
    shiftKey: spec.shift === true,
    bubbles: true,
  });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

/** The one block, as a plain record. */
function only(editor: ReturnType<typeof buildDocumentEditor>): ReadBlock {
  return (editor.document as unknown as ReadBlock[])[0]!;
}

/** What a block is, for comparing two runs. */
function shapeOf(block: ReadBlock): Record<string, unknown> {
  return {
    type: block.type,
    level: block.props['level'],
    numbered: block.props['numbered'],
    quoted: block.props['quoted'],
  };
}

/** The chord each row answers to, by row. */
const CHORD_OF = new Map<BlockTypeId, ShortcutSpec>(
  BLOCK_TYPE_SHORTCUTS.map(({ id, spec }) => [id, spec]),
);

describe('A9 — every row has a chord and every chord is the row', () => {
  it('prints a chord for all nine rows', () => {
    expect(BLOCK_TYPE_SHORTCUTS).toHaveLength(9);
    expect([...CHORD_OF.keys()].sort()).toEqual(
      [
        'paragraph',
        'heading-1',
        'heading-2',
        'heading-3',
        'bullet-list',
        'ordered-list',
        'task-list',
        'code-block',
        'quote',
      ].sort(),
    );
  });

  /** What each chord leaves behind when pressed on a plain paragraph. */
  const FROM_PARAGRAPH: Readonly<Record<BlockTypeId, Record<string, unknown>>> =
    {
      paragraph: { type: 'paragraph', quoted: false },
      'heading-1': { type: 'heading', level: 1, numbered: false },
      'heading-2': { type: 'heading', level: 2, numbered: false },
      'heading-3': { type: 'heading', level: 3, numbered: false },
      'bullet-list': { type: 'bulletListItem', quoted: false },
      'ordered-list': { type: 'numberedListItem', quoted: false },
      'task-list': { type: 'checkListItem', quoted: false },
      'code-block': { type: 'codeBlock', quoted: false },
      quote: { type: 'paragraph', quoted: true },
    };

  BLOCK_TYPE_SHORTCUTS.forEach(({ id, spec }) => {
    it(`leaves the same block behind for ${id} whether pressed or clicked`, () => {
      // A start that is none of the nine rows' own type, so no case is a cancel.
      const start = { type: 'paragraph', content: 'x' };

      const pressed = open({ ...start });
      expect(press(pressed, spec)).toBe(true);
      const byKey = shapeOf(only(pressed));

      const clicked = open({ ...start });
      runBlockType(clicked, id);
      const byRow = shapeOf(only(clicked));

      // Both agree, and both are what the row is supposed to leave: two
      // handlers arriving at the same wrong answer would pass the first
      // assertion on its own.
      expect(byKey).toEqual(byRow);
      expect(byKey).toMatchObject(FROM_PARAGRAPH[id]);
    });
  });
});

describe('the bindings the blocks ship are taken over', () => {
  it('turns a code block into a paragraph on Mod-Alt-0', () => {
    // BlockNote's own `Mod-Alt-0` bows out over a block whose content is not
    // inline (`Paragraph/block.ts:61-76`), so this is the row's answer, not its.
    const editor = open({ type: 'codeBlock', content: 'x' });
    expect(press(editor, CHORD_OF.get('paragraph')!)).toBe(true);
    expect(only(editor).type).toBe('paragraph');
  });

  it('acts on every block a selection covers, not just the caret’s', () => {
    // BlockNote's own handlers read `getTextCursorPosition().block` and change
    // that one (`Paragraph/block.ts:62`), so a selection spanning two would
    // leave the second where it was.
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(new Y.Doc()),
      extensions: [documentChordsExtension()],
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [
      { type: 'heading', props: { level: 1 }, content: 'a' },
      { type: 'heading', props: { level: 1 }, content: 'b' },
    ] as never);
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, 3, tr.doc.content.size - 3));
    });

    expect(press(editor, CHORD_OF.get('paragraph')!)).toBe(true);
    expect(
      (editor.document as unknown as ReadBlock[]).map((block) => block.type),
    ).toEqual(['paragraph', 'paragraph']);
  });

  it('keeps the number when an ordered item becomes a heading', () => {
    const editor = open({ type: 'numberedListItem', content: 'x' });
    expect(press(editor, CHORD_OF.get('heading-1')!)).toBe(true);
    expect(shapeOf(only(editor))).toMatchObject({
      type: 'heading',
      level: 1,
      numbered: true,
    });
  });

  it('cancels the bullet row rather than setting it again', () => {
    const editor = open({ type: 'bulletListItem', content: 'x' });
    expect(press(editor, CHORD_OF.get('bullet-list')!)).toBe(true);
    expect(only(editor).type).toBe('paragraph');
  });

  it('cancels the to-do row rather than setting it again', () => {
    const editor = open({ type: 'checkListItem', content: 'x' });
    expect(press(editor, CHORD_OF.get('task-list')!)).toBe(true);
    expect(only(editor).type).toBe('paragraph');
  });

  it('cancels the ordered row rather than setting it again', () => {
    const editor = open({ type: 'numberedListItem', content: 'x' });
    expect(press(editor, CHORD_OF.get('ordered-list')!)).toBe(true);
    expect(only(editor).type).toBe('paragraph');
  });

  it('leaves the three list chords reaching nothing when we do not register', () => {
    // `buildListItemSpecs` replaces the extensions the list blocks ship with,
    // and ours declares Enter alone — so the chords those blocks carried are
    // gone with them. Measured: the press is declined and the block stands.
    const editor = open({ type: 'bulletListItem', content: 'x' }, false);
    expect(press(editor, CHORD_OF.get('bullet-list')!)).toBe(false);
    expect(only(editor).type).toBe('bulletListItem');
  });
});

describe('the ordering that wins those bindings', () => {
  it('registers this extension above every built-in it names', () => {
    // The two built-ins that still bind a chord of ours reach the key first
    // unless this extension outranks them, and BlockNote ranks by a
    // topological sort of `runsBefore` (`util/topo-sort.ts:166-205`). Pressing
    // the keys cannot tell the two apart for `Mod-Alt-0` — both handlers make
    // a paragraph — so the ranking is asserted directly.
    const editor = open({ type: 'paragraph', content: 'x' });
    const extensions = (
      editor as unknown as {
        _tiptapEditor: {
          extensionManager: {
            extensions: {
              name: string;
              config?: { priority?: number };
            }[];
          };
        };
      }
    )._tiptapEditor.extensionManager.extensions;

    const priorityOf = (name: string): number => {
      const found = extensions.find((extension) => extension.name === name);
      const priority = found?.config?.priority;
      if (priority === undefined) {
        throw new Error(`no priority for extension ${name}`);
      }
      return priority;
    };

    // Named here rather than read off the implementation: a test walking the
    // implementation's own list drops a case whenever the list does.
    ['paragraph-shortcuts', 'heading-shortcuts'].forEach((name) => {
      expect(priorityOf('documentBlockTypeChords')).toBeGreaterThan(
        priorityOf(name),
      );
    });
  });
});

describe('the two chords no block claims', () => {
  it('puts a quote on with Mod-Shift-B and takes it off again', () => {
    const editor = open({ type: 'paragraph', content: 'x' });
    const chord = CHORD_OF.get('quote')!;
    expect(press(editor, chord)).toBe(true);
    expect(only(editor).props['quoted']).toBe(true);

    expect(press(editor, chord)).toBe(true);
    expect(only(editor).props['quoted']).toBe(false);
  });

  it('turns a paragraph into a code block with Mod-Alt-C', () => {
    const editor = open({ type: 'paragraph', content: 'x' });
    expect(press(editor, CHORD_OF.get('code-block')!)).toBe(true);
    expect(only(editor).type).toBe('codeBlock');
  });
});
