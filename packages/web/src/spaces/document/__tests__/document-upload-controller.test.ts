// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The page's upload controller writes a finished upload's address onto every
 * pending block carrying its id (inner#1351 + inner#1390 design §5.5, §5.6).
 *
 * Built on the real stack: a mounted editor bound to a Y.Doc through
 * y-prosemirror, the document's own UndoManager, and a second Y.Doc synced to
 * the first standing in for a collaborator. Every case checks the local
 * ProseMirror view and both Y.Docs, because a write that lands in Yjs but not
 * in the view (or the other way round) is exactly what goes wrong when the
 * write runs inside the sync binding.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import type { WriteAccess } from '@web/data/yjs/collab-socket';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import {
  createUploadController,
  type AttachedBody,
  type UploadOutcome,
  type UploadController,
} from '@web/spaces/document/document-upload-controller';

type Editor = ReturnType<typeof buildDocumentEditor>;

const SPACE = 'space-a';
const URL_Z = 'https://cdn.example/z.png';

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).reverse().forEach((cleanup) => {
    cleanup();
  });
});

/** An upload the test settles by hand. */
interface Pending {
  resolve: (outcome: UploadOutcome) => void;
}

/** Everything one case works with. */
interface World {
  editor: Editor;
  manager: Y.UndoManager;
  doc: Y.Doc;
  peer: Y.Doc;
  controller: UploadController;
  uploads: Map<string, Pending>;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  access: { value: WriteAccess; listeners: Set<() => void> };
  body: AttachedBody;
  detach: () => void;
}

/**
 * Opens an editor holding one paragraph, a synced peer doc, and a controller
 * attached to the body.
 * @param attach - Whether to attach the body right away.
 * @returns The world.
 */
function open(attach = true): World {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const toPeer = (update: Uint8Array, origin: unknown): void => {
    if (origin !== 'from-peer') Y.applyUpdate(peer, update, 'from-doc');
  };
  const toDoc = (update: Uint8Array, origin: unknown): void => {
    if (origin !== 'from-doc') Y.applyUpdate(doc, update, 'from-peer');
  };
  doc.on('update', toPeer);
  peer.on('update', toDoc);

  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [extension] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'Typed line' }] as never);
  manager.clear();

  const uploads = new Map<string, Pending>();
  const register = vi.fn();
  const unregister = vi.fn();
  const controller = createUploadController({
    run: (uploadId) =>
      new Promise<UploadOutcome>((resolve) => {
        uploads.set(uploadId, { resolve });
      }),
    register,
    unregister,
  });
  const access = { value: 'granted' as WriteAccess, listeners: new Set<() => void>() };
  const body: AttachedBody = {
    spaceId: SPACE,
    doc,
    writeAccess: () => access.value,
    onChange: (listener) => {
      access.listeners.add(listener);
      return () => access.listeners.delete(listener);
    },
  };
  let detach = (): void => {};
  if (attach) detach = controller.attach(body);
  cleanups.push(() => {
    detach();
    editor.unmount();
    root.remove();
    doc.off('update', toPeer);
    peer.off('update', toDoc);
  });
  return { editor, manager, doc, peer, controller, uploads, register, unregister, access, body, detach };
}

/**
 * Lets the controller's microtask scans run.
 * @returns After every queued microtask and one macrotask.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Inserts a pending image block at the end of the body, in one local
 * ProseMirror transaction (as a paste does).
 * @param world - The world.
 * @param uploadId - The upload id.
 * @param caption - Its caption.
 */
function pastePending(world: World, uploadId: string, caption = 'Hero'): void {
  world.editor.insertBlocks(
    [{ type: 'image', props: { url: '', uploadId, name: caption, caption } }] as never,
    world.editor.document[world.editor.document.length - 1]!,
    'after',
  );
}

/**
 * Finishes an upload with an address and a size.
 * @param world - The world.
 * @param uploadId - The upload id.
 * @param url - The stored address.
 */
async function finish(world: World, uploadId: string, url = URL_Z): Promise<void> {
  world.uploads.get(uploadId)!.resolve({ ok: true, result: { url, mediaWidth: 640, mediaHeight: 480 } });
  await settle();
}

/** The attributes of one image as each side holds it. */
interface ImageView {
  url: string;
  uploadId: string;
  caption: string;
}

/**
 * The images in the local view.
 * @param world - The world.
 * @returns Their attributes, in order.
 */
