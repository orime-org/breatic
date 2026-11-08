// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 6 (inner#1790 web spec 21.1, design 5.6,
 * W9): one user operation leaves as exactly one Update message, so collab
 * never sees the first half of an operation cross the limit and refuses the
 * second half at `full`.
 *
 * Counting (spec 21.1 "数法"): the document's provider is the real
 * `HocuspocusProvider` that production `acquireDocProvider` builds, with the
 * configuration production gives it; only the shared WebSocket is a
 * recording stand-in (`helpers/message-socket.ts`). Each Update frame is
 * judged by shared `updateShape` against a mirror of the document taken when
 * the operation starts. The count runs from the operation until real timers
 * have been idle for well over 50 ms; nothing flushes React effects with
 * `act` during the count. The size state is `N` (`U` for MS-15, as the spec
 * row says).
 *
 * Template `M1`: exactly one Update message; applying it to the mirror gives
 * the document as it now is; its shape is the one the row names.
 */

import { act, render, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { EditorView } from '@tiptap/pm/view';
import { Awareness } from 'y-protocols/awareness';
import {
  AUDIO_GENERATION_MODES, encodeInitialSpaceContent, documentBodyFragment,
  type CanvasNodeFields, type DocumentProposal, type FocusImage, type NodeType,
} from '@breatic/shared';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/message-socket')).messageSocketModule(await importOriginal()));
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

import {
  countMessages, idle, recordingSockets, type MessageCount, type RecordingSocket,
} from '@web/data/yjs/__tests__/helpers/message-socket';
import { enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import {
  MAIN, ON, SOURCE, V2, cid, clip, seededDoc, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  addEdge, addNode, addNodeFocusImage, getLyricsFragment, getPromptFragment, readCanvasGraph,
  removeEdge, removeElements, setNodeName, useCanvasSpace, _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { enterStoryboardShots, readShots } from '@web/data/yjs/node-storyboard';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import { PromptEditor, type PromptEditorHandle } from '@web/spaces/canvas/generate/PromptEditor';
import { deriveReferences, focusToRailItem, type ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { removeReferenceRow } from '@web/spaces/canvas/generate/remove-reference-row';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import { commentOn } from '@web/spaces/document/document-comment-post';
import {
  removeReply, removeThread, reopenThread, replyToThread, resolveThread,
} from '@web/spaces/document/document-comment-thread-actions';
import {
  _resetDocumentEditorCacheForTests, adoptDocumentEditor, getDocumentEditor, type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { landProposal } from '@web/spaces/document/document-proposal-landing';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import {
  createUploadController, type UploadController, type UploadOutcome,
} from '@web/spaces/document/document-upload-controller';

const PID = 'p1';
const CANVAS = docName.canvasSpace(PID, 's1');
const DOCUMENT = docName.documentSpace(PID, 'd1');
const TIMELINE = docName.timelineSpace(PID, 't1');

/**
 * Opens a registered Space document with its production provider.
 * @param name - Canonical document name.
 * @returns The document and the shared recording socket.
 * @throws {Error} When no socket was built.
 */
function openDoc(name: string): { doc: Y.Doc; socket: RecordingSocket } {
  const doc = getDoc(name);
  acquireDocProvider(name, doc);
  const socket = recordingSockets.at(-1);
  if (socket === undefined) throw new Error('no socket');
  return { doc, socket };
}

/**
 * Runs one operation and counts what it sent once everything has settled.
 * @param socket - The socket.
 * @param name - Canonical document name.
 * @param doc - The document.
 * @param operation - The operation, started outside `act`.
 * @returns The count.
 * @throws {Error} Whatever the operation throws.
 */
async function countOperation(
  socket: RecordingSocket,
  name: string,
  doc: Y.Doc,
  operation: () => unknown,
): Promise<MessageCount> {
  await idle();
  const count = countMessages(socket, name, doc);
  await operation();
  await idle();
  return count;
}

/**
 * Asserts template `M1` with a shape.
 * @param count - The count.
 * @param shape - The expected shape of the one message.
 * @throws {Error} When it does not hold.
 */
function expectM1(count: MessageCount, shape: 'S' | 'D' | 'R'): void {
  const updates = count.updates();
  expect(updates.map((u) => u.update.byteLength)).toHaveLength(1);
  expect(updates[0]!.shape).toBe(shape);
  expect(count.mirrorMatches()).toBe(true);
}

beforeEach(() => {
  recordingSockets.length = 0;
});

afterEach(() => {
  evictTimelineEditSession(TIMELINE);
  _resetDocumentEditorCacheForTests();
  _resetCanvasUndoCacheForTests();
  _resetCollabSocketForTests();
  clearAllDocSizes();
  _resetForTests();
});

// ───────────────────────── document comments (MS-01 to MS-06) ─────────────────────────

/** A mounted document Space with "hello world" in its body. */
interface CommentBoard {
  doc: Y.Doc;
  socket: RecordingSocket;
  handle: DocumentEditorHandle;
  view: EditorView;
}

/**
 * Mounts the document editor on the registered document holding "hello world".
 * @returns The board.
 * @throws {Error} When the provider or editor cannot be built.
 */
async function commentBoard(): Promise<CommentBoard> {
  const { doc, socket } = openDoc(DOCUMENT);
  const handle = getDocumentEditor(doc, DOCUMENT, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'editor', viewerId: 'u1' }),
    editable: true,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  adoptDocumentEditor(handle, root);
  handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: 'hello world' }] as never);
  handle.undoManager.clear();
  enterSize(DOCUMENT, 'N');
  await idle();
  const view = (handle.editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;
  return { doc, socket, handle, view };
}

/**
 * The range of "hello" in the body.
 * @param view - The editor view.
 * @returns The range.
 * @throws {Error} When the word is not there.
 */
function helloRange(view: EditorView): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found === null && node.isText && node.text?.startsWith('hello')) found = { from: pos, to: pos + 5 };
    return found === null;
  });
  if (found === null) throw new Error('no "hello"');
  return found;
}

