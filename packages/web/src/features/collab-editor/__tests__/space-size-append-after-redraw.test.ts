// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 7 (inner#1790 web spec 23.5, design 5.3
 * "绑定重画后的追加事务", X5): what a plugin appends after a redraw whose root
 * carries the sync plugin's meta. The binding writes nothing while it
 * redraws, so the appended change is only in ProseMirror until something
 * writes it:
 *
 * - root from this client's own Yjs write (`writeProposalPrompt`, the
 *   executor's redraw): the filter writes the editor document in a microtask
 *   of the same task, in the same send window as the root; refused (full)
 *   it redraws from Yjs;
 * - root from a peer: the bystander writes nothing; `writeProposalPrompt`
 *   writes chip spaces itself, so a peer's editor appends nothing.
 *
 * Documents are opened on a handshaken provider (`H7`): peers' updates
 * arrive as Update frames from the scripted server, every frame the client
 * sends is recorded. Where an input does not append by itself, the editor
 * also carries a plugin that appends `!` after a sync-keyed root, only to
 * drive this mechanism. `PM == Y` is checked after the microtasks and before
 * any timer (spec 23.5).
 */

import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { yXmlFragmentToProseMirrorRootNode as tiptapRootNode } from '@tiptap/y-tiptap';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const h7 = await vi.hoisted(async () => {
  const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
  m.installScriptedWebSocket();
  return m;
});

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { documentBodyFragment, type PromptSegment } from '@breatic/shared';
import { P_FULL, P_NORMAL, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { readDocSize, setDocSize } from '@web/data/yjs/doc-size';
import {
  destroyH7Editors, microtasks, openBodyH7, openH7, openPrompt, peerPrompt, promptInStep, type OpenPrompt,
} from '@web/features/collab-editor/__tests__/helpers/h7-editors';
import { planWhitespaceInsertions } from '@web/features/reference-mention/reference-mention-whitespace';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { writeProposalPrompt, type MentionOf } from '@web/spaces/canvas/generate/proposal-prompt';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  CANVAS_NAME,
  CHIP_A,
  CHIP_B,
  DOCUMENT_NAME,
  capture,
  chipParagraph,
  clearToasts,
  deleteBetween,
  expectBodyInStep,
  expectWarnings,
  fragmentOf,
  mountBody,
  pBlock as p,
  paragraphs,
  posOf,
  resetHarness,
  select,
  tiptapExtensions,
  typeText,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';

const { resetServer, settle } = h7;
type ScriptedServer = InstanceType<typeof h7.ScriptedServer>;

let server: ScriptedServer;

/**
 * Every top-level block container element of a body fragment.
 * @param fragment - The body fragment.
 * @returns The containers.
 * @throws {never} Never.
 */
function containers(fragment: Y.XmlFragment): Y.XmlElement[] {
  const group = fragment.get(0);
  return group instanceof Y.XmlElement ? group.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement) : [];
}

/**
 * The ids of the body's top-level blocks in ProseMirror.
 * @param doc - The body document.
 * @returns The ids, null where none is set.
 * @throws {never} Never.
 */
function pmIds(doc: PMNode): Array<string | null> {
  const out: Array<string | null> = [];
  doc.firstChild?.forEach((child) => { out.push((child.attrs['id'] as string | null) ?? null); });
  return out;
}

/**
 * A selection-only change, as one click makes.
 * @param view - The view.
 * @param pos - Where the caret lands.
 * @throws {never} Never.
 */
function click(view: EditorView, pos: number): void {
  select(view, pos);
}

/**
 * The Update frames of a document since a mark.
 * @param name - Canonical document name.
 * @param mark - The first frame index.
 * @returns The updates.
 * @throws {never} Never.
 */
function updatesSince(name: string, mark: number): Array<{ shape: 'S' | 'D' | 'R' }> {
  return server.updates(name, mark);
}

/** The prompt layouts spec W7-43 writes. */
const LAYOUTS: ReadonlyArray<{ label: string; segments: PromptSegment[] }> = [
  { label: 'a chip at the start of a line', segments: [{ ref: 0 }, { text: 'a cat' }] },
  { label: 'a chip at the end of a line', segments: [{ text: 'a cat' }, { ref: 0 }] },
  { label: 'two neighbouring chips', segments: [{ text: 'x' }, { ref: 0 }, { ref: 1 }, { text: 'y' }] },
  { label: 'a chip touching words', segments: [{ text: 'x' }, { ref: 0 }, { text: 'y' }] },
  { label: 'a chip with spaces already on both sides', segments: [{ text: 'x ' }, { ref: 0 }, { text: ' y' }] },
  { label: 'a line holding only a chip', segments: [{ ref: 0 }] },
  { label: 'a note and words', segments: [{ slot: { kind: 'note', label: 'Pick a style' } }, { text: 'shot of' }, { ref: 0 }] },
];