function pmImages(world: World): ImageView[] {
  const out: ImageView[] = [];
  world.editor.prosemirrorView!.state.doc.descendants((node: PMNode) => {
    if (node.type.name === 'image') {
      out.push({ url: node.attrs['url'], uploadId: node.attrs['uploadId'], caption: node.attrs['caption'] });
    }
    return true;
  });
  return out;
}

/**
 * The images in a Y.Doc's body.
 * @param doc - The doc.
 * @returns Their attributes, in order.
 */
function yImages(doc: Y.Doc): ImageView[] {
  const out: ImageView[] = [];
  const walk = (el: Y.XmlElement | Y.XmlFragment): void => {
    el.toArray().forEach((child) => {
      if (!(child instanceof Y.XmlElement)) return;
      if (child.nodeName === 'image') {
        const a = child.getAttributes() as Record<string, unknown>;
        out.push({
          url: typeof a['url'] === 'string' ? a['url'] : '',
          uploadId: typeof a['uploadId'] === 'string' ? a['uploadId'] : '',
          caption: typeof a['caption'] === 'string' ? a['caption'] : '',
        });
      }
      walk(child);
    });
  };
  walk(documentBodyFragment(doc));
  return out;
}

/**
 * Asserts the view and both docs all hold these images.
 * @param world - The world.
 * @param expected - The images.
 */
function expectEverywhere(world: World, expected: ImageView[]): void {
  expect(pmImages(world)).toEqual(expected);
  expect(yImages(world.doc)).toEqual(expected);
  expect(yImages(world.peer)).toEqual(expected);
}

const WRITTEN = (caption = 'Hero'): ImageView => ({ url: URL_Z, uploadId: '', caption });
const PENDING = (uploadId: string, caption = 'Hero'): ImageView => ({ url: '', uploadId, caption });

/**
 * Undoes one step through the document's manager.
 * @param world - The world.
 */
function undo(world: World): void {
  world.manager.undo();
}

/**
 * Redoes one step through the document's manager.
 * @param world - The world.
 */
function redo(world: World): void {
  world.manager.redo();
}

describe('writing the address', () => {
  it('writes url and size onto the pending block, clears uploadId, and keeps name and caption', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    expectEverywhere(world, [WRITTEN()]);
    let size: unknown[] = [];
    world.editor.prosemirrorView!.state.doc.descendants((node: PMNode) => {
      if (node.type.name === 'image') size = [node.attrs['mediaWidth'], node.attrs['mediaHeight'], node.attrs['name']];
      return true;
    });
    expect(size).toEqual([640, 480, 'Hero']);
  });

  it('does not put the write on the undo stack, nor split the paste from the typing around it', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    expect(world.manager.undoStack).toHaveLength(1);
    undo(world);
    expectEverywhere(world, []);
    redo(world);
    expectEverywhere(world, [WRITTEN()]);
  });

  it('a write after the paste\'s undo step has closed is still not a step: one undo takes the whole block away', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.manager.stopCapturing();
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    expect(world.manager.undoStack).toHaveLength(1);
    undo(world);
    expectEverywhere(world, []);
    redo(world);
    await settle();
    expectEverywhere(world, [WRITTEN()]);
  });

  it('touches no block of another upload and no block that already has an address', async () => {
    const world = open();
    pastePending(world, 'u1');
    pastePending(world, 'u2', 'Other');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    world.controller.start('u2', { kind: 'address', url: 'https://imgs.example/y.jpg' });
    await finish(world, 'u1');
    expectEverywhere(world, [WRITTEN(), PENDING('u2', 'Other')]);
  });

  it('a pending block a collaborator\'s sync brings in is written too', async () => {
    const world = open();
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    world.peer.transact(() => {
      const container = new Y.XmlElement('blockContainer');
      container.setAttribute('id', 'from-peer');
      const image = new Y.XmlElement('image');
      image.setAttribute('url', '');
      image.setAttribute('uploadId', 'u1');
      image.setAttribute('caption', 'Hero');
      container.insert(0, [image]);
      const group = documentBodyFragment(world.peer).get(0) as Y.XmlElement;
      group.insert(group.length, [container]);
    }, 'peer-edit');
    await settle();
    expectEverywhere(world, [WRITTEN()]);
  });
});