/**
 * Posts a comment on "hello".
 * @param board - The board.
 * @param body - The comment.
 * @returns The thread id and first comment id.
 * @throws {Error} When nothing was posted.
 */
async function postOnHello(board: CommentBoard, body = 'note'): Promise<{ threadId: string; commentId: string }> {
  const range = helloRange(board.view);
  const thread = await commentOn(board.handle.editor as never, asCommentBody(body), () => [range]);
  if (thread === null || !('comments' in thread)) throw new Error('no thread');
  return { threadId: thread.id, commentId: thread.comments[0]!.id };
}

describe('21.1 document comments send one message', () => {
  it('MS-01 posting a comment on "hello" is one message (S)', async () => {
    const board = await commentBoard();
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => postOnHello(board));
    expectM1(count, 'S');
  });

  it('MS-02 an Agent comment proposal landing is one message (S)', async () => {
    const board = await commentBoard();
    const block = board.handle.editor.document[0] as { id: string };
    const proposal: DocumentProposal = {
      proposalId: '33333333-3333-4333-8333-333333333333',
      spaceId: '44444444-4444-4444-8444-444444444444',
      spaceName: 'Script',
      kind: 'comment',
      blockId: block.id,
      quote: 'hello',
      body: 'Which hello?',
      title: 't',
      heading: '',
      original: 'hello world',
      blockType: 'paragraph',
      lossy: false,
    };
    let outcome: unknown = null;
    const count = await countOperation(board.socket, DOCUMENT, board.doc, async () => {
      outcome = await landProposal(board.handle, proposal, 'comment', () => ({ available: true, writeAccess: 'granted' }));
    });
    expect(outcome).toMatchObject({ outcome: 'applied', how: 'comment' });
    expectM1(count, 'S');
  });

  it('MS-03 resolving the thread is one message (S)', async () => {
    const board = await commentBoard();
    const { threadId } = await postOnHello(board);
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => resolveThread(board.handle.editor as never, threadId));
    expectM1(count, 'S');
  });

  it('MS-04 reopening the thread is one message (S)', async () => {
    const board = await commentBoard();
    const { threadId } = await postOnHello(board);
    await resolveThread(board.handle.editor as never, threadId);
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => reopenThread(board.handle.editor as never, threadId));
    expectM1(count, 'S');
  });

  it('MS-05 deleting the thread is one message (S: the mark rewrite is not a deletion)', async () => {
    const board = await commentBoard();
    const { threadId } = await postOnHello(board);
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => removeThread(board.handle.editor as never, threadId));
    expectM1(count, 'S');
  });

  it('MS-06 deleting the only comment of a thread (the library then deletes the thread) is one message (S)', async () => {
    const board = await commentBoard();
    const { threadId, commentId } = await postOnHello(board);
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => removeReply(board.handle.editor as never, threadId, commentId));
    expectM1(count, 'S');
  });
});