/** What each ref of the layouts mentions. */
const MENTION_OF: MentionOf = (index) => [
  { sourceNodeId: CHIP_A.sourceNodeId, label: CHIP_A.sourceNodeName, kind: 'image' as const },
  { sourceNodeId: CHIP_B.sourceNodeId, label: CHIP_B.sourceNodeName, kind: 'image' as const },
][index];

beforeEach(() => {
  changeLocale('en');
  clearToasts();
  server = resetServer();
});

afterEach(() => {
  destroyH7Editors();
  _resetCollabSocketForTests();
  resetHarness();
});

afterAll(() => {
  h7.uninstallScriptedWebSocket();
});

describe('23.5 a peer\'s write that a plugin appends to is not written by the bystander', () => {
  it('W7-19 a peer\'s block without an id: the bystander writes nothing, then one typed x is one S update and PM == Y', async () => {
    const body = await openBodyH7([p('first')]);
    server.push(DOCUMENT_NAME, P_NORMAL);
    const mark = server.mark();
    const cap = capture(body.doc);
    server.peer(DOCUMENT_NAME, (peer) => {
      const editor = buildDocumentEditor({ fragment: documentBodyFragment(peer) });
      editor.mount(document.createElement('div'));
      editor.insertBlocks([{ type: 'paragraph', content: 'peer' }] as never, editor.document.at(-1)!, 'after');
      editor.unmount();
      containers(documentBodyFragment(peer)).at(-1)!.removeAttribute('id');
    });
    await microtasks();
    // The id is only in ProseMirror: UniqueID appended it after the redraw.
    expect(containers(body.fragment).at(-1)!.getAttribute('id')).toBeUndefined();
    expect(pmIds(body.view.state.doc).at(-1)).not.toBeNull();
    expect(cap.updates).toHaveLength(0);
    await settle();
    expect(cap.updates).toHaveLength(0);
    expect(updatesSince(DOCUMENT_NAME, mark)).toEqual([]);
    expectWarnings();
    const typed = server.mark();
    select(body.view, posOf(body.view.state.doc, 'first', 5));
    typeText(body.view, 'x');
    await settle();
    const sent = updatesSince(DOCUMENT_NAME, typed);
    expect(sent.map((u) => u.shape)).toEqual(['S']);
    expect(documentBodyFragment(server.docOf(DOCUMENT_NAME)).toString()).toContain('firstx');
    expectBodyInStep(body);
  });

  it('W7-20 a peer\'s chip at the end of a line with no space after it: the bystander writes nothing', async () => {
    const open = await openPrompt();
    server.push(CANVAS_NAME, P_NORMAL);
    const mark = server.mark();
    const cap = capture(open.doc);
    server.peer(CANVAS_NAME, (peer) => {
      peerPrompt(peer, chipParagraph('hello ', CHIP_A, ' world'));
      const paragraph = fragmentOf(peer, 'prompt').toArray().find((c) => c instanceof Y.XmlElement && c.nodeName === 'paragraph') as Y.XmlElement;
      const last = paragraph.toArray().at(-1);
      if (last instanceof Y.XmlText) paragraph.delete(paragraph.length - 1, 1);
    });
    await microtasks();
    // The whitespace plugin appended the space in ProseMirror only.
    expect(promptInStep(open)).toBe(false);
    await settle();
    expect(cap.updates).toHaveLength(0);
    expect(updatesSince(CANVAS_NAME, mark)).toEqual([]);
    expectWarnings();
  });
});

describe('23.5 writeProposalPrompt writes chip spaces itself', () => {
  it.each(LAYOUTS.map((layout) => [layout.label, layout] as const))('W7-43 %s: the written prompt needs no whitespace insertion', (_label, { segments }) => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('prompt');
    writeProposalPrompt(fragment, segments, MENTION_OF);
    const schema = getSchema(tiptapExtensions('prompt', new Y.Doc().getXmlFragment('x')));
    const written = tiptapRootNode(fragment, schema);
    expect(planWhitespaceInsertions(written)).toEqual([]);
    if (segments.some((s) => s.text === 'x ')) {
      const texts: string[] = [];
      written.descendants((node) => {
        if (node.isText) texts.push(node.text ?? '');
        return true;
      });
      expect(texts).toEqual(['x ', ' y']);
    }
  });

  it.each(LAYOUTS.map((layout) => [layout.label, layout] as const))('W7-44 %s, landed by a peer: the bystander\'s editor appends nothing', async (_label, { segments }) => {
    const open = await openPrompt({ content: paragraphs('old prompt') });
    server.push(CANVAS_NAME, P_NORMAL);
    const mark = server.mark();
    const cap = capture(open.doc);
    server.peer(CANVAS_NAME, (peer) => { writeProposalPrompt(fragmentOf(peer, 'prompt'), segments, MENTION_OF); });
    await microtasks();
    expect(promptInStep(open)).toBe(true);
    await settle();
    expect(cap.updates).toHaveLength(0);
    expect(updatesSince(CANVAS_NAME, mark)).toEqual([]);
    expect(promptInStep(open)).toBe(true);
  });
});

