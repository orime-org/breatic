// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1790 v2 web test spec 21.3 and 23.6: one paragraph of marked text
 * runs (bold, italic, a link, a comment mark), loaded into the document body
 * as a remote update, and template `X7` (23.6) for deleting inside it while
 * full.
 *
 * Every mark is a mark, so the paragraph is one `XmlText`. A file using
 * {@link expectX7} mocks `@web/features/collab-editor/space-delete-executor`
 * with a pass-through spy on `planSpaceDelete`, and `@web/lib/toast`.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { expect, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';
import { planSpaceDelete } from '@web/features/collab-editor/space-delete-executor';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { COMMENT_MARK, asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import {
  DOCUMENT_NAME,
  backspaceChar,
  capture,
  clearToasts,
  enterState,
  expectBodyInStep,
  expectNoTextMappings,
  expectTiptapInStep,
  expectWarnings,
  flush,
  mountBody,
  nodesOf,
  press,
  select,
  topBlockIds,
  type OpenBody,
  type OpenTiptap,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

export const LINK = 'https://example.test';

/** A mark a run carries. */
export type MarkName = 'bold' | 'italic' | 'link' | 'comment';

/** One run of the paragraph. */
export interface Run {
  readonly text: string;
  readonly marks?: readonly MarkName[];
}

/** The paragraph `P6` of spec 21.3. */
export const P6: readonly Run[] = [
  { text: 'plain text ' },
  { text: 'boldword', marks: ['bold'] },
  { text: ' middle ' },
  { text: 'italword', marks: ['italic'] },
  { text: 'linkword', marks: ['link'] },
  { text: ' tail ' },
  { text: 'commented', marks: ['comment'] },
  { text: ' end' },
];

/** `P6` as plain text; offsets index into it. */
export const P6_TEXT = 'plain text boldword middle italwordlinkword tail commented end';

/**
 * The offset of a needle in `P6_TEXT`, plus characters into it.
 * @param needle - Text.
 * @param into - Characters into the needle.
 * @returns The offset.
 */
export function at(needle: string, into = 0): number {
  const found = P6_TEXT.indexOf(needle);
  expect(found).toBeGreaterThanOrEqual(0);
  return found + into;
}

/**
 * One run as BlockNote inline content.
 * @param run - The run.
 * @returns The inline content.
 */
function inline(run: Run): Record<string, unknown> {
  const styles = {
    ...(run.marks?.includes('bold') === true && { bold: true }),
    ...(run.marks?.includes('italic') === true && { italic: true }),
  };
  const text = { type: 'text', text: run.text, styles };
  return run.marks?.includes('link') === true ? { type: 'link', href: LINK, content: [text] } : text;
}

/** The open body with the paragraph and the thread its comment marks point at. */
export interface MarkedBody {
  readonly body: OpenBody;
  /** The thread the comment runs carry, or null when none does. */
  readonly threadId: string | null;
}

/**
 * The first position inside the first paragraph.
 * @param doc - The document.
 * @returns The position.
 */
export function textStart(doc: PMNode): number {
  return nodesOf(doc, 'paragraph')[0] + 1;
}

/**
 * Opens the body with one paragraph of runs, loaded as a remote update: the
 * thread is created first (a thread the store owns), then a peer writes the
 * paragraph and marks every comment run with it.
 * @param runs - The runs.
 * @returns The open body and the thread's id.
 */
export async function openMarked(runs: readonly Run[]): Promise<MarkedBody> {
  const mounted = mountBody();
  let threadId: string | null = null;
  if (runs.some((run) => run.marks?.includes('comment') === true)) {
    const store = commentsOn(mounted.editor)!.threadStore as unknown as {
      createThread: (options: { initialComment: { body: never } }) => Promise<{ id: string }>;
    };
    threadId = (await store.createThread({ initialComment: { body: asCommentBody('t1') as never } })).id;
  }
  const source = new Y.Doc();
  Y.applyUpdate(source, Y.encodeStateAsUpdate(mounted.doc));
  const peer = buildDocumentEditor({ fragment: documentBodyFragment(source) });
  peer.mount(document.createElement('div'));
  peer.replaceBlocks(peer.document, [{ type: 'paragraph', content: runs.map(inline) }] as never);
  const peerView = peer.prosemirrorView;
  let offset = 0;
  for (const run of runs) {
    if (threadId !== null && run.marks?.includes('comment') === true) {
      const from = textStart(peerView.state.doc) + offset;
      const mark = peerView.state.schema.marks[COMMENT_MARK].create({ threadId, orphan: false });
      peerView.dispatch(peerView.state.tr.addMark(from, from + run.text.length, mark));
    }
    offset += run.text.length;
  }
  Y.applyUpdate(mounted.doc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(mounted.doc)), 'remote');
  peer.unmount();
  source.destroy();
  mounted.view.dom.focus();
  expectNoTextMappings(mounted.view, mounted.syncKey);
  const body = { ...mounted, ids: topBlockIds(mounted.editor) };
  expect(body.view.state.doc.textContent).toBe(runs.map((run) => run.text).join(''));
  return { body, threadId };
}

/**
 * Each character of the first paragraph with the marks it carries, as text.
 * @param doc - The document.
 * @returns One entry per character: the character and its sorted marks with their attributes.
 */
export function charMarks(doc: PMNode): string[] {
  const out: string[] = [];
  const paragraph = doc.nodeAt(nodesOf(doc, 'paragraph')[0])!;
  paragraph.forEach((child) => {
    const marks = child.marks.map((mark) => `${mark.type.name}${JSON.stringify(mark.attrs)}`).sort().join('|');
    for (const char of child.text ?? '') out.push(`${char}<${marks}>`);
  });
  return out;
}

/** How a case deletes `[from, to)` of the first paragraph. */
export type How = 'backspace' | 'range' | 'delete';

/**
 * Deletes `[from, to)` of the first paragraph the way the case says.
 * @param view - The view.
 * @param from - Start offset.
 * @param to - End offset.
 * @param how - A Backspace after the character, a selection and Backspace, or Delete before the character.
 */
export function deleteOffsets(view: EditorView, from: number, to: number, how: How): void {
  const a = textStart(view.state.doc) + from;
  const b = textStart(view.state.doc) + to;
  if (how === 'range') {
    select(view, a, b);
    press(view, 'Backspace');
    return;
  }
  if (how === 'backspace') {
    select(view, b);
    backspaceChar(view);
    return;
  }
  select(view, a);
  if (press(view, 'Delete')) return;
  view.dispatch(view.state.tr.delete(a, a + 1));
}

/** An editor template `X7` runs on. */
export interface X7Subject {
  readonly view: EditorView;
  readonly doc: Y.Doc;
  readonly name: string;
  readonly inStep: () => void;
  readonly undo: () => void;
}

/**
 * The document body as an `X7` subject.
 * @param body - The open body.
 * @returns The subject.
 */
export function bodySubject(body: OpenBody): X7Subject {
  return {
    view: body.view,
    doc: body.doc,
    name: DOCUMENT_NAME,
    inStep: () => { expectBodyInStep(body); },
    undo: () => { body.editor.undo(); },
  };
}

/**
 * A canvas TipTap editor as an `X7` subject.
 * @param open - The open editor.
 * @param name - The canvas document's name.
 * @returns The subject.
 */
export function tiptapSubject(open: OpenTiptap, name: string): X7Subject {
  return {
    view: open.view,
    doc: open.doc,
    name,
    inStep: () => { expectTiptapInStep(open); },
    undo: () => { open.editor.commands.undo(); },
  };
}

/**
 * Template `X7` (spec 23.6), in `F`: deleting `[from, to)` of the first
 * paragraph plans once and writes one pure delete (`R` when the paragraph's
 * text goes whole); every character left keeps its marks; the editor matches
 * Yjs; no toast; after `P_WARNING` one undo brings the paragraph back.
 * @param subject - The editor, already in `F`.
 * @param from - Start offset.
 * @param to - End offset.
 * @param how - How it is deleted.
 * @returns Resolves once the undo has been checked.
 */
export async function expectX7(subject: X7Subject, from: number, to: number, how: How): Promise<void> {
  const { view } = subject;
  vi.mocked(planSpaceDelete).mockClear();
  clearToasts();
  const before = charMarks(view.state.doc);
  const cap = capture(subject.doc);
  deleteOffsets(view, from, to, how);
  await flush();
  cap.stop();
  expect(vi.mocked(planSpaceDelete)).toHaveBeenCalledTimes(1);
  expect(cap.updates).toHaveLength(1);
  expect(cap.shape()).toBe(to - from === before.length ? 'R' : 'D');
  expect(charMarks(view.state.doc)).toEqual([...before.slice(0, from), ...before.slice(to)]);
  subject.inStep();
  expectWarnings();
  enterState(subject.name, 'W');
  subject.undo();
  await flush();
  expect(charMarks(view.state.doc)).toEqual(before);
  subject.inStep();
}