// ───────────────────────── document uploads (MS-07 to MS-10) ─────────────────────────

/** Ends one upload. */
type Settle = (outcome: UploadOutcome) => void;

/** A document body with an upload controller attached. */
interface UploadBoard {
  doc: Y.Doc;
  socket: RecordingSocket;
  editor: ReturnType<typeof buildDocumentEditor>;
  manager: Y.UndoManager;
  controller: UploadController;
  finish: (uploadId: string) => Promise<void>;
}

/**
 * Opens the registered document with one typed line and an upload controller.
 * @returns The board.
 * @throws {Error} When the provider cannot be built.
 */
async function uploadBoard(): Promise<UploadBoard> {
  const { doc, socket } = openDoc(DOCUMENT);
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'), 'remote');
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'Typed line' }] as never);
  manager.clear();
  const uploads = new Map<string, Settle>();
  const controller = createUploadController({
    run: (id) => new Promise<UploadOutcome>((resolve) => { uploads.set(id, resolve); }),
    register: vi.fn(),
    unregister: vi.fn(),
  });
  controller.attach({ spaceId: 'd1', doc, name: DOCUMENT, writeAccess: () => 'granted', onChange: () => () => undefined });
  enterSize(DOCUMENT, 'N');
  await idle();
  const finish = async (uploadId: string): Promise<void> => {
    uploads.get(uploadId)!({ ok: true, result: { url: 'https://cdn.example/z.png', mediaWidth: 1, mediaHeight: 1 } as never });
    await idle();
  };
  return { doc, socket, editor, manager, controller, finish };
}

/**
 * Pastes a pending image block (`uploadId` set, `url` empty) after the last block.
 * @param board - The board.
 * @param uploadId - The upload id.
 * @throws {never} Never.
 */
function pastePending(board: UploadBoard, uploadId: string): void {
  board.editor.insertBlocks(
    [{ type: 'image', props: { url: '', uploadId, name: 'H', caption: 'H' } }] as never,
    board.editor.document[board.editor.document.length - 1]!,
    'after',
  );
}

const ADDRESS = { kind: 'address', url: 'https://i.example/x.jpg' } as const;