/**
 * Lands a proposal's prompt in the open editor's fragment, a local Yjs write.
 * @param open - The open editor.
 * @throws {never} Never.
 */
function landLocally(open: OpenPrompt): void {
  open.bang.arm();
  writeProposalPrompt(open.fragment, [{ text: 'a cat on' }, { ref: 0 }], MENTION_OF);
}

describe('23.5 this client\'s own Yjs write: what is appended joins it', () => {
  it.each([
    ['with the appending plugin', true],
    ['without it', false],
  ] as const)('W7-22 %s: after the microtasks PM == Y, and the landing leaves as one update', async (_label, bang) => {
    const open = await openPrompt({ bang, content: paragraphs('old prompt') });
    server.push(CANVAS_NAME, P_NORMAL);
    const mark = server.mark();
    landLocally(open);
    await microtasks();
    expect(promptInStep(open)).toBe(true);
    await settle();
    const sent = updatesSince(CANVAS_NAME, mark);
    expect(sent).toHaveLength(1);
    const prompt = fragmentOf(server.docOf(CANVAS_NAME), 'prompt').toString();
    expect(prompt).toContain('a cat on');
    if (bang) expect(prompt).toContain('!');
    else expect(planWhitespaceInsertions(open.view.state.doc)).toEqual([]);
    expectWarnings();
  });

  it('W7-23 full between the write and its microtask: refused silently, redrawn from Yjs, the appended change gone', async () => {
    const open = await openPrompt({ bang: true, content: paragraphs('old prompt') });
    server.push(CANVAS_NAME, P_NORMAL);
    const cap = capture(open.doc);
    landLocally(open);
    const landed = cap.updates.length;
    setDocSize(CANVAS_NAME, { type: 'doc:size', seq: 1, ...P_FULL });
    await microtasks();
    expect(cap.updates).toHaveLength(landed);
    expect(open.fragment.toString()).not.toContain('!');
    expect(open.view.state.doc.textContent).not.toContain('!');
    expect(promptInStep(open)).toBe(true);
    expectWarnings();
  });

  it('W7-24 (a) full when a peer\'s block without an id arrives: nothing appended is kept, PM == Y, no toast', async () => {
    const body = await openBodyH7([p('first')]);
    server.push(DOCUMENT_NAME, P_FULL);
    const cap = capture(body.doc);
    server.peer(DOCUMENT_NAME, (peer) => {
      const editor = buildDocumentEditor({ fragment: documentBodyFragment(peer) });
      editor.mount(document.createElement('div'));
      editor.insertBlocks([{ type: 'paragraph', content: 'peer' }] as never, editor.document.at(-1)!, 'after');
      editor.unmount();
      containers(documentBodyFragment(peer)).at(-1)!.removeAttribute('id');
    });
    await microtasks();
    expect(cap.updates).toHaveLength(0);
    expectBodyInStep(body);
    expectWarnings();
  });

  it('W7-24 (a) full when a peer\'s chip with no space after it arrives: PM == Y, no toast', async () => {
    const open = await openPrompt();
    server.push(CANVAS_NAME, P_FULL);
    const cap = capture(open.doc);
    server.peer(CANVAS_NAME, (peer) => {
      peerPrompt(peer, chipParagraph('hello ', CHIP_A, ' world'));
      const paragraph = fragmentOf(peer, 'prompt').toArray().find((c) => c instanceof Y.XmlElement && c.nodeName === 'paragraph') as Y.XmlElement;
      if (paragraph.toArray().at(-1) instanceof Y.XmlText) paragraph.delete(paragraph.length - 1, 1);
    });
    await microtasks();
    expect(cap.updates).toHaveLength(0);
    expect(promptInStep(open)).toBe(true);
    expectWarnings();
  });

  it('W7-24 (b) full, the redraw after an executor write (X-07) with the appending plugin: the appended change is dropped, PM == Y, no toast', async () => {
    const body = await openBodyH7([p('Hello'), p('World')], { bang: true });
    server.push(DOCUMENT_NAME, P_FULL);
    const cap = capture(body.doc);
    body.bang.arm();
    deleteBetween(body, ['Hello', 2], ['World', 2]);
    await microtasks();
    await settle();
    expect(cap.updates).toHaveLength(1);
    expect(cap.shape()).toBe('D');
    expect(body.view.state.doc.textContent).not.toContain('!');
    expectBodyInStep(body);
    expectWarnings();
  });
});

