// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 7 (inner#1790 web spec 23.4, design 5.3,
 * X6): a peer renames a referenced image while a bystander has the
 * referencing prompt open. The push reaches the bystander before the rename
 * (collab spec R7-33, R7-34), so while the Space is full, over its ceiling
 * or resyncing, the bystander's chip projection (`syncChipDisplay` through
 * `dispatchMachineEdit`) is refused by the filter without a toast and sends
 * nothing; once the phase leaves those states the real `PromptEditor`
 * projects again and the chip shows the new name.
 *
 * The bystander runs on a handshaken provider (`H7`); the rename arrives as
 * an Update frame from the scripted server.
 */

import { act, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const h7 = await vi.hoisted(async () => {
  const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
  m.installScriptedWebSocket();
  return m;
});

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/api/assets', () => ({
  assetsApi: { reportDeleted: vi.fn(() => Promise.resolve()), fetchUploadConfig: vi.fn(() => Promise.reject(new Error('offline'))) },
}));
// Radix Tooltip needs the app-level provider; not under test here.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from '@breatic/shared';
import {
  CANVAS, IMAGE_URL, LivePrompt, PID, SID, nodeOf, poolOf,
} from '@web/data/yjs/__tests__/helpers/one-action-suite';
import { P_FULL, P_NORMAL, P_OVER, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { addEdge, addNode, getPromptFragment, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes, readDocSize, setDocSize, startDocResync } from '@web/data/yjs/doc-size';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  CANVAS_NAME, CHIP_A, COPY, chipParagraph, clearToasts, enterState, expectWarnings, nodesOf, openTiptap, resetHarness,
  type SizeCode,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';
import { REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { dispatchMachineEdit } from '@web/features/reference-mention/reference-mention-local-input';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { toast } from '@web/lib/toast';
import type { PromptEditorHandle } from '@web/spaces/canvas/generate/PromptEditor';
import { MENTION_LABEL_ATTR } from '@web/spaces/canvas/generate/reference-mention';

const { expectHandshake, resetServer, settle } = h7;
type ScriptedServer = InstanceType<typeof h7.ScriptedServer>;

let server: ScriptedServer;

/** The bystander: the canvas on `H7` and the prompt of `v` open with a chip of `e`. */
interface Bystander {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  editor: () => Editor;
  unmount: () => void;
}

/**
 * The TipTap editor a rendered `PromptEditor` holds.
 * @param container - The rendered container.
 * @returns The editor.
 * @throws {Error} When no editor is mounted.
 */
function editorIn(container: HTMLElement): Editor {
  const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  if (dom?.editor === undefined) throw new Error('no editor');
  return dom.editor;
}

/**
 * Renders the prompt of `v` and puts a chip of every pool row in it.
 * @param fragment - The prompt fragment.
 * @returns The bystander's editor reader and unmount.
 * @throws {Error} When the editor does not mount.
 */
async function mountPrompt(fragment: Y.XmlFragment): Promise<Pick<Bystander, 'editor' | 'unmount'>> {
  const ref = React.createRef<PromptEditorHandle>();
  const view = render(<LivePrompt nodeId='v' fragment={fragment} editorRef={ref} />);
  await waitFor(() => { expect(ref.current).not.toBeNull(); });
  return { editor: () => editorIn(view.container), unmount: view.unmount };
}

/**
 * Opens the bystander: `e` (named `E`) referenced by `v`, a chip of `e` in
 * `v`'s prompt, all sent to the server; the Space normal.
 * @returns The bystander.
 * @throws {AssertionError} When a precondition does not hold.
 */
async function openBystander(): Promise<Bystander> {
  const doc = getDoc(CANVAS);
  await expectHandshake(CANVAS, doc, acquireDocProvider(CANVAS, doc) as never);
  addNode(PID, SID, nodeOf('e', 'image', { content: IMAGE_URL }));
  addNode(PID, SID, nodeOf('v', 'video'));
  addEdge(PID, SID, { id: 'e->v', source: 'e', target: 'v', createdAt: 1 });
  const fragment = getPromptFragment(PID, SID, 'v', 't2v');
  if (fragment === null) throw new Error('no prompt fragment');
  const ref = React.createRef<PromptEditorHandle>();
  const view = render(<LivePrompt nodeId='v' fragment={fragment} editorRef={ref} />);
  await waitFor(() => { expect(ref.current).not.toBeNull(); });
  act(() => { for (const row of poolOf('v')) ref.current!.insertReference(row); });
  server.push(CANVAS, P_NORMAL);
  await act(async () => { await settle(); });
  expect(chipLabels(editorIn(view.container).state.doc)).toEqual(['E']);
  return { doc, fragment, editor: () => editorIn(view.container), unmount: view.unmount };
}

/**
 * The labels of every chip in a prompt document.
 * @param doc - The prompt document.
 * @returns The labels.
 * @throws {never} Never.
 */
function chipLabels(doc: PMNode): Array<string | null> {
  const out: Array<string | null> = [];
  doc.descendants((node) => {
    if (node.type.name === REFERENCE_MENTION_NODE) out.push((node.attrs[MENTION_LABEL_ATTR] as string | null) ?? null);
    return true;
  });
  return out;
}

/**
 * Whether the bystander's editor and its fragment show the same document.
 * @param bystander - The bystander.
 * @returns `PM == Y`.
 * @throws {never} Never.
 */
function inStep(bystander: Bystander): boolean {
  const view = bystander.editor().view;
  return yXmlFragmentToProseMirrorRootNode(bystander.fragment, view.state.schema).eq(view.state.doc);
}

/**
 * A peer renames `e` to `E2`.
 * @throws {never} Never.
 */
function peerRenames(): void {
  server.peer(CANVAS, (peer) => {
    const data = (peer.getMap('nodesMap').get('e') as Y.Map<unknown>).get('data') as Y.Map<unknown>;
    data.set('name', 'E2');
  });
}

/**
 * The Update frames of the canvas since a mark.
 * @param mark - The first frame index.
 * @returns Their shapes.
 * @throws {never} Never.
 */
function updateShapes(mark: number): string[] {
  return server.updates(CANVAS, mark).map((u) => u.shape);
}

/**
 * The frame kinds of the canvas since a mark.
 * @param mark - The first frame index.
 * @returns The kinds.
 * @throws {never} Never.
 */
function kinds(mark: number): string[] {
  return server.kinds(CANVAS, mark).filter((kind) => kind !== 'other');
}

beforeEach(() => {
  changeLocale('en');
  server = resetServer();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  _resetCanvasUndoCacheForTests();
  _resetCollabSocketForTests();
  clearAllDocSizes();
  resetHarness();
  _resetForTests();
});

afterAll(() => {
  h7.uninstallScriptedWebSocket();
});

describe('23.4 a peer\'s rename while full: the bystander sends nothing, then projects once', () => {
  it.each([
    ['(a) warning', [P_WARNING]],
    ['(b) over the ceiling, then warning', [P_OVER, P_WARNING]],
  ] as const)('W7-16 %s: refused silently while full, the new name once the phase leaves full', async (_label, after) => {
    const bystander = await openBystander();
    const mark = server.mark();
    const s = server.push(CANVAS, P_FULL);
    peerRenames();
    await settle();
    const sinceSeen = kinds(mark);
    expect(sinceSeen).toContain(`seen(${s})`);
    expect(sinceSeen.slice(sinceSeen.indexOf(`seen(${s})`))).not.toContain('update');
    expect(toast.warning).not.toHaveBeenCalled();
    expect(readDocSize(CANVAS).phase).toBe('full');
    expect(inStep(bystander)).toBe(true);
    expect(chipLabels(bystander.editor().state.doc)).toEqual(['E']);
    for (const push of after) {
      const before = server.mark();
      server.push(CANVAS, push);
      await settle();
      if (push === P_OVER) {
        expect(updateShapes(before)).toEqual([]);
        expect(chipLabels(bystander.editor().state.doc)).toEqual(['E']);
        continue;
      }
      expect(updateShapes(before)).toEqual(['S']);
    }
    expect(chipLabels(bystander.editor().state.doc)).toEqual(['E2']);
    expect(inStep(bystander)).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('W7-16 (c) refused while full, then the document is rebuilt: once synced with P_NORMAL the new prompt shows the new name, one update', async () => {
    const bystander = await openBystander();
    const mark = server.mark();
    const s = server.push(CANVAS, P_FULL);
    peerRenames();
    await settle();
    const sinceSeen = kinds(mark);
    expect(sinceSeen).toContain(`seen(${s})`);
    expect(sinceSeen.slice(sinceSeen.indexOf(`seen(${s})`))).not.toContain('update');
    expect(chipLabels(bystander.editor().state.doc)).toEqual(['E']);
    server.closeDocument(CANVAS, COLLAB_DOCUMENT_TOO_LARGE_REASON);
    await settle();
    expect(readDocSize(CANVAS).phase).toBe('resyncing');
    bystander.unmount();
    const doc = getDoc(CANVAS);
    await expectHandshake(CANVAS, doc, acquireDocProvider(CANVAS, doc) as never, { confirms: false });
    server.push(CANVAS, P_NORMAL);
    expect(readDocSize(CANVAS).phase).toBe('normal');
    const fragment = getPromptFragment(PID, SID, 'v', 't2v');
    if (fragment === null) throw new Error('no prompt fragment');
    const before = server.mark();
    const remounted = await mountPrompt(fragment);
    await settle();
    expect(chipLabels(remounted.editor().state.doc)).toEqual(['E2']);
    expect(updateShapes(before)).toEqual(['S']);
  });

  it('W7-17 the rename first, then full: the projection is one S update before seen(s); warning afterwards sends nothing more', async () => {
    const bystander = await openBystander();
    const mark = server.mark();
    peerRenames();
    await settle();
    expect(updateShapes(mark)).toEqual(['S']);
    expect(chipLabels(bystander.editor().state.doc)).toEqual(['E2']);
    const s = server.push(CANVAS, P_FULL);
    const sequence = kinds(mark);
    expect(sequence.indexOf('update')).toBeLessThan(sequence.indexOf(`seen(${s})`));
    const after = server.mark();
    server.push(CANVAS, P_WARNING);
    await settle();
    expect(updateShapes(after)).toEqual([]);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('23.4 a machine edit is refused without a toast', () => {
  it.each([
    ['F', COPY.T_ADD],
    ['O', COPY.T_OVER],
    ['Z', null],
  ] as const)('W7-42 prompt in %s: dispatchMachineEdit of a chip label is refused with no toast; the user\'s own edit of it is told', async (code, told) => {
    const open = openTiptap('prompt', chipParagraph('ab ', CHIP_A, ' cd'));
    if (code === 'Z') {
      setDocSize(CANVAS_NAME, { type: 'doc:size', seq: 1, ...P_NORMAL });
      startDocResync(CANVAS_NAME);
    } else enterState(CANVAS_NAME, code as SizeCode);
    clearToasts();
    const before = open.view.state.doc;
    const at = nodesOf(before, REFERENCE_MENTION_NODE)[0]!;
    const updates: Uint8Array[] = [];
    /**
     * Keeps local updates.
     * @param update - The update.
     * @param _origin - Its origin.
     * @param _doc - The document.
     * @param tr - The transaction.
     */
    const onUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void => {
      if (tr.local) updates.push(update);
    };
    open.doc.on('update', onUpdate);
    dispatchMachineEdit(open.view, open.view.state.tr.setNodeAttribute(at, MENTION_LABEL_ATTR, 'Renamed'));
    await settle();
    expect(open.view.state.doc.eq(before)).toBe(true);
    expect(updates).toHaveLength(0);
    expectWarnings();
    open.view.dispatch(open.view.state.tr.setNodeAttribute(at, MENTION_LABEL_ATTR, 'Renamed'));
    await settle();
    open.doc.off('update', onUpdate);
    expect(open.view.state.doc.eq(before)).toBe(true);
    expect(updates).toHaveLength(0);
    if (told === null) expectWarnings();
    else expectWarnings(told);
  });
});