describe('21.1 document upload completions send one message', () => {
  it('MS-07 redoing a pending block whose upload finished while undone is one message with its address (S)', async () => {
    const board = await uploadBoard();
    pastePending(board, 'u1');
    board.controller.start('u1', ADDRESS as never);
    board.manager.undo();
    await idle();
    await board.finish('u1');
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => { board.manager.redo(); });
    expectM1(count, 'S');
  });

  it('MS-08 undoing the delete of a block whose upload finished meanwhile is one message (S)', async () => {
    const board = await uploadBoard();
    pastePending(board, 'u1');
    board.manager.stopCapturing();
    board.controller.start('u1', ADDRESS as never);
    const image = (board.editor.document as Array<{ id: string; type: string }>).find((b) => b.type === 'image')!;
    board.editor.removeBlocks([image.id]);
    await idle();
    await board.finish('u1');
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => { board.manager.undo(); });
    expectM1(count, 'S');
  });

  it('MS-09 pasting a copy of a finished pending block (still carrying uploadId) is one message (S)', async () => {
    const board = await uploadBoard();
    pastePending(board, 'u1');
    board.controller.start('u1', ADDRESS as never);
    await board.finish('u1');
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => pastePending(board, 'u1'));
    expectM1(count, 'S');
  });

  it('MS-10 undoing the move of a block whose upload finished meanwhile is one message (S)', async () => {
    const board = await uploadBoard();
    pastePending(board, 'u1');
    board.manager.stopCapturing();
    board.controller.start('u1', ADDRESS as never);
    const view = board.editor.prosemirrorView!;
    let from = -1;
    let size = 0;
    view.state.doc.descendants((node, pos) => {
      if (from < 0 && node.type.name === 'blockContainer' && node.firstChild?.type.name === 'image') {
        from = pos;
        size = node.nodeSize;
      }
      return from < 0;
    });
    const moved = view.state.doc.slice(from, from + size).content;
    const tr = view.state.tr.delete(from, from + size);
    tr.insert(1, moved);
    view.dispatch(tr);
    await board.finish('u1');
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => { board.manager.undo(); });
    expectM1(count, 'S');
  });
});

// ───────────────────────── timeline (MS-11 to MS-15) ─────────────────────────

const S1 = { ...SOURCE, id: '10000000-0000-4000-8000-000000000001', assetId: '20000000-0000-4000-8000-000000000001' };
const S2 = { ...SOURCE, id: '10000000-0000-4000-8000-000000000002', assetId: '20000000-0000-4000-8000-000000000002' };
const S3 = { ...SOURCE, id: '10000000-0000-4000-8000-000000000003', assetId: '20000000-0000-4000-8000-000000000003' };

const COMMANDS: Record<string, TimelineEditCommand> = {
  add_video: { operation: 'add_video', parameters: { source: S3, clip: clip(cid(9), MAIN, 200, 50, { sourceId: S3.id }) }, placement: ON } as TimelineEditCommand,
  move: { operation: 'move', parameters: { clipId: cid(2), startFrame: 300, trackId: V2 }, placement: ON } as TimelineEditCommand,
  set_range: { operation: 'set_range', parameters: { clipId: cid(2), startFrame: 100, sourceInFrame: 10, durationFrames: 50 }, placement: ON } as TimelineEditCommand,
  split: { operation: 'split', parameters: { clipId: cid(1), frame: 50, newClipId: cid(7) }, placement: ON } as TimelineEditCommand,
  duplicate: { operation: 'duplicate', parameters: { clipId: cid(1), newClipId: cid(8) }, placement: ON } as TimelineEditCommand,
  delete: { operation: 'delete', parameters: { clipId: cid(2) }, placement: ON } as TimelineEditCommand,
};

/**
 * Opens the timeline holding main-track clips c1 (0–100) and c2 (100–200).
 * @param plainC1 - Store c1 as a plain value instead of a map.
 * @returns The document, socket and session.
 * @throws {Error} When the provider cannot be built.
 */
async function timelineBoard(plainC1 = false): Promise<{ doc: Y.Doc; socket: RecordingSocket; session: TimelineEditSession }> {
  const { doc, socket } = openDoc(TIMELINE);
  const layout = timeline(
    [clip(cid(1), MAIN, 0, 100, { sourceId: S1.id }), clip(cid(2), MAIN, 100, 100, { sourceId: S2.id })],
    [track(MAIN, 0), track(V2, 1)],
    [S1, S2],
  );
  const source = seededDoc(layout);
  if (plainC1) source.transact(() => { source.getMap('clips').set(cid(1), layout.clips[cid(1)]); }, 'setup');
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source), 'remote');
  source.destroy();
  const session = getTimelineEditSession(doc, TIMELINE);
  session.setCanWrite(true);
  if (!plainC1) enterSize(TIMELINE, 'N');
  await idle();
  return { doc, socket, session };
}