describe('23.5 a plain click afterwards writes nothing', () => {
  it.each([
    ['W7-22 with the appending plugin', 'w22-bang'],
    ['W7-22 without it', 'w22'],
    ['W7-23', 'w23'],
    ['W7-44', 'w44'],
  ] as const)('W7-25 after %s, full: two plain clicks write nothing and show no toast', async (_label, after) => {
    const open = await openPrompt({ bang: after !== 'w22' && after !== 'w44', content: paragraphs('old prompt') });
    server.push(CANVAS_NAME, P_NORMAL);
    if (after === 'w23') {
      landLocally(open);
      setDocSize(CANVAS_NAME, { type: 'doc:size', seq: 1, ...P_FULL });
      await microtasks();
    } else if (after === 'w44') {
      server.peer(CANVAS_NAME, (peer) => { writeProposalPrompt(fragmentOf(peer, 'prompt'), [{ text: 'x' }, { ref: 0 }], MENTION_OF); });
    } else landLocally(open);
    await settle();
    server.push(CANVAS_NAME, P_FULL);
    clearToasts();
    const mark = server.mark();
    const cap = capture(open.doc);
    click(open.view, 1);
    await settle();
    click(open.view, open.view.state.doc.content.size - 1);
    await settle();
    expect(cap.updates).toHaveLength(0);
    expect(updatesSince(CANVAS_NAME, mark)).toEqual([]);
    expectWarnings();
  });

  it('W7-25 after W7-24 (b), full: two plain clicks write nothing and show no toast', async () => {
    const body = await openBodyH7([p('Hello'), p('World')], { bang: true });
    server.push(DOCUMENT_NAME, P_FULL);
    body.bang.arm();
    deleteBetween(body, ['Hello', 2], ['World', 2]);
    await settle();
    clearToasts();
    const mark = server.mark();
    const cap = capture(body.doc);
    click(body.view, posOf(body.view.state.doc, 'He', 1));
    await settle();
    click(body.view, posOf(body.view.state.doc, 'rld', 2));
    await settle();
    expect(cap.updates).toHaveLength(0);
    expect(updatesSince(DOCUMENT_NAME, mark)).toEqual([]);
    expectWarnings();
  });

  it('W7-26 after W7-22, warning: a plain click writes nothing (the editor and Yjs already agree)', async () => {
    const open = await openPrompt({ bang: true, content: paragraphs('old prompt') });
    server.push(CANVAS_NAME, P_NORMAL);
    landLocally(open);
    await settle();
    server.push(CANVAS_NAME, P_WARNING);
    const mark = server.mark();
    const cap = capture(open.doc);
    click(open.view, 1);
    await settle();
    expect(cap.updates).toHaveLength(0);
    expect(updatesSince(CANVAS_NAME, mark)).toEqual([]);
  });
});

describe('23.5 an appended change written only once full is refused once', () => {
  it('W7-45 after W7-19, full and enforced by the server: at most one refusal and resync; afterwards PM == Y and clicks write nothing', async () => {
    let body = await openBodyH7([p('first')]);
    server.push(DOCUMENT_NAME, P_NORMAL);
    server.peer(DOCUMENT_NAME, (peer) => {
      const editor = buildDocumentEditor({ fragment: documentBodyFragment(peer) });
      editor.mount(document.createElement('div'));
      editor.insertBlocks([{ type: 'paragraph', content: 'peer' }] as never, editor.document.at(-1)!, 'after');
      editor.unmount();
      containers(documentBodyFragment(peer)).at(-1)!.removeAttribute('id');
    });
    await settle();
    server.enforceFull = true;
    server.push(DOCUMENT_NAME, P_FULL);
    await settle();
    click(body.view, posOf(body.view.state.doc, 'first', 1));
    await settle();
    click(body.view, posOf(body.view.state.doc, 'first', 3));
    await settle();
    expect(server.refusals).toBeLessThanOrEqual(1);
    if (readDocSize(DOCUMENT_NAME).phase === 'resyncing' || server.refusals === 1) {
      await openH7(DOCUMENT_NAME);
      server.push(DOCUMENT_NAME, P_FULL);
      body = { ...mountBody(), bang: body.bang };
      await settle();
    }
    expect(readDocSize(DOCUMENT_NAME).phase).toBe('full');
    expectBodyInStep(body);
    const refused = server.refusals;
    const mark = server.mark();
    click(body.view, posOf(body.view.state.doc, 'first', 1));
    await settle();
    click(body.view, posOf(body.view.state.doc, 'first', 4));
    await settle();
    expect(updatesSince(DOCUMENT_NAME, mark)).toEqual([]);
    expect(server.refusals).toBe(refused);
    expect(readDocSize(DOCUMENT_NAME).phase).toBe('full');
  });
});
