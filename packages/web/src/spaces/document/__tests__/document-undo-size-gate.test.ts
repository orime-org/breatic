// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 14, document body: H-03, H-04, H-06, H-08, H-11, H-12, H-18 and the body
 * part of H-19.
 *
 * The body's undo and redo (BlockNote's commands, their key bindings, the
 * scroller's keys) go through `nextHistoryStep`: when the Space is full or
 * over its ceiling, the step is first run on a copy of the document and
 * judged by what it wrote (`add`, `delete`, `remove`, or no effect), then let
 * through or refused by `writeSpaceDoc`. The content is loaded as a remote
 * update from a second editor (spec 0.1); the case's own steps are local.
 *
 * Keys go through `view.someProp('handleKeyDown')`. jsdom is not a Mac, so
 * which modifier `Mod` is in this process is read from the keymap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { keydownHandler } from '@tiptap/pm/keymap';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: {
    warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(),
    loading: vi.fn(), promise: vi.fn(), dismiss: vi.fn(), custom: vi.fn(),
  },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { attachBodyScroller } from '@web/spaces/document/document-body-press';
import {
  enterSize,
  kindOf,
  localUpdate,
  spyOnSteps,
  trialKind,
  trialRan,
  type StepKind,
  type StepSpies,
} from '@web/data/yjs/__tests__/helpers/history-fork-harness';
import { COPY_V2_EN, P_FULL, P_OVER, type DocSizePushV2 } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '33333333-3333-4333-8333-333333333333';
const SOURCE_SID = '44444444-4444-4444-8444-444444444444';
const NAME = docName.documentSpace(PID, SID);
const SOURCE_NAME = docName.documentSpace(PID, SOURCE_SID);

/** Whether this process's keymap reads `Mod` as Meta (a Mac platform) or Ctrl. */
const MOD_IS_META = keydownHandler({ 'Mod-z': () => true })(
  {} as EditorView,
  new KeyboardEvent('keydown', { key: 'z', metaKey: true }),
);

let spies: StepSpies;
const containers: HTMLElement[] = [];
const detachers: Array<() => void> = [];

/** An open body and the facts the cases compare. */
interface Body {
  handle: DocumentEditorHandle;
  doc: Y.Doc;
  view: EditorView;
}

/**
 * Opens one document's body through the editor cache.
 * @param doc - The document.
 * @param name - Its name.
 * @returns The handle.
 */
function openEditor(doc: Y.Doc, name: string): DocumentEditorHandle {
  const handle = getDocumentEditor(doc, name, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'owner', viewerId: 'u1' }),
    editable: true,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  adoptDocumentEditor(handle, container);
  return handle;
}

/**
 * Opens the body under test, then loads these paragraphs into it as a remote
 * update written by a second editor, and empties the undo stack.
 * @param paragraphs - The text of each top-level paragraph.
 * @returns The body.
 */
function openBody(paragraphs: readonly string[]): Body {
  const doc = getDoc(NAME);
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const handle = openEditor(doc, NAME);
  const source = getDoc(SOURCE_NAME);
  Y.applyUpdate(source, Y.encodeStateAsUpdate(doc));
  const writer = openEditor(source, SOURCE_NAME);
  act(() => {
    writer.editor.replaceBlocks(writer.editor.document, paragraphs.map((content) => ({ type: 'paragraph', content }) as never));
  });
  act(() => { Y.applyUpdate(doc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(doc)), 'remote'); });
  handle.undoManager.stopCapturing();
  handle.undoManager.clear();
  const body = { handle, doc, view: handle.editor.prosemirrorView };
  expect(blocks(body)).toEqual(paragraphs);
  return body;
}

/**
 * The body's blocks; the handle types its editor with `never` schemas.
 * @param body - The body.
 * @returns The top-level blocks.
 */
function docBlocks(body: Body): Array<{ id: string; content?: unknown }> {
  return body.handle.editor.document;
}