describe('21.1 timeline history steps send one message', () => {
  it('MS-11 undoing the delete of c2 (undo plus repairAfterPop) is one message (S)', async () => {
    const { doc, socket, session } = await timelineBoard();
    expect(session.edit(COMMANDS.delete!).ok).toBe(true);
    const count = await countOperation(socket, TIMELINE, doc, () => session.undo());
    expectM1(count, 'S');
  });

  it.each(['add_video', 'split', 'duplicate'])('MS-12 redoing %s after its undo is one message (S)', async (op) => {
    const { doc, socket, session } = await timelineBoard();
    expect(session.edit(COMMANDS[op]!).ok).toBe(true);
    session.undo();
    const count = await countOperation(socket, TIMELINE, doc, () => session.redo());
    expectM1(count, 'S');
  });

  it('MS-13 redoing the delete of c2 after its undo is one message (R)', async () => {
    const { doc, socket, session } = await timelineBoard();
    expect(session.edit(COMMANDS.delete!).ok).toBe(true);
    session.undo();
    const count = await countOperation(socket, TIMELINE, doc, () => session.redo());
    expectM1(count, 'R');
  });

  it.each(['add_video', 'split', 'duplicate', 'move', 'set_range', 'delete_track'])(
    'MS-14 control: undoing %s stays one message', async (op) => {
      const { doc, socket, session } = await timelineBoard();
      if (op === 'delete_track') {
        session.edit(COMMANDS.move!);
        session.edit(COMMANDS.delete!);
        expect(session.edit({ operation: 'delete_track', parameters: { trackId: V2 }, placement: ON } as TimelineEditCommand).ok).toBe(true);
      } else {
        expect(session.edit(COMMANDS[op]!).ok).toBe(true);
      }
      const count = await countOperation(socket, TIMELINE, doc, () => session.undo());
      expect(count.updates()).toHaveLength(1);
      expect(count.mirrorMatches()).toBe(true);
    },
  );

  it.each(['move', 'set_range', 'delete_track'])('MS-14 control: redoing %s stays one message', async (op) => {
    const { doc, socket, session } = await timelineBoard();
    if (op === 'delete_track') {
      session.edit(COMMANDS.move!);
      session.edit(COMMANDS.delete!);
      expect(session.edit({ operation: 'delete_track', parameters: { trackId: V2 }, placement: ON } as TimelineEditCommand).ok).toBe(true);
    } else {
      expect(session.edit(COMMANDS[op]!).ok).toBe(true);
    }
    session.undo();
    const count = await countOperation(socket, TIMELINE, doc, () => session.redo());
    expect(count.updates()).toHaveLength(1);
    expect(count.mirrorMatches()).toBe(true);
  });

  it('MS-15 (and TL-08 round 6) at U, moving c1 stored as a plain value converts and edits in one message (S)', async () => {
    const { doc, socket, session } = await timelineBoard(true);
    let ok = false;
    const count = await countOperation(socket, TIMELINE, doc, () => {
      ok = session.edit({ operation: 'move', parameters: { clipId: cid(1), startFrame: 250 }, placement: ON } as TimelineEditCommand).ok;
    });
    expect(ok).toBe(true);
    expect(doc.getMap('clips').get(cid(1))).toBeInstanceOf(Y.Map);
    expectM1(count, 'S');
  });
});

// ───────────────────────── canvas prompt editors (MS-16, MS-17) ─────────────────────────

const SID = 's1';
const IMAGE_URL = 'https://cdn.example/e.png';

/**
 * A canvas node with the fields every node carries.
 * @param id - Node id.
 * @param type - Node type.
 * @param extra - Extra data fields.
 * @returns The node.
 */