describe('undo and redo around the upload (A6)', () => {
  it('undone while uploading, redone after it finished: the block comes back with its address', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    undo(world);
    expectEverywhere(world, []);
    await finish(world, 'u1');
    expectEverywhere(world, []);
    redo(world);
    await settle();
    expectEverywhere(world, [WRITTEN()]);
  });

  it('written, then the paste undone and redone: the block is an ordinary media block', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    undo(world);
    redo(world);
    await settle();
    expectEverywhere(world, [WRITTEN()]);
  });

  it('moved while uploading, written, then the move undone: the block brought back gets the address', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.manager.stopCapturing();
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    // A move is a delete and an insert (document-drag-move.ts).
    const view = world.editor.prosemirrorView!;
    let from = -1;
    let node: PMNode | null = null;
    view.state.doc.descendants((n: PMNode, pos: number) => {
      if (n.type.name === 'blockContainer' && n.firstChild?.type.name === 'image') {
        from = pos;
        node = n;
      }
      return from < 0;
    });
    const tr = view.state.tr.delete(from, from + node!.nodeSize);
    tr.insert(1, node!);
    view.dispatch(tr);
    await finish(world, 'u1');
    expectEverywhere(world, [WRITTEN()]);
    undo(world);
    await settle();
    expectEverywhere(world, [WRITTEN()]);
  });

  it('a caption changed while uploading stays, and undoing that change undoes only it', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.manager.stopCapturing();
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    const block = (world.editor.document as { id: string; type: string }[]).find((b) => b.type === 'image')!;
    world.editor.updateBlock(block.id, { props: { caption: 'Mine' } } as never);
    await finish(world, 'u1');
    expectEverywhere(world, [WRITTEN('Mine')]);
    undo(world);
    await settle();
    expectEverywhere(world, [WRITTEN('Hero')]);
  });

  it('cut while uploading and pasted again, plus a copy: every copy gets the address', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    pastePending(world, 'u1');
    await finish(world, 'u1');
    expectEverywhere(world, [WRITTEN(), WRITTEN()]);
  });

  it('a copy pasted after the upload finished is written at once', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    pastePending(world, 'u1');
    await settle();
    expectEverywhere(world, [WRITTEN(), WRITTEN()]);
  });

  it('typing before and after a write within the merge window stays one undo step', async () => {
    const world = open();
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    const view = world.editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.dispatch(view.state.tr.insertText('a'));
    pastePending(world, 'u1');
    await settle();
    view.dispatch(view.state.tr.insertText('b'));
    expect(world.manager.undoStack).toHaveLength(1);
  });
});

describe('write access', () => {
  it('without write access the result waits, and is written when access comes back', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    world.access.value = 'denied';
    await finish(world, 'u1');
    expectEverywhere(world, [PENDING('u1')]);
    expect(world.controller.entry('u1')?.phase).toBe('done');
    world.access.value = 'granted';
    world.access.listeners.forEach((listener) => {
      listener();
    });
    await settle();
    expectEverywhere(world, [WRITTEN()]);
  });
});

describe('attaching a body', () => {
  it('a body attached after the upload finished is scanned and written', async () => {
    const world = open(false);
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await finish(world, 'u1');
    expectEverywhere(world, [PENDING('u1')]);
    world.detach = world.controller.attach(world.body);
    await settle();
    expectEverywhere(world, [WRITTEN()]);
  });

  it('a detached body is no longer written', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    world.detach();
    await finish(world, 'u1');
    expectEverywhere(world, [PENDING('u1')]);
  });
});

describe('failure and retry', () => {
  it('a failure is kept with whether it can be retried, and a retry runs the same source again', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    world.uploads.get('u1')!.resolve({ ok: false, failure: { messageKey: 'canvas.upload.failed', params: {}, retryable: true } });
    await settle();
    expect(world.controller.entry('u1')).toMatchObject({ phase: 'failed', failure: { retryable: true } });
    world.controller.retry('u1');
    expect(world.controller.entry('u1')?.phase).toBe('uploading');
    await finish(world, 'u1');
    expectEverywhere(world, [WRITTEN()]);
  });
});

describe('the tab-close guard (A12)', () => {
  it('registers the Space once while an in-flight pending block sits in it, and lets go when it is gone or done', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await settle();
    expect(world.register.mock.calls).toEqual([[SPACE, 'u1']]);
    pastePending(world, 'u1');
    await settle();
    expect(world.register).toHaveBeenCalledTimes(1);
    undo(world);
    await settle();
    expect(world.unregister.mock.calls).toEqual([[SPACE, 'u1']]);
    redo(world);
    await settle();
    expect(world.register).toHaveBeenCalledTimes(2);
    await finish(world, 'u1');
    expect(world.unregister).toHaveBeenCalledTimes(2);
  });

  it('a body detached while uploading lets go of its Space', async () => {
    const world = open();
    pastePending(world, 'u1');
    world.controller.start('u1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    await settle();
    world.detach();
    expect(world.unregister.mock.calls).toEqual([[SPACE, 'u1']]);
  });
});