/**
 * The text of every top-level block, in order.
 * @param body - The body.
 * @returns One string per block.
 */
function blocks(body: Body): string[] {
  return docBlocks(body).map((block) =>
    ((block.content ?? []) as Array<{ text?: string }>).map((run) => run.text ?? '').join(''));
}

/**
 * The position just after the `offset`-th character of the `index`-th
 * paragraph's text (0 is its start).
 * @param body - The body.
 * @param index - Which top-level paragraph.
 * @param offset - Characters into it.
 * @returns The ProseMirror position.
 */
function textPos(body: Body, index: number, offset: number): number {
  let seen = -1;
  let found = -1;
  body.view.state.doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.type.name === 'paragraph') {
      seen += 1;
      if (seen === index) found = pos + 1 + offset;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no paragraph ${String(index)}`);
  return found;
}

/**
 * One local step, ended so the next is a separate undo entry.
 * @param body - The body.
 * @param write - The edit.
 */
function step(body: Body, write: () => void): void {
  act(write);
  body.handle.undoManager.stopCapturing();
}

/**
 * Types text at a position, as one step.
 * @param body - The body.
 * @param pos - Where.
 * @param text - What.
 */
function type(body: Body, pos: number, text: string): void {
  step(body, () => {
    const { state } = body.view;
    body.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).insertText(text));
  });
}

/**
 * Deletes a range, as one step.
 * @param body - The body.
 * @param from - Start.
 * @param to - End.
 */
function remove(body: Body, from: number, to: number): void {
  step(body, () => { body.view.dispatch(body.view.state.tr.delete(from, to)); });
}

/**
 * Pastes paragraphs at a caret the way ProseMirror pastes a copied range:
 * the slice open at both ends, so the first and last paragraphs join the
 * text around the caret.
 * @param body - The body.
 * @param pos - The caret.
 * @param paragraphs - The pasted paragraphs.
 */
function paste(body: Body, pos: number, paragraphs: readonly string[]): void {
  step(body, () => {
    const { state } = body.view;
    const { schema } = state;
    const fragment = Fragment.from(paragraphs.map((text) =>
      schema.nodes.blockContainer.create(null, schema.nodes.paragraph.create(null, schema.text(text)))));
    const tr = state.tr.setSelection(TextSelection.create(state.doc, pos)).replaceSelection(Slice.maxOpen(fragment));
    body.view.dispatch(tr.setMeta('paste', true).setMeta('uiEvent', 'paste'));
  });
}

/**
 * Presses a key inside the editor.
 * @param body - The body.
 * @param key - `KeyboardEvent.key`.
 * @param mods - Modifiers; `mod` is this platform's `Mod`.
 */
function press(body: Body, key: string, mods: { mod?: boolean; ctrl?: boolean; shift?: boolean }): void {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: mods.mod === true && MOD_IS_META,
    ctrlKey: mods.ctrl === true || (mods.mod === true && !MOD_IS_META),
    shiftKey: mods.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    body.view.someProp('handleKeyDown', (handler) => handler(body.view, event));
  });
}

/**
 * Presses Mod-z and judges what it wrote.
 * @param body - The body.
 * @returns The kind of the update the press wrote.
 */
function undoPress(body: Body): StepKind {
  return kindOf(body.doc, () => { press(body, 'z', { mod: true }); });
}

/**
 * Sets the size state and clears the counters, so only what follows is counted.
 * @param fixture - The push.
 */
function enter(fixture: DocSizePushV2): void {
  enterSize(NAME, fixture);
  spies.undo.mockClear();
  spies.redo.mockClear();
  vi.mocked(toast.warning).mockClear();
}

/** What a refused step must leave untouched. */
interface Snapshot {
  update: Uint8Array;
  fragment: string;
  pm: unknown;
  stacks: number[];
}

/**
 * Captures the document, the PM doc and the stack lengths.
 * @param body - The body.
 * @returns The snapshot.
 */
function snapshot(body: Body): Snapshot {
  return {
    update: Y.encodeStateAsUpdate(body.doc),
    fragment: documentBodyFragment(body.doc).toString(),
    pm: body.view.state.doc.toJSON(),
    stacks: [body.handle.undoManager.undoStack.length, body.handle.undoManager.redoStack.length],
  };
}

/**
 * Runs a press that must be refused and checks it left everything as it was
 * and said so once.
 * @param body - The body.
 * @param run - The press.
 * @param sentence - The toast it must show.
 */
function expectRefused(body: Body, run: () => void, sentence: string): void {
  const before = snapshot(body);
  const update = localUpdate(body.doc, run);
  expect(update).toBeNull();
  expect(snapshot(body)).toEqual(before);
  expect(spies.undo.mock.contexts).not.toContain(body.handle.undoManager);
  expect(spies.redo.mock.contexts).not.toContain(body.handle.undoManager);
  expect(toast.warning).toHaveBeenCalledTimes(1);
  expect(toast.warning).toHaveBeenCalledWith(sentence);
  expect(toast.error).not.toHaveBeenCalled();
}

/**
 * Checks a press ran without a toast and was judged on a copy first.
 * @param body - The body.
 */
function expectRan(body: Body): void {
  expect(spies.contexts()).toContain(body.handle.undoManager);
  expect(trialRan(spies, body.doc)).toBe(true);
  expect(toast.warning).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
}

beforeEach(() => {
  changeLocale('en');
  spies = spyOnSteps();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  detachers.splice(0).forEach((detach) => { detach(); });
  cleanup();
  spies.restore();
  _resetDocumentEditorCacheForTests();
  containers.splice(0).forEach((container) => { container.remove(); });
  clearAllDocSizes();
  _resetForTests();
});

describe('H-03 taking typed text back', () => {
  it('H-03 when full the trial is a delete; Mod-z runs and writes a delete', () => {
    const body = openBody(['hello']);
    type(body, textPos(body, 0, 5), ' world');
    expect(blocks(body)).toEqual(['hello world']);
    enter(P_FULL);

    expect(trialKind(body.handle.undoManager, 'undo')).toBe('delete');
    spies.undo.mockClear();
    expect(undoPress(body)).toBe('delete');

    expect(blocks(body)).toEqual(['hello']);
    expectRan(body);
  });

  it('H-03 over the ceiling Mod-z is refused with T_OVER', () => {
    const body = openBody(['hello']);
    type(body, textPos(body, 0, 5), ' world');
    enter(P_OVER);

    expectRefused(body, () => { press(body, 'z', { mod: true }); }, COPY_V2_EN.T_OVER);
    expect(blocks(body)).toEqual(['hello world']);
  });
});

describe('H-04 undoing a newly inserted paragraph', () => {
  it.each([
    ['full', P_FULL],
    ['over the ceiling', P_OVER],
  ] as const)('H-04 %s: the trial is a remove; Mod-z runs and writes a remove', (_label, fixture) => {
    const body = openBody(['hello']);
    step(body, () => {
      body.handle.editor.insertBlocks([{ type: 'paragraph', content: 'new' } as never], docBlocks(body)[0].id, 'after');
    });
    expect(blocks(body)).toEqual(['hello', 'new']);
    enter(fixture);

    expect(trialKind(body.handle.undoManager, 'undo')).toBe('remove');
    spies.undo.mockClear();
    expect(undoPress(body)).toBe('remove');

    expect(blocks(body)).toEqual(['hello']);
    expectRan(body);
  });
});

describe('H-06 undoing a deletion of text when full', () => {
  it('H-06 the trial is an add; Mod-z is refused with T_ADD and nothing is popped', () => {
    const body = openBody(['hello world']);
    remove(body, textPos(body, 0, 6), textPos(body, 0, 11));
    expect(blocks(body)).toEqual(['hello ']);
    enter(P_FULL);

    expect(trialKind(body.handle.undoManager, 'undo')).toBe('add');
    vi.mocked(toast.warning).mockClear();
    expectRefused(body, () => { press(body, 'z', { mod: true }); }, COPY_V2_EN.T_ADD);
    expect(blocks(body)).toEqual(['hello ']);
  });
});

describe('H-08 insert, delete, undo the delete, then undo the insert', () => {
  /**
   * Types `abc`, deletes it, and undoes the deletion, all below the limit.
   * @returns The body, showing `helloabc`.
   */
  function prepared(): Body {
    const body = openBody(['hello']);
    type(body, textPos(body, 0, 5), 'abc');
    remove(body, textPos(body, 0, 5), textPos(body, 0, 8));
    press(body, 'z', { mod: true });
    body.handle.undoManager.stopCapturing();
    expect(blocks(body)).toEqual(['helloabc']);
    return body;
  }

  it('H-08 when full the trial is a delete and the undo runs', () => {
    const body = prepared();
    enter(P_FULL);

    expect(trialKind(body.handle.undoManager, 'undo')).toBe('delete');
    spies.undo.mockClear();
    expect(undoPress(body)).toBe('delete');

    expect(blocks(body)).toEqual(['hello']);
    expectRan(body);
  });

  it('H-08 over the ceiling the undo is refused with T_OVER', () => {
    const body = prepared();
    enter(P_OVER);

    expectRefused(body, () => { press(body, 'z', { mod: true }); }, COPY_V2_EN.T_OVER);
    expect(blocks(body)).toEqual(['helloabc']);
  });
});

describe('H-11 paste a block, type into another, delete it, undo the delete', () => {
  /**
   * Builds the history below the limit.
   * @returns The body, showing all three blocks again.
   */
  function prepared(): Body {
    const body = openBody(['Intro', 'Body ']);
    step(body, () => {
      body.handle.editor.insertBlocks([{ type: 'paragraph', content: 'Pasted quote' } as never], docBlocks(body)[1].id, 'after');
    });
    type(body, textPos(body, 1, 5), 'and more words');
    step(body, () => { body.handle.editor.removeBlocks([docBlocks(body)[1].id]); });
    press(body, 'z', { mod: true });
    body.handle.undoManager.stopCapturing();
    expect(blocks(body)).toEqual(['Intro', 'Body and more words', 'Pasted quote']);
    return body;
  }

  it('H-11 when full the trial is a delete; the undo runs and takes the typed words back', () => {
    const body = prepared();
    enter(P_FULL);

    expect(trialKind(body.handle.undoManager, 'undo')).toBe('delete');
    spies.undo.mockClear();
    expect(undoPress(body)).toBe('delete');

    expect(blocks(body)).toEqual(['Intro', 'Body ', 'Pasted quote']);
    expectRan(body);
  });

  it('H-11 over the ceiling the undo is refused with T_OVER', () => {
    const body = prepared();
    enter(P_OVER);

    expectRefused(body, () => { press(body, 'z', { mod: true }); }, COPY_V2_EN.T_OVER);
    expect(blocks(body)).toEqual(['Intro', 'Body and more words', 'Pasted quote']);
  });
});

/** The three places a paste can land (D23). */
const PASTES = [
  {
    label: '(a) into an empty block',
    start: ['hello', ''],
    at: (body: Body): number => textPos(body, 1, 0),
    kind: 'remove',
    full: 'runs',
    over: 'runs',
  },
  {
    label: '(b) several paragraphs at the end of a line',
    start: ['hello'],
    at: (body: Body): number => textPos(body, 0, 5),
    kind: 'delete',
    full: 'runs',
    over: 'refused',
  },
  {
    label: '(c) in the middle of text',
    start: ['hello'],
    at: (body: Body): number => textPos(body, 0, 2),
    kind: 'add',
    full: 'refused',
    over: 'refused',
  },
] as const;

describe('H-12 undoing a paste, by where it landed', () => {
  it.each(PASTES)('H-12 $label: the trial is a $kind', ({ start, at, kind }) => {
    const body = openBody(start);
    paste(body, at(body), ['one', 'two']);
    enter(P_FULL);

    expect(trialKind(body.handle.undoManager, 'undo')).toBe(kind);
  });

  it.each(PASTES)('H-12 $label: when full the undo $full', ({ start, at, kind, full }) => {
    const body = openBody(start);
    paste(body, at(body), ['one', 'two']);
    enter(P_FULL);

    if (full === 'runs') {
      expect(undoPress(body)).toBe(kind);
      expect(blocks(body)).toEqual(start);
      expectRan(body);
    } else {
      expectRefused(body, () => { press(body, 'z', { mod: true }); }, COPY_V2_EN.T_ADD);
    }
  });

  it.each(PASTES)('H-12 $label: over the ceiling the undo $over', ({ start, at, over }) => {
    const body = openBody(start);
    paste(body, at(body), ['one', 'two']);
    enter(P_OVER);

    if (over === 'runs') {
      expect(undoPress(body)).toBe('remove');
      expect(blocks(body)).toEqual(start);
      expectRan(body);
    } else {
      expectRefused(body, () => { press(body, 'z', { mod: true }); }, COPY_V2_EN.T_OVER);
    }
  });
});

describe('H-18 redoing an undone paragraph insertion when full', () => {
  it('H-18 the trial is an add; Shift-Mod-z is refused with T_ADD and the redo stack stays', () => {
    const body = openBody(['hello']);
    step(body, () => {
      body.handle.editor.insertBlocks([{ type: 'paragraph', content: 'new' } as never], docBlocks(body)[0].id, 'after');
    });
    press(body, 'z', { mod: true });
    expect(blocks(body)).toEqual(['hello']);
    enter(P_FULL);

    expect(trialKind(body.handle.undoManager, 'redo')).toBe('add');
    vi.mocked(toast.warning).mockClear();
    expectRefused(body, () => { press(body, 'z', { mod: true, shift: true }); }, COPY_V2_EN.T_ADD);
    expect(blocks(body)).toEqual(['hello']);
  });
});

describe('H-19 every body key path goes through the judgement', () => {
  it('H-19 Mod-z of a text deletion is refused when full', () => {
    const body = openBody(['hello world']);
    remove(body, textPos(body, 0, 6), textPos(body, 0, 11));
    enter(P_FULL);

    expectRefused(body, () => { press(body, 'z', { mod: true }); }, COPY_V2_EN.T_ADD);
  });

  it.each([
    ['Mod-Shift-z', 'z', { mod: true, shift: true }],
    ['Ctrl-y', 'y', { ctrl: true }],
  ] as const)('H-19 %s redoing undone typing is refused when full', (_label, key, mods) => {
    const body = openBody(['hello']);
    type(body, textPos(body, 0, 5), ' world');
    press(body, 'z', { mod: true });
    expect(blocks(body)).toEqual(['hello']);
    enter(P_FULL);

    expectRefused(body, () => { press(body, key, mods); }, COPY_V2_EN.T_ADD);
    expect(blocks(body)).toEqual(['hello']);
  });

  it.each([
    ['Cmd+Z', { meta: true }],
    ['Ctrl+Z', { ctrl: true }],
  ] as const)('H-19 %s on the focused scroller is refused when full', (_label, mods) => {
    const body = openBody(['hello world']);
    const scroller = document.createElement('div');
    containers[0].appendChild(scroller);
    detachers.push(attachBodyScroller(body.view, scroller, body.handle.editor));
    remove(body, textPos(body, 0, 6), textPos(body, 0, 11));
    enter(P_FULL);

    expectRefused(body, () => {
      act(() => {
        scroller.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'z',
          metaKey: 'meta' in mods,
          ctrlKey: 'ctrl' in mods,
          bubbles: true,
          cancelable: true,
        }));
      });
    }, COPY_V2_EN.T_ADD);
    expect(blocks(body)).toEqual(['hello ']);
  });
});