function nodeOf(id: string, type: NodeType, extra: Record<string, unknown> = {}): CanvasNodeFields {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id.toUpperCase(), createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], ...extra },
  } as CanvasNodeFields;
}

/**
 * The pool a generation panel shows for one node: its incoming references
 * (production `deriveReferences`) and its focus crops (`focusToRailItem`).
 * @param nodeId - The generative node.
 * @returns The pool, read from the live document.
 * @throws {never} Never.
 */
function poolOf(nodeId: string): ReferenceRailItem[] {
  const { nodes, edges } = readCanvasGraph(PID, SID);
  const crops = (nodes.find((n) => n.id === nodeId)?.data as { focusImages?: FocusImage[] } | undefined)?.focusImages ?? [];
  return [...deriveReferences(nodeId, nodes, edges, new Map()), ...crops.map(focusToRailItem)];
}

/**
 * A prompt editor whose pool follows the canvas document the way a panel's
 * does: re-read on every document update and handed down on the next render.
 * @param root0 - Props.
 * @param root0.nodeId - The node whose pool to show.
 * @param root0.fragment - The fragment the editor edits.
 * @param root0.editorRef - Receives the editor handle.
 * @returns The editor.
 */
function LivePrompt({ nodeId, fragment, editorRef }: {
  nodeId: string;
  fragment: Y.XmlFragment;
  editorRef: React.Ref<PromptEditorHandle>;
}): React.JSX.Element {
  const [references, setReferences] = React.useState<ReferenceRailItem[]>(() => poolOf(nodeId));
  React.useEffect(() => {
    const doc = getDoc(CANVAS);
    /** Re-reads the pool after a document update. */
    const reread = (): void => setReferences(poolOf(nodeId));
    doc.on('update', reread);
    return (): void => doc.off('update', reread);
  }, [nodeId]);
  const noop = React.useCallback((): void => undefined, []);
  return (
    <PromptEditor
      ref={editorRef}
      fragment={fragment}
      references={references}
      referenceKinds={['image']}
      placeholder='p'
      mentionEmptyLabel='none'
      onTextChange={noop}
      onAtMentionsChange={noop}
    />
  );
}

/** The canvas with an image `e` referenced by video `v` (and, for the three-editor run, audio `a`). */
interface PromptBoard {
  doc: Y.Doc;
  socket: RecordingSocket;
  fragments: Y.XmlFragment[];
}

const CROP: FocusImage = { id: 'c1', url: 'https://cdn.example/c1.png', name: 'E', width: 10, height: 10 };

/**
 * Builds the canvas, opens prompt editors holding a chip of `e` (and of the
 * crop when asked), then waits until everything settled.
 * @param editors - Which editors are open: the prompt only, or prompt, lyrics and current shot.
 * @param withCrop - Also put a focus crop on `v` and a chip of it in the prompt.
 * @returns The board.
 * @throws {Error} When a fragment is missing.
 */
