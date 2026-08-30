// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which rows a selection can reach (§6.7).
 *
 * A row is lit when every block in the selection can become that item, and
 * greyed when any of them cannot — the same judgement rule 4 makes about
 * dispatching, so the menu cannot say one thing and do another.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/react';

import { runBlockType, canRunBlockType } from '@web/spaces/document/document-block-model';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectRange, selectWholeBody } from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

/**
 * All nine rows.
 *
 * The task list is in: it has no schema node, so it is the one row greyed on
 * every selection there is, and leaving it out would leave the always-grey row
 * the one row nothing pins.
 */
const ROWS: BlockTypeId[] = [
  'paragraph', 'heading-1', 'heading-2', 'heading-3',
  'bullet-list', 'ordered-list', 'task-list', 'code-block', 'quote',
];

/** A selection a case puts on the editor. */
type Place = (editor: Editor) => void;

/** Selections where every row reaches something. */
const REACHABLE: Array<[name: string, body: string, place: Place]> = [
  ['a plain paragraph', '<p>a line</p>', (e) => { selectBlock(e, 'a line'); }],
  ['a list item', '<ul><li><p>an item</p></li></ul>', (e) => { selectBlock(e, 'an item'); }],
  ['a quoted line', '<blockquote><p>quoted</p></blockquote>', (e) => { selectBlock(e, 'quoted'); }],
  [
    'a selection across two blocks',
    '<h1>a heading</h1><p>a paragraph</p>',
    (e) => { selectWholeBody(e); },
  ],
  // Neither of these is a list item — a later block of an item carries no
  // marker (§6.0) — so nothing has to make way and every row reaches something.
  [
    'a quoted block a list item holds',
    '<ul><li><p>a</p><blockquote><p>b</p></blockquote></li></ul>',
    (e) => { selectBlock(e, 'b'); },
  ],
  [
    'a later block of an item holding a sub-list',
    '<ul><li><p>b</p><p>c</p><ul><li><p>d</p></li></ul></li></ul>',
    (e) => { selectBlock(e, 'c'); },
  ],
];

/**
 * Selections where some rows reach nothing, with the rows that do (§6.7).
 *
 * A list item's content is `paragraph block*`: its first block has to be a
 * paragraph, so a first block with a sub-list under it can neither leave the
 * item nor change type.
 */
const STUCK: Array<[name: string, body: string, place: Place, lit: BlockTypeId[]]> = [
  [
    'the first block of an item holding a sub-list',
    '<ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>',
    (e) => { selectBlock(e, 'one'); },
    ['quote'],
  ],
  [
    'a selection running from a paragraph into a stuck item',
    '<p>tail</p><ul><li><p>a</p><ul><li><p>a1</p></li></ul></li></ul>',
    (e) => { selectRange(e, 'tail', 'a'); },
    ['quote'],
  ],
  // One block can change and the other cannot: rule 2 turns EVERY block into
  // the row that was pressed, so a press moving only the heading is half of
  // what it promised and the row is dark (rule 4).
  [
    'a selection running from a heading into a stuck item',
    '<h1>tail</h1><ul><li><p>a</p><ul><li><p>a1</p></li></ul></li></ul>',
    (e) => { selectRange(e, 'tail', 'a'); },
    ['quote'],
  ],
];

describe('a selection every row reaches', () => {
  it.each(REACHABLE)('lights every row but the task list on %s', (_name, body, place) => {
    const editor = openBody(body);
    place(editor);
    const dark = ROWS.filter((id) => !canRunBlockType(editor, id));
    expect(dark).toEqual(['task-list']);
  });
});

describe('a selection some rows cannot reach', () => {
  it.each(STUCK)('lights only what it can reach on %s', (_name, body, place, lit) => {
    const editor = openBody(body);
    place(editor);
    expect(ROWS.filter((id) => canRunBlockType(editor, id))).toEqual(lit);
  });

  it.each(STUCK)('leaves the document alone when a dark row is pressed on %s', (
    _name,
    body,
    place,
    lit,
  ) => {
    for (const id of ROWS.filter((row) => !lit.includes(row))) {
      const editor = openBody(body);
      place(editor);
      const before = editor.getHTML();
      let dispatched = 0;
      const original = editor.view.dispatch.bind(editor.view);
      editor.view.dispatch = (tr): void => {
        dispatched += 1;
        original(tr);
      };
      runBlockType(editor, id);
      expect(dispatched, `${id} dispatched on a dark row`).toBe(0);
      expect(editor.getHTML(), `${id} changed the document`).toBe(before);
    }
  });
});

describe('a greyed row never writes anything', () => {
  const CASES = [...REACHABLE, ...STUCK.map(([n, b, p]) => [n, b, p] as const)];

  // One direction only. Text on a block that is already Text stays lit and
  // writes nothing: the target is the state it is in, so there is nothing to
  // do and the tick already says so (§6.7).
  it.each(CASES)('holds row by row on %s', (_name, body, place) => {
    for (const id of ROWS) {
      const editor = openBody(body);
      place(editor);
      if (canRunBlockType(editor, id)) continue;

      let dispatched = 0;
      const original = editor.view.dispatch.bind(editor.view);
      editor.view.dispatch = (tr): void => {
        dispatched += 1;
        original(tr);
      };
      const before = editor.getHTML();
      runBlockType(editor, id);
      expect(dispatched, `${id} was dark yet dispatched`).toBe(0);
      expect(editor.getHTML(), `${id} was dark yet changed the document`).toBe(before);
    }
  });
});
