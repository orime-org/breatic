// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec section 10 (the ProseMirror size filter: the
 * state table, remote transactions, step 0 appended transactions, step 1
 * refusal and toast choice) and section 13 (Backspace in an empty block,
 * taken over by the filter's `handleKeyDown` when full or over the ceiling).
 *
 * Every editor is the production one: the document body through
 * `getDocumentEditor`, the canvas text node body through
 * `buildTextNodeExtensions`, the prompt through the list `PromptEditor`
 * composes (with the reference chip whitespace plugin). Content arrives as a
 * remote update before each case (spec 0.1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { documentBodyFragment } from '@breatic/shared';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { ySyncPluginKey as yProsemirrorSyncKey } from 'y-prosemirror';
import { ySyncPluginKey as yTiptapSyncKey } from '@web/features/collab-editor/collab-plugin-keys';
import { deleteRow } from '@web/spaces/document/document-handle-commands';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import {
  CANVAS_NAME,
  CHIP_A,
  CHIP_B,
  COPY,
  DOCUMENT_NAME,
  backspaceChar,
  capture,
  chipParagraph,
  clearToasts,
  cut,
  enterState,
  expectBodyInStep,
  expectNoTextMappings,
  expectTiptapInStep,
  expectUntouched,
  expectWarnings,
  flush,
  mountBody,
  nodesOf,
  openBody,
  openTiptap,
  paragraphs,
  posOf,
  press,
  remoteBodyParagraph,
  remoteChange,
  remoteTiptapEdit,
  remoteTiptapYjs,
  resetHarness,
  rows,
  select,
  typeText,
  type BlockInput,
  type OpenBody,
  type SizeCode,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

/** One editor under test, whichever binding it is on. */
interface Subject {
  readonly view: EditorView;
  readonly doc: Y.Doc;
  /** Asserts the editor and its Yjs fragment show the same document. */
  readonly inStep: () => void;
}

/** How each editor in the D and T passes is opened on paragraphs of text. */
interface EditorCase {
  readonly label: string;
  readonly name: string;
  readonly open: (texts: string[]) => Subject;
}

/**
 * A paragraph block.
 * @param text - Its text, or none.
 * @param children - Nested blocks.
 * @returns The block input.
 */
function p(text = '', children?: BlockInput[]): BlockInput {
  return { type: 'paragraph', ...(text !== '' && { content: text }), ...(children !== undefined && { children }) };
}

const IMAGE: BlockInput = { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a' } };

const BODY: EditorCase = {
  label: 'D document body',
  name: DOCUMENT_NAME,
  open: (texts) => {
    const body = openBody(texts.map((text) => p(text)));
    return { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
  },
};

const TEXT_NODE: EditorCase = {
  label: 'T canvas text node body',
  name: CANVAS_NAME,
  open: (texts) => {
    const open = openTiptap('textBody', paragraphs(...texts));
    return { view: open.view, doc: open.doc, inStep: () => { expectTiptapInStep(open); } };
  },
};

const PROMPT: EditorCase = {
  label: 'T prompt',
  name: CANVAS_NAME,
  open: (texts) => {
    const open = openTiptap('prompt', paragraphs(...texts));
    return { view: open.view, doc: open.doc, inStep: () => { expectTiptapInStep(open); } };
  },
};

const EDITORS: readonly EditorCase[] = [BODY, TEXT_NODE, PROMPT];

/**
 * Puts the caret right after a needle.
 * @param view - The view.
 * @param needle - Text.
 */
function caretAfter(view: EditorView, needle: string): void {
  select(view, posOf(view.state.doc, needle, needle.length));
}

/**
 * Selects a needle.
 * @param view - The view.
 * @param needle - Text.
 */
function selectText(view: EditorView, needle: string): void {
  const from = posOf(view.state.doc, needle);
  select(view, from, from + needle.length);
}

/**
 * Bolds a needle with the editor's own shortcut.
 * @param view - The view.
 * @param needle - Text.
 */
function bold(view: EditorView, needle: string): void {
  selectText(view, needle);
  press(view, 'b', { mod: true });
}

/**
 * The first block id of a body whose content is the needle.
 * @param body - The open body.
 * @param index - Top-level index.
 * @returns The id.
 */
function idAt(body: OpenBody, index: number): string {
  return body.editor.document[index].id;
}

/**
 * Starts a case: the size state, then a capture and a snapshot of the editor's document.
 * @param subject - The editor.
 * @param name - The document name.
 * @param code - The state.
 * @returns The capture and the document before the operation.
 */
function begin(subject: Subject, name: string, code: SizeCode): { cap: ReturnType<typeof capture>; before: PMNode } {
  enterState(name, code);
  return { cap: capture(subject.doc), before: subject.view.state.doc };
}

/**
 * Asserts a refused operation left everything as it was.
 * @param subject - The editor.
 * @param run - The case's capture and snapshot.
 * @param run.cap - The capture.
 * @param run.before - The editor's document before.
 */
function expectRefused(subject: Subject, { cap, before }: { cap: ReturnType<typeof capture>; before: PMNode }): void {
  expect(subject.view.state.doc.eq(before)).toBe(true);
  expect(cap.shape()).toBe('∅');
  expectUntouched(subject.doc, cap);
}

beforeEach(() => {
  changeLocale('en');
  clearToasts();
});

afterEach(() => {
  resetHarness();
});

// ---------------------------------------------------------------------------
// 10.1 States and remote transactions.

describe('10.1 states and remote transactions', () => {
  const ops: ReadonlyArray<{ op: string; bodyOnly: boolean; run: (view: EditorView) => void; expected: string }> = [
    { op: 'typing x', bodyOnly: false, run: (view) => { caretAfter(view, 'hello'); typeText(view, 'x'); }, expected: 'hellox world' },
    { op: 'pasting abc', bodyOnly: false, run: (view) => { caretAfter(view, 'hello'); view.pasteText('abc'); }, expected: 'helloabc world' },
    { op: 'bolding hello', bodyOnly: true, run: (view) => { bold(view, 'hello'); }, expected: 'hello world' },
  ];
  const cases = EDITORS.flatMap((editor) => (['U', 'N', 'W'] as const).flatMap((code) =>
    ops.filter((o) => !o.bodyOnly || editor === BODY).map((o) => ({ editor, code, ...o }))));

  it.each(cases)('G-01: $editor.label in $code, $op writes to Yjs as usual (S), no toast', async ({ editor, code, run, expected }) => {
    const subject = editor.open(['hello world']);
    const { cap } = begin(subject, editor.name, code);
    run(subject.view);
    await flush();
    expect(subject.view.state.doc.textContent).toBe(expected);
    expect(cap.shape()).toBe('S');
    subject.inStep();
    expectWarnings();
  });

  it('G-01: bolding while warning puts the bold mark into Yjs (document body)', async () => {
    const subject = BODY.open(['hello world']);
    begin(subject, BODY.name, 'W');
    bold(subject.view, 'hello');
    await flush();
    const at = posOf(subject.view.state.doc, 'hello') + 1;
    expect(subject.view.state.doc.resolve(at).marks().map((mark) => mark.type.name)).toContain('bold');
    subject.inStep();
  });

  const resyncOps: ReadonlyArray<{ op: string; run: (view: EditorView) => void }> = [
    { op: 'typing', run: (view) => { caretAfter(view, 'hello'); typeText(view, 'x'); } },
    { op: 'deleting a character', run: (view) => { caretAfter(view, 'world'); backspaceChar(view); } },
    { op: 'pasting', run: (view) => { caretAfter(view, 'hello'); view.pasteText('abc'); } },
  ];

  it.each(EDITORS.flatMap((editor) => resyncOps.map((o) => ({ editor, ...o }))))(
    'G-02: $editor.label while resyncing, $op leaves the editor unchanged, writes nothing, no toast',
    async ({ editor, run }) => {
      const subject = editor.open(['hello world']);
      const started = begin(subject, editor.name, 'Z');
      run(subject.view);
      await flush();
      expectRefused(subject, started);
      expectWarnings();
    },
  );

  it.each(EDITORS.flatMap((editor) => (['F', 'O'] as const).map((code) => ({ editor, code }))))(
    'G-03: $editor.label in $code shows a peer\'s new paragraph, no toast, writes nothing',
    async ({ editor, code }) => {
      if (editor === BODY) {
        const body = openBody([p('hello world')]);
        enterState(DOCUMENT_NAME, code);
        const cap = capture(body.doc);
        remoteBodyParagraph(body.doc, 'peer');
        await flush();
        expect(rows(body.view.state.doc)).toEqual([['paragraph', 'hello world'], ['paragraph', 'peer']]);
        expect(cap.shape()).toBe('∅');
        expectBodyInStep(body);
      } else {
        const open = openTiptap(editor === PROMPT ? 'prompt' : 'textBody', paragraphs('hello world'));
        enterState(CANVAS_NAME, code);
        const cap = capture(open.doc);
        remoteTiptapEdit(open, (peer) => {
          peer.commands.insertContentAt(peer.state.doc.content.size, { type: 'paragraph', content: [{ type: 'text', text: 'peer' }] });
        });
        await flush();
        expect(open.view.state.doc.textContent).toBe('hello worldpeer');
        expect(cap.shape()).toBe('∅');
        expectTiptapInStep(open);
      }
      expectWarnings();
    },
  );

  it('G-03: a local transaction carrying the editor\'s own sync key meta passes while full; the other binding\'s key does not', async () => {
    const open = openTiptap('textBody', paragraphs('hello world'));
    enterState(CANVAS_NAME, 'F');
    open.view.dispatch(open.view.state.tr.insertText('Z', 6).setMeta(yTiptapSyncKey, { addToHistory: false }));
    expect(open.view.state.doc.textContent).toBe('helloZ world');
    expectWarnings();

    const before = open.view.state.doc;
    const cap = capture(open.doc);
    open.view.dispatch(open.view.state.tr.insertText('Y', 6).setMeta(yProsemirrorSyncKey, { isChangeOrigin: true }));
    await flush();
    expect(open.view.state.doc.eq(before)).toBe(true);
    expect(cap.shape()).toBe('∅');
    expectWarnings(COPY.T_ADD);
  });

  it.each(EDITORS)('G-04: $label in F, the redraw after an executor write is let through and matches Yjs', async (editor) => {
    const subject = editor.open(['Hello world']);
    enterState(editor.name, 'F');
    selectText(subject.view, 'llo');
    press(subject.view, 'Backspace');
    await flush();
    expect(subject.view.state.doc.textContent).toBe('He world');
    subject.inStep();
    expectWarnings();
  });
});

// ---------------------------------------------------------------------------
// 10.2 Step 0: appended transactions.

describe('10.2 step 0, appended transactions', () => {
  it('G-10: T prompt in F, deleting text beside a chip; the whitespace fix appended after the redraw is dropped silently', async () => {
    // `ello ` is part of the run before the chip, so the deletion is a text
    // range (D); the chip then has no space on its left and the whitespace
    // plugin appends one after the executor's redraw.
    const open = openTiptap('prompt', chipParagraph('hello ', CHIP_A, ' world'));
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    const from = posOf(open.view.state.doc, 'ello ');
    select(open.view, from, from + 5);
    press(open.view, 'Backspace');
    await flush();
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(open.view.state.doc.textContent).toBe('h world');
    expectTiptapInStep(open);
    expectWarnings();

    remoteTiptapYjs(open, (fragment) => {
      const paragraph = fragment.get(0) as Y.XmlElement;
      const tail = paragraph.get(paragraph.length - 1) as Y.XmlText;
      tail.insert(tail.length, '!');
    });
    await flush();
    expect(open.view.state.doc.textContent).toBe('h world!');
    expect(cap.updates).toHaveLength(1);
    expectWarnings();
  });

  it('G-11: T prompt in F, only a peer update arrives, leaving a chip without its space: no toast, nothing written', async () => {
    const open = openTiptap('prompt', chipParagraph('hello ', CHIP_A, ' world'));
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    remoteTiptapYjs(open, (fragment) => {
      const paragraph = fragment.get(0) as Y.XmlElement;
      const head = paragraph.get(0) as Y.XmlText;
      head.delete(head.length - 1, 1);
    });
    await flush();
    expect(open.view.state.doc.textContent).toBe('hello world');
    expect(cap.shape()).toBe('∅');
    expectWarnings();
  });

  it('G-12: D an old full document loaded from a peer, with content SchemaMigration rewrites: no toast, nothing written, shown', async () => {
    const body = mountBody();
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    remoteChange(body.doc, (peer) => {
      // The pre-migration layout: colours on the blockContainer, not on the paragraph.
      const group = new Y.XmlElement('blockGroup');
      const container = new Y.XmlElement('blockContainer');
      container.setAttribute('id', 'legacy-1');
      container.setAttribute('backgroundColor', 'red');
      container.setAttribute('textColor', 'blue');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Welcome')]);
      container.insert(0, [paragraph]);
      group.insert(0, [container]);
      documentBodyFragment(peer).insert(0, [group]);
    });
    await flush();
    expect(body.view.state.doc.textContent).toBe('Welcome');
    expect(cap.shape()).toBe('∅');
    expectNoTextMappings(body.view, body.syncKey);
    expectWarnings();
  });

  it('G-13: T prompt in W, the same deletion beside a chip writes the appended whitespace fix to Yjs', async () => {
    const open = openTiptap('prompt', chipParagraph('hello ', CHIP_A, ' world'));
    enterState(CANVAS_NAME, 'W');
    const from = posOf(open.view.state.doc, 'ello ');
    select(open.view, from, from + 5);
    press(open.view, 'Backspace');
    await flush();
    // `h`, the restored space, the chip, ` world`.
    expect(open.view.state.doc.textContent).toBe('h  world');
    expectTiptapInStep(open);
    expectWarnings();
  });
});

// ---------------------------------------------------------------------------
// 10.3 Step 1: refusal and the toast it shows, in F.

describe('10.3 step 1, refusal and toast choice', () => {
  const typingOps: ReadonlyArray<{ op: string; run: (view: EditorView) => void }> = [
    { op: 'typing z with no selection', run: (view) => { caretAfter(view, 'hello'); typeText(view, 'z'); } },
    { op: 'Enter', run: (view) => { caretAfter(view, 'hello'); press(view, 'Enter'); } },
    { op: 'pasting abc', run: (view) => { caretAfter(view, 'hello'); view.pasteText('abc'); } },
  ];

  it.each(EDITORS.flatMap((editor) => typingOps.map((o) => ({ editor, ...o }))))(
    'G-20: $editor.label in F, $op is refused with the add toast',
    async ({ editor, run }) => {
      const subject = editor.open(['hello world']);
      const started = begin(subject, editor.name, 'F');
      run(subject.view);
      await flush();
      expectRefused(subject, started);
      expectWarnings(COPY.T_ADD);
    },
  );

  it.each([
    { op: 'bolding a word', run: (body: OpenBody) => { bold(body.view, 'hello'); } },
    { op: 'centring the paragraph', run: (body: OpenBody) => { body.editor.updateBlock(idAt(body, 0), { props: { textAlignment: 'center' } } as never); } },
  ])('G-21: D in F, $op is refused with the add toast', async ({ run }) => {
    const body = openBody([p('hello world')]);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'F');
    run(body);
    await flush();
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it('G-21: D in F, resizing an image block is refused with the add toast', async () => {
    const body = openBody([IMAGE, p('x')]);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'F');
    body.editor.updateBlock(idAt(body, 0), { props: { previewWidth: 320 } } as never);
    await flush();
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it.each([
    { op: 'the slash menu turning a paragraph into a heading', blocks: [p('hello'), p('x')], run: (body: OpenBody) => { body.editor.updateBlock(idAt(body, 0), { type: 'heading', props: { level: 1 } } as never); } },
    { op: 'Mod-Alt-0 on a heading', blocks: [{ type: 'heading', props: { level: 1 }, content: 'hello' }, p('x')], run: (body: OpenBody) => { caretAfter(body.view, 'hel'); press(body.view, '0', { mod: true, alt: true }); } },
    { op: 'Tab indenting the second block', blocks: [p('a'), p('b')], run: (body: OpenBody) => { caretAfter(body.view, 'b'); press(body.view, 'Tab'); } },
    { op: 'Shift-Tab unindenting a child block', blocks: [p('a', [p('b')])], run: (body: OpenBody) => { caretAfter(body.view, 'b'); press(body.view, 'Tab', { shift: true }); } },
  ])('G-22: D in F, $op is refused with the add toast and the block structure stays', async ({ blocks, run }) => {
    const body = openBody(blocks);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'F');
    const rowsBefore = rows(body.view.state.doc);
    run(body);
    await flush();
    expect(rows(body.view.state.doc)).toEqual(rowsBefore);
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it.each([
    { op: 'Mod-Shift-ArrowDown on an image block', blocks: [IMAGE, p('x')], run: (body: OpenBody) => {
      body.view.dispatch(body.view.state.tr.setSelection(NodeSelection.create(body.view.state.doc, nodesOf(body.view.state.doc, 'image')[0])));
      press(body.view, 'ArrowDown', { mod: true, shift: true });
    } },
    { op: 'Mod-Shift-ArrowDown on an empty paragraph', blocks: [p(''), p('x')], run: (body: OpenBody) => {
      select(body.view, nodesOf(body.view.state.doc, 'paragraph')[0] + 1);
      press(body.view, 'ArrowDown', { mod: true, shift: true });
    } },
    { op: 'dragging an image block below the next one by its handle', blocks: [IMAGE, p('x')], run: (body: OpenBody) => {
      moveRowTo(body.view, idAt(body, 0), body.view.state.doc.content.size - 2);
    } },
    { op: 'dragging an empty paragraph below the next one by its handle', blocks: [p(''), p('x')], run: (body: OpenBody) => {
      moveRowTo(body.view, idAt(body, 0), body.view.state.doc.content.size - 2);
    } },
  ])('G-23: D in F, $op is refused with the add toast and nothing is deleted', async ({ blocks, run }) => {
    const body = openBody(blocks);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'F');
    const rowsBefore = rows(body.view.state.doc);
    run(body);
    await flush();
    expect(rows(body.view.state.doc)).toEqual(rowsBefore);
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it.each(EDITORS)('G-24: $label in F, Enter over a selected word is refused with the add toast and the word stays', async (editor) => {
    const subject = editor.open(['hello world']);
    const started = begin(subject, editor.name, 'F');
    selectText(subject.view, 'world');
    press(subject.view, 'Enter');
    await flush();
    expect(subject.view.state.doc.textContent).toBe('hello world');
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it.each(EDITORS.flatMap((editor) => [
    { editor, op: 'typing w over world', text: 'hello world', run: (view: EditorView) => { selectText(view, 'world'); typeText(view, 'w'); } },
    { editor, op: 'pasting lunch over launch', text: 'launch', run: (view: EditorView) => { selectText(view, 'launch'); view.pasteText('lunch'); } },
  ]))('G-25: $editor.label in F, $op (only letters of the selection) is refused with the add toast', async ({ editor, text, run }) => {
    const subject = editor.open([text]);
    const started = begin(subject, editor.name, 'F');
    run(subject.view);
    await flush();
    expect(subject.view.state.doc.textContent).toBe(text);
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it.each(EDITORS)('G-26: $label in F, typing z over a selected word is refused with the add toast', async (editor) => {
    const subject = editor.open(['hello world']);
    const started = begin(subject, editor.name, 'F');
    selectText(subject.view, 'world');
    typeText(subject.view, 'z');
    await flush();
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it.each(EDITORS.flatMap((editor) => [
    { editor, op: 'Backspace at the start of World', run: (view: EditorView) => { select(view, posOf(view.state.doc, 'World')); press(view, 'Backspace'); } },
    { editor, op: 'Delete at the end of Hello', run: (view: EditorView) => { caretAfter(view, 'Hello'); press(view, 'Delete'); } },
  ]))('G-27: $editor.label in F, $op (joining two blocks with content) is refused with the compound toast', async ({ editor, run }) => {
    const subject = editor.open(['Hello', 'World']);
    const started = begin(subject, editor.name, 'F');
    run(subject.view);
    await flush();
    expectRefused(subject, started);
    expectWarnings(COPY.T_COMPOUND);
  });

  it('G-28: D in F, Backspace at the start of a block after an empty one is refused with the compound toast', async () => {
    const body = openBody([p(''), p('x')]);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'F');
    select(body.view, posOf(body.view.state.doc, 'x'));
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', ''], ['paragraph', 'x']]);
    expectRefused(subject, started);
    expectWarnings(COPY.T_COMPOUND);
  });

  it.each(EDITORS)('G-29: $label in F, cutting a selection that only joins two blocks is refused with the compound toast', async (editor) => {
    // From the end of `Hello` to the start of `World`: nothing but the join,
    // which the executor does not take (step 4).
    const subject = editor.open(['Hello', 'World']);
    const started = begin(subject, editor.name, 'F');
    select(subject.view, posOf(subject.view.state.doc, 'Hello', 5), posOf(subject.view.state.doc, 'World'));
    cut(subject.view);
    await flush();
    expectRefused(subject, started);
    expectWarnings(COPY.T_COMPOUND);
  });

  it('G-30: D in F, the side menu deleting the only block, an image, is refused with the compound toast', async () => {
    const body = openBody([IMAGE]);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'F');
    deleteRow(body.editor, idAt(body, 0));
    await flush();
    expect(nodesOf(body.view.state.doc, 'image')).toHaveLength(1);
    expectRefused(subject, started);
    expectWarnings(COPY.T_COMPOUND);
  });

  it('G-31: D in F, Backspace at the start of a heading with content (reset to paragraph) is refused with the compound toast, chosen by the Backspace trigger', async () => {
    const body = openBody([p('a'), { type: 'heading', props: { level: 1 }, content: 'hello' }]);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'F');
    select(body.view, posOf(body.view.state.doc, 'hello'));
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a'], ['heading', 'hello']]);
    expectRefused(subject, started);
    expectWarnings(COPY.T_COMPOUND);
  });

  it.each(EDITORS)('G-32: $label in F, a refused composition is redrawn from the state after compositionend', async (editor) => {
    const subject = editor.open(['hello world']);
    const started = begin(subject, editor.name, 'F');
    const { view } = subject;
    caretAfter(view, 'hello');
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeValue === 'hello world') node.nodeValue = 'hello中 world';
    }
    view.dispatch(view.state.tr.insertText('中', posOf(view.state.doc, 'hello', 5)).setMeta('composition', 1));
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.dom.textContent).not.toContain('中');
    expectRefused(subject, started);
    expectWarnings(COPY.T_ADD);
  });

  it.each([
    ...EDITORS.map((editor) => ({ editor, op: 'G-20 typing z', texts: ['hello world'], run: (view: EditorView) => { caretAfter(view, 'hello'); typeText(view, 'z'); } })),
    ...EDITORS.map((editor) => ({ editor, op: 'G-27 Backspace joining two blocks', texts: ['Hello', 'World'], run: (view: EditorView) => { select(view, posOf(view.state.doc, 'World')); press(view, 'Backspace'); } })),
  ])('G-33: $editor.label in O, $op is refused with the over-ceiling toast', async ({ editor, texts, run }) => {
    const subject = editor.open(texts);
    const started = begin(subject, editor.name, 'O');
    run(subject.view);
    await flush();
    expectRefused(subject, started);
    expectWarnings(COPY.T_OVER);
  });

  it('G-33: D in O, G-22 turning a paragraph into a heading is refused with the over-ceiling toast', async () => {
    const body = openBody([p('hello'), p('x')]);
    const subject: Subject = { view: body.view, doc: body.doc, inStep: () => { expectBodyInStep(body); } };
    const started = begin(subject, DOCUMENT_NAME, 'O');
    body.editor.updateBlock(idAt(body, 0), { type: 'heading', props: { level: 1 } } as never);
    await flush();
    expectRefused(subject, started);
    expectWarnings(COPY.T_OVER);
  });
});

// ---------------------------------------------------------------------------
// 13. Backspace in an empty block, taken over by the filter's handleKeyDown.

/**
 * Puts the caret into the n-th empty paragraph-like textblock of the body.
 * @param view - The view.
 * @param type - The textblock type.
 * @param index - Which one of that type.
 */
function caretInto(view: EditorView, type: string, index = 0): void {
  const found = nodesOf(view.state.doc, type).filter((pos) => view.state.doc.nodeAt(pos)!.content.size === 0);
  select(view, found[index] + 1);
}

describe('13. Backspace in an empty block', () => {
  it.each(['F', 'O'] as const)('K-01: D in %s, an empty block between two is deleted whole (R), caret at the end of the one before', async (code) => {
    const body = openBody([p('a'), p(''), p('b')]);
    enterState(DOCUMENT_NAME, code);
    const cap = capture(body.doc);
    caretInto(body.view, 'paragraph');
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a'], ['paragraph', 'b']]);
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('R');
    expect(body.view.state.selection.from).toBe(posOf(body.view.state.doc, 'a', 1));
    expectBodyInStep(body);
    expectWarnings();
  });

  const emptyTypes: ReadonlyArray<{ type: string; block: BlockInput; pmType: string }> = [
    { type: 'heading', block: { type: 'heading', props: { level: 1 } }, pmType: 'heading' },
    { type: 'bulletListItem', block: { type: 'bulletListItem' }, pmType: 'bulletListItem' },
    { type: 'numberedListItem', block: { type: 'numberedListItem' }, pmType: 'numberedListItem' },
    { type: 'checkListItem', block: { type: 'checkListItem' }, pmType: 'checkListItem' },
    // A quote is a prop any block carries in this schema, not a block type.
    { type: 'quoted paragraph', block: { type: 'paragraph', props: { quoted: true } }, pmType: 'paragraph' },
  ];

  it.each((['F', 'O'] as const).flatMap((code) => emptyTypes.map((entry) => ({ code, ...entry }))))(
    'K-02: D in $code, an empty $type is deleted directly, not turned into a paragraph first',
    async ({ code, block, pmType }) => {
      const body = openBody([p('a'), block]);
      enterState(DOCUMENT_NAME, code);
      const cap = capture(body.doc);
      caretInto(body.view, pmType, pmType === 'paragraph' ? 0 : 0);
      press(body.view, 'Backspace');
      await flush();
      expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a']]);
      expect(cap.shape()).toBe('R');
      expect(body.view.state.selection.from).toBe(posOf(body.view.state.doc, 'a', 1));
      expectBodyInStep(body);
      expectWarnings();
    },
  );

  it.each(['F', 'O'] as const)('K-03: D in %s, the only empty child of a nested group goes with its group', async (code) => {
    const body = openBody([p('a', [p('')])]);
    enterState(DOCUMENT_NAME, code);
    const cap = capture(body.doc);
    caretInto(body.view, 'paragraph');
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a']]);
    expect(() => { body.view.state.doc.check(); }).not.toThrow();
    expect(cap.shape()).toBe('R');
    expect(body.view.state.selection.from).toBe(posOf(body.view.state.doc, 'a', 1));
    expectBodyInStep(body);
    expectWarnings();
  });

  it('K-04: D in F, Backspace in an empty table cell is not taken over: the table keeps every cell, nothing is written', async () => {
    const body = openBody([tableBlock({ rows: [{ cells: ['x', ''] }, { cells: ['y', 'z'] }] })]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    const cells = nodesOf(body.view.state.doc, 'docTableCell');
    select(body.view, nodesOf(body.view.state.doc, 'paragraph').find((pos) => pos > cells[1])! + 1);
    press(body.view, 'Backspace');
    await flush();
    expect(nodesOf(body.view.state.doc, 'docTableCell')).toHaveLength(4);
    expect(nodesOf(body.view.state.doc, 'docTableRow')).toHaveLength(2);
    expect(cap.shape()).toBe('∅');
    expectBodyInStep(body);
  });

  it('K-05: D in F, Backspace in the only block, empty, is not taken over: the block stays, nothing is written', async () => {
    // The editor's own Backspace does nothing here (measured unfull), so
    // nothing is handed to the filter and nothing is refused.
    const body = openBody([p('')]);
    enterState(DOCUMENT_NAME, 'F');
    const cap = capture(body.doc);
    caretInto(body.view, 'paragraph');
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', '']]);
    expect(body.editor.document[0].id).toBe(body.ids[0]);
    expect(cap.shape()).toBe('∅');
    expectWarnings();
  });

  it('K-06: T prompt in F, Backspace in the empty line under a note is not taken over: Yjs keeps the paragraph', async () => {
    // Not taken over (the prompt needs a paragraph); the editor's own
    // Backspace then deletes the note node, a whole-node delete the executor
    // takes, as it does unfull.
    const open = openTiptap('prompt', { type: 'doc', content: [{ type: 'promptNote', attrs: { label: 'Note' } }, { type: 'paragraph' }] });
    enterState(CANVAS_NAME, 'F');
    const cap = capture(open.doc);
    select(open.view, open.view.state.doc.content.size - 1);
    press(open.view, 'Backspace');
    await flush();
    const paragraphsInYjs = open.fragment.toArray().filter((child) => child instanceof Y.XmlElement && child.nodeName === 'paragraph');
    expect(paragraphsInYjs).toHaveLength(1);
    expect(open.view.state.doc.toString()).toBe('doc(paragraph)');
    expect(cap.shape()).toBe('R');
    expectTiptapInStep(open);
    expectWarnings();
  });

  it('K-07: T prompt in F, Backspace at the end of a line of two chips deletes only the second chip', async () => {
    const open = openTiptap('prompt', chipParagraph(' ', CHIP_A, ' ', CHIP_B, ' '));
    enterState(CANVAS_NAME, 'F');
    select(open.view, open.view.state.doc.content.size - 1);
    press(open.view, 'Backspace');
    await flush();
    const chips = nodesOf(open.view.state.doc, 'referenceMention').map((pos) => open.view.state.doc.nodeAt(pos)!.attrs['sourceNodeId'] as string);
    expect(chips).toEqual(['a']);
    expectTiptapInStep(open);
    expectWarnings();
  });

  it('K-08: D in N, Backspace in an empty block is the editor\'s own, written by y-prosemirror', async () => {
    const body = openBody([p('a'), p('')]);
    enterState(DOCUMENT_NAME, 'N');
    const cap = capture(body.doc);
    caretInto(body.view, 'paragraph');
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a']]);
    expect(cap.updates.length).toBeGreaterThan(0);
    expectBodyInStep(body);
    expectWarnings();
  });

  it('K-08: D in N, an empty heading is turned into a paragraph first, as the editor does it', async () => {
    const body = openBody([p('a'), { type: 'heading', props: { level: 1 } }]);
    enterState(DOCUMENT_NAME, 'N');
    caretInto(body.view, 'heading');
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a'], ['paragraph', '']]);
    expectBodyInStep(body);
    expectWarnings();
  });

  it('K-09: after K-01, warning and one undo bring the empty block back', async () => {
    const body = openBody([p('a'), p(''), p('b')]);
    enterState(DOCUMENT_NAME, 'F');
    caretInto(body.view, 'paragraph');
    press(body.view, 'Backspace');
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a'], ['paragraph', 'b']]);
    enterState(DOCUMENT_NAME, 'W');
    body.editor.undo();
    await flush();
    expect(rows(body.view.state.doc)).toEqual([['paragraph', 'a'], ['paragraph', ''], ['paragraph', 'b']]);
    expectBodyInStep(body);
  });
});