async function promptBoard(editors: 'prompt' | 'three', withCrop = false): Promise<PromptBoard> {
  const { doc, socket } = openDoc(CANVAS);
  addNode(PID, SID, nodeOf('e', 'image', { content: IMAGE_URL }));
  addNode(PID, SID, nodeOf('v', 'video'));
  addEdge(PID, SID, { id: 'e->v', source: 'e', target: 'v', createdAt: 1 });
  const holders: Array<{ nodeId: string; fragment: Y.XmlFragment }> = [];
  const prompt = getPromptFragment(PID, SID, 'v', 't2v');
  if (prompt === null) throw new Error('no prompt fragment');
  holders.push({ nodeId: 'v', fragment: prompt });
  if (editors === 'three') {
    addNode(PID, SID, nodeOf('a', 'audio'));
    addEdge(PID, SID, { id: 'e->a', source: 'e', target: 'a', createdAt: 2 });
    const lyrics = getLyricsFragment(PID, SID, 'a', AUDIO_GENERATION_MODES[0]);
    if (lyrics === null) throw new Error('no lyrics fragment');
    holders.push({ nodeId: 'a', fragment: lyrics });
    enterStoryboardShots(PID, SID, 'v', 5);
    const shot = readShots(PID, SID, 'v')?.[0]?.prompt;
    if (shot === undefined) throw new Error('no shot');
    holders.push({ nodeId: 'v', fragment: shot });
  }
  if (withCrop) addNodeFocusImage(PID, SID, 'v', CROP);
  const refs = holders.map(() => React.createRef<PromptEditorHandle>());
  render(
    <>
      {holders.map((holder, i) => <LivePrompt key={i} nodeId={holder.nodeId} fragment={holder.fragment} editorRef={refs[i]!} />)}
    </>,
  );
  await waitFor(() => { for (const ref of refs) expect(ref.current).not.toBeNull(); });
  act(() => {
    holders.forEach((holder, i) => {
      for (const row of poolOf(holder.nodeId)) refs[i]!.current!.insertReference(row);
    });
  });
  enterSize(CANVAS, 'N');
  await act(async () => { await idle(); });
  return { doc, socket, fragments: holders.map((holder) => holder.fragment) };
}

/**
 * Whether a fragment still holds a chip of a source.
 * @param fragment - The prompt fragment.
 * @param sourceId - The source node id (or crop pool id).
 * @returns Whether a chip of it is there.
 */
function holdsChip(fragment: Y.XmlFragment, sourceId: string): boolean {
  return fragment.toString().includes(sourceId);
}

describe('21.1 canvas writes with prompt editors open send one message', () => {
  it('MS-16 renaming a referenced image with its prompt open: the rename and the chip label the editor rewrites leave as one message (S)', async () => {
    const board = await promptBoard('prompt');
    const count = await countOperation(board.socket, CANVAS, board.doc, () => setNodeName(PID, SID, 'e', 'E2'));
    // The editor did rewrite its chip: this case reaches the effect.
    expect(board.fragments[0]!.toString()).toContain('E2');
    expectM1(count, 'S');
  });

  it('MS-16 renaming with the prompt, lyrics and current shot editors all open is still one message (S)', async () => {
    const board = await promptBoard('three');
    const count = await countOperation(board.socket, CANVAS, board.doc, () => setNodeName(PID, SID, 'e', 'E2'));
    for (const fragment of board.fragments) expect(fragment.toString()).toContain('E2');
    expectM1(count, 'S');
  });

  it('MS-17 (a) the reference rail ✕ removes the edge and the chip in one message (R)', async () => {
    const board = await promptBoard('prompt');
    const row = poolOf('v').find((r) => r.refId === 'e->v')!;
    const count = await countOperation(board.socket, CANVAS, board.doc, () =>
      removeReferenceRow({ item: row, projectId: PID, spaceId: SID, nodeId: 'v' }));
    expect(holdsChip(board.fragments[0]!, '"e"')).toBe(false);
    expectM1(count, 'R');
  });

  it('MS-17 (b) the crop row ✕ removes the crop and its chip in one message (R)', async () => {
    const board = await promptBoard('prompt', true);
    const row = poolOf('v').find((r) => r.focus === true)!;
    expect(holdsChip(board.fragments[0]!, 'focus:c1')).toBe(true);
    const count = await countOperation(board.socket, CANVAS, board.doc, () =>
      removeReferenceRow({ item: row, projectId: PID, spaceId: SID, nodeId: 'v' }));
    expect(holdsChip(board.fragments[0]!, 'focus:c1')).toBe(false);
    expectM1(count, 'R');
  });

  it('MS-17 (c) the edge scissors (actions.deleteEdge, which calls removeEdge) remove the edge and the chip in one message (R)', async () => {
    const board = await promptBoard('prompt');
    const count = await countOperation(board.socket, CANVAS, board.doc, () => removeEdge(PID, SID, 'e->v'));
    expect(holdsChip(board.fragments[0]!, '"e"')).toBe(false);
    expectM1(count, 'R');
  });

  it('MS-17 (d) deleting the source node removes it, its edge and the chip in one message (R)', async () => {
    const board = await promptBoard('prompt');
    const count = await countOperation(board.socket, CANVAS, board.doc, () => removeElements(PID, SID, ['e'], ['e->v']));
    expect(holdsChip(board.fragments[0]!, '"e"')).toBe(false);
    expectM1(count, 'R');
  });

  it('MS-17 (e) undoing "add reference" on the canvas removes the edge and the chip in one message (R)', async () => {
    const { doc, socket } = openDoc(CANVAS);
    addNode(PID, SID, nodeOf('e', 'image', { content: IMAGE_URL }));
    addNode(PID, SID, nodeOf('v', 'video'));
    const canvas = renderHook(() => useCanvasSpace(PID, SID));
    await act(async () => { await idle(); });
    addEdge(PID, SID, { id: 'e->v', source: 'e', target: 'v', createdAt: 1 });
    const prompt = getPromptFragment(PID, SID, 'v', 't2v')!;
    const ref = React.createRef<PromptEditorHandle>();
    render(<LivePrompt nodeId='v' fragment={prompt} editorRef={ref} />);
    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => { for (const row of poolOf('v')) ref.current!.insertReference(row); });
    enterSize(CANVAS, 'N');
    await act(async () => { await idle(); });
    expect(holdsChip(prompt, '"e"')).toBe(true);
    const count = await countOperation(socket, CANVAS, doc, () => canvas.result.current.undo());
    expect(doc.getMap('edgesMap').has('e->v')).toBe(false);
    expect(holdsChip(prompt, '"e"')).toBe(false);
    expectM1(count, 'R');
  });
});

// ───────────────────────── controls (MS-19) ─────────────────────────

describe('21.1 controls that were already one message stay one', () => {
  it('MS-19 control: typing once in the document body is one message', async () => {
    const board = await commentBoard();
    const at = helloRange(board.view).to;
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => board.view.dispatch(board.view.state.tr.insertText('!', at)));
    expect(count.updates()).toHaveLength(1);
  });

  it('MS-19 control: Enter in the document body is one message', async () => {
    const board = await commentBoard();
    const at = helloRange(board.view).to;
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => board.view.dispatch(board.view.state.tr.split(at, 2)));
    expect(count.updates()).toHaveLength(1);
  });

  it('MS-19 control: replying to a comment is one message', async () => {
    const board = await commentBoard();
    const { threadId } = await postOnHello(board);
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => replyToThread(board.handle.editor as never, threadId, 'reply'));
    expect(count.updates()).toHaveLength(1);
  });

  it('MS-19 control: deleting a reply that is not the last one is one message', async () => {
    const board = await commentBoard();
    const { threadId, commentId } = await postOnHello(board);
    await replyToThread(board.handle.editor as never, threadId, 'reply');
    expect(commentsOn(board.handle.editor as never)!.threadStore.getThreads().get(threadId)!.comments).toHaveLength(2);
    const count = await countOperation(board.socket, DOCUMENT, board.doc, () => removeReply(board.handle.editor as never, threadId, commentId));
    expect(count.updates()).toHaveLength(1);
  });

  it('MS-19 control: canvas addNode, addEdge and a rename with no prompt open are one message each', async () => {
    const { doc, socket } = openDoc(CANVAS);
    enterSize(CANVAS, 'N');
    for (const operation of [
      (): unknown => addNode(PID, SID, nodeOf('e', 'image', { content: IMAGE_URL })),
      (): unknown => addNode(PID, SID, nodeOf('v', 'video')),
      (): unknown => addEdge(PID, SID, { id: 'e->v', source: 'e', target: 'v', createdAt: 1 }),
      (): unknown => setNodeName(PID, SID, 'e', 'E2'),
    ]) {
      const count = await countOperation(socket, CANVAS, doc, operation);
      expect(count.updates()).toHaveLength(1);
    }
  });
});
