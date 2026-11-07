// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second version (inner#1790 v2 web test spec,
 * section 9.1): document uploads and the size state.
 *
 * Inserting a pending block is an `add` the editor's filter refuses when the
 * Space is full, and an upload starts only when `canAdd` holds; writing a
 * finished upload's address is an `edit` through `writeSpaceDoc(notify:
 * false)`, skipped while the Space is full, over its ceiling or resyncing,
 * with the record kept `done` and the block waiting; leaving those phases
 * rescans every attached body and writes once. Retry and a pasted outside
 * link ask `canAdd` before any request.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), custom: vi.fn(), promise: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
const upload = vi.hoisted(() => ({ media: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadMedia: upload.media,
}));
vi.mock('@web/data/api/assets', () => ({
  assetsApi: {
    fetchUploadConfig: vi.fn().mockResolvedValue({ maxUploadBytes: 1_000_000, assetUrlPrefix: 'https://cdn.example/' }),
    cachedUploadConfig: vi.fn().mockReturnValue(null),
    ingestUrl: vi.fn(),
  },
}));
vi.mock('@web/data/api/canvas', () => ({ canvasApi: { paste: vi.fn() } }));
vi.mock('@web/data/upload/upload-status', () => ({ waitForUploadEnding: vi.fn() }));

import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api/assets';
import { canvasApi } from '@web/data/api/canvas';
import { waitForUploadEnding } from '@web/data/upload/upload-status';
import type { WriteAccess } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes, docSizeSynced, startDocResync } from '@web/data/yjs/doc-size';
import { destroyDoc, docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { openBodyUploads, type BodyConnection, type BodyUploads } from '@web/spaces/document/document-body-uploads';
import { _resetDocumentEditorCacheForTests, adoptDocumentEditor, getDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { openPageBodyUploads } from '@web/spaces/document/document-page-uploads';
import type { PressedBlock } from '@web/spaces/document/document-handle-commands';
import { insertMediaBelow } from '@web/spaces/document/document-insert-row';
import { DocumentMediaPicker, useDocumentMediaPick } from '@web/spaces/document/DocumentMediaPicker';
import { DocumentPendingMediaBlock, PendingUploadsContext } from '@web/spaces/document/document-pending-uploads';
import type { MediaBlockActions } from '@web/spaces/document/DocumentMediaBlock';
import {
  createUploadController,
  type UploadController,
  type UploadOutcome,
} from '@web/spaces/document/document-upload-controller';
import {
  captureWriteAsync,
  enterSize,
  expectKindShape,
  expectSizeToast,
  loadRemote,
  P_FULL,
  P_NORMAL,
  P_WARNING,
  pushSize,
  SIZE_COPY_EN,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p1';
const URL_Z = 'https://cdn.example/z.png';

let seq = 0;

/** The image attributes the body holds. */
interface ImageAttrs {
  url: string;
  uploadId: string;
}

/**
 * Builds a body holding one pending image block (`uploadId: 'up1'`, empty `url`).
 * @param source - The source document.
 * @param uploadId - The upload the block waits for.
 */
function pendingBody(source: Y.Doc, uploadId = 'up1'): void {
  const group = new Y.XmlElement('blockGroup');
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', `b-${uploadId}`);
  const image = new Y.XmlElement('image');
  image.setAttribute('url', '');
  image.setAttribute('uploadId', uploadId);
  image.setAttribute('name', 'shot.png');
  image.setAttribute('caption', '');
  container.insert(0, [image]);
  group.insert(0, [container]);
  documentBodyFragment(source).insert(0, [group]);
}

/**
 * The image blocks in a body.
 * @param doc - The document.
 * @returns Their url and upload id, in order.
 */
function images(doc: Y.Doc): ImageAttrs[] {
  const out: ImageAttrs[] = [];
  const walk = (parent: Y.XmlElement | Y.XmlFragment): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'image') {
        const a = child.getAttributes() as Record<string, unknown>;
        out.push({ url: String(a['url'] ?? ''), uploadId: String(a['uploadId'] ?? '') });
      }
      walk(child);
    }
  };
  walk(documentBodyFragment(doc));
  return out;
}

/** An upload the case settles by hand. */
interface Run {
  resolve: (outcome: UploadOutcome) => void;
}

/** One case's world: a registered body, the controller and its link. */
interface World {
  name: string;
  spaceId: string;
  doc: Y.Doc;
  controller: UploadController;
  runs: Run[];
  run: ReturnType<typeof vi.fn>;
  access: { value: WriteAccess; listeners: Set<() => void> };
  link: BodyUploads;
}

const links: BodyUploads[] = [];

/**
 * Opens a registered document body with one pending block loaded as a peer's
 * content, a controller whose runs the case settles, and the body attached.
 * @returns The world.
 */
function open(): World {
  const spaceId = `s${seq++}`;
  const name = docName.documentSpace(PID, spaceId);
  const doc = getDoc(name);
  loadRemote(doc, (source) => pendingBody(source));
  const runs: Run[] = [];
  const run = vi.fn(
    () =>
      new Promise<UploadOutcome>((resolve) => {
        runs.push({ resolve });
      }),
  );
  const controller = createUploadController({ run, register: vi.fn(), unregister: vi.fn() });
  const access = { value: 'granted' as WriteAccess, listeners: new Set<() => void>() };
  const link = attachBody(controller, spaceId, doc, access);
  return { name, spaceId, doc, controller, runs, run, access, link };
}

/**
 * Attaches one body to a controller, the way the page does.
 * @param controller - The controller.
 * @param spaceId - The Space.
 * @param doc - The body.
 * @param access - The write access the case steers.
 * @param access.value - Its value now.
 * @param access.listeners - Told when it changes.
 * @returns The link.
 */
function attachBody(
  controller: UploadController,
  spaceId: string,
  doc: Y.Doc,
  access: { value: WriteAccess; listeners: Set<() => void> },
): BodyUploads {
  const connection: BodyConnection = {
    writeAccess: () => access.value,
    refused: () => false,
    onChange: (listener) => {
      access.listeners.add(listener);
      return () => access.listeners.delete(listener);
    },
  };
  const link = openBodyUploads(controller, { spaceId, doc, connection });
  links.push(link);
  return link;
}

/**
 * Lets the controller's microtask scans run.
 * @returns After queued microtasks and one macrotask.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Finishes the newest run with the address.
 * @param world - The world.
 * @param index - Which run.
 */
async function finish(world: World, index = world.runs.length - 1): Promise<void> {
  world.runs[index].resolve({ ok: true, result: { url: URL_Z, mediaWidth: 640, mediaHeight: 480 } });
  await settle();
}

/**
 * Renders the pending block for `up1` over the link's store.
 * @param link - The body's link.
 */
function renderBlock(link: BodyUploads): void {
  render(
    <PendingUploadsContext.Provider value={link.pending}>
      <DocumentPendingMediaBlock
        props={{ url: '', name: 'shot.png', caption: '', uploadId: 'up1' }}
        actions={{ remove: vi.fn() } as unknown as MediaBlockActions}
      />
    </PendingUploadsContext.Provider>,
  );
}

/**
 * Counts this client's updates to a document from now on.
 * @param doc - The document.
 * @returns A reader of the count.
 */
function countLocalUpdates(doc: Y.Doc): () => number {
  let count = 0;
  doc.on('update', (_u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => {
    if (tr.local) count += 1;
  });
  return () => count;
}

const WAITING: ImageAttrs = { url: '', uploadId: 'up1' };
const WRITTEN: ImageAttrs = { url: URL_Z, uploadId: '' };

beforeAll(async () => {
  await changeLocale('en');
});

beforeEach(() => {
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  links.splice(0).forEach((link) => {
    link.detach();
  });
  _resetDocumentEditorCacheForTests();
  clearAllDocSizes();
  _resetForTests();
  upload.media.mockReset();
  vi.mocked(assetsApi.ingestUrl).mockReset();
  vi.mocked(canvasApi.paste).mockReset();
  vi.mocked(waitForUploadEnding).mockReset();
  document.body.innerHTML = '';
});

describe('DU-01 a pending block is not inserted and no upload starts while the Space is full', () => {
  const PNG = (): File => new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' });

  /**
   * Opens a real body built for a Space, caret at the end of its one line.
   * @param spaceId - The Space.
   * @returns The editor handle and its document.
   */
  function openEditor(spaceId: string): ReturnType<typeof getDocumentEditor> & { doc: Y.Doc } {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    const handle = getDocumentEditor(doc, docName.documentSpace(PID, spaceId), {
      caretProvider: { awareness: new Awareness(doc) },
      readWho: () => ({ role: 'owner', viewerId: 'u1' }),
      editable: true,
      uploadTarget: { projectId: PID, spaceId },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    adoptDocumentEditor(handle, container);
    handle.editor.replaceBlocks(handle.editor.document, [{ type: 'paragraph', content: 'lead' }] as never);
    handle.undoManager.clear();
    handle.editor.setTextCursorPosition((handle.editor.document as { id: string }[])[0].id, 'end');
    handle.editor.prosemirrorView.focus();
    return Object.assign(handle, { doc });
  }

  /**
   * Hands files to the body, as a paste or a drop.
   * @param handle - The body.
   * @param how - Paste or drop.
   * @param files - The files.
   */
  function arrive(handle: ReturnType<typeof getDocumentEditor>, how: 'paste' | 'drop', files: File[]): void {
    const view = handle.editor.prosemirrorView;
    const event = new Event(how, { bubbles: true, cancelable: true });
    const data = { files, types: ['Files'], items: [], getData: (): string => '' };
    if (how === 'paste') Object.defineProperty(event, 'clipboardData', { value: data });
    else {
      view.posAtCoords = (): { pos: number; inside: number } => ({ pos: 3, inside: -1 });
      Object.assign(event, { clientX: 1, clientY: 1 });
      Object.defineProperty(event, 'dataTransfer', { value: data });
    }
    view.dom.dispatchEvent(event);
  }

  it.each(['paste', 'drop'] as const)('DU-01 a file arriving by %s at F inserts nothing, uploads nothing and says T_ADD once', async (how) => {
    upload.media.mockReturnValue(new Promise(() => undefined));
    const spaceId = `s${seq++}`;
    const handle = openEditor(spaceId);
    enterSize(docName.documentSpace(PID, spaceId), 'F');
    const fragment = documentBodyFragment(handle.doc);
    const before = Y.encodeStateAsUpdate(handle.doc);
    vi.mocked(toast.warning).mockClear();

    arrive(handle, how, [PNG()]);
    await settle();

    expect(images(handle.doc)).toEqual([]);
    expect(fragment.toString()).not.toContain('<image');
    expect(Y.encodeStateAsUpdate(handle.doc)).toEqual(before);
    expect(upload.media).not.toHaveBeenCalled();
    expectSizeToast(SIZE_COPY_EN.T_ADD);
  });

  it.each(['F', 'W'] as const)('DU-01 a file chosen in the insert menu picker at %s', async (code) => {
    upload.media.mockReturnValue(new Promise(() => undefined));
    const spaceId = `s${seq++}`;
    const handle = openEditor(spaceId);
    enterSize(docName.documentSpace(PID, spaceId), code);
    const before = Y.encodeStateAsUpdate(handle.doc);
    let pick: ReturnType<typeof useDocumentMediaPick> = null;
    /**
     * Captures the pick the picker provides, as the block menu does.
     * @returns Nothing.
     */
    function Probe(): null {
      pick = useDocumentMediaPick();
      return null;
    }
    render(<DocumentMediaPicker files={handle.files}><Probe /></DocumentMediaPicker>);
    const row = (handle.editor.document as PressedBlock[])[0];
    act(() => {
      pick?.('image', (blocks) => {
        insertMediaBelow(handle.editor, row, blocks);
        return true;
      });
    });
    vi.mocked(toast.warning).mockClear();
    const input = screen.getByTestId('doc-media-file-input');
    Object.defineProperty(input, 'files', { value: [PNG()], configurable: true });
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();

    if (code === 'F') {
      expect(images(handle.doc)).toEqual([]);
      expect(Y.encodeStateAsUpdate(handle.doc)).toEqual(before);
      expect(upload.media).not.toHaveBeenCalled();
      expectSizeToast(SIZE_COPY_EN.T_ADD);
    } else {
      expect(images(handle.doc)).toHaveLength(1);
      expect(upload.media).toHaveBeenCalledTimes(1);
      expectSizeToast(null);
    }
  });

  it('DU-01 the same paste at W inserts the pending block and starts its upload (control)', async () => {
    upload.media.mockReturnValue(new Promise(() => undefined));
    const spaceId = `s${seq++}`;
    const handle = openEditor(spaceId);
    enterSize(docName.documentSpace(PID, spaceId), 'W');

    arrive(handle, 'paste', [PNG()]);
    await settle();

    expect(images(handle.doc)).toHaveLength(1);
    expect(upload.media).toHaveBeenCalledTimes(1);
    expectSizeToast(null);
  });
});

describe('DU-02 an upload finishing while the Space is full is kept and waits', () => {
  it('DU-02 writes no address, keeps the record done, says nothing and shows the waiting sentence', async () => {
    const world = open();
    enterSize(world.name, 'W');
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();
    pushSize(world.name, P_FULL);
    renderBlock(world.link);

    await finish(world);

    expect(images(world.doc)).toEqual([WAITING]);
    expect(world.controller.entry('up1')?.phase).toBe('done');
    expectSizeToast(null);
    expect(screen.getByText(SIZE_COPY_EN.T_WAIT)).toBeInTheDocument();
  });
});


describe('DU-03 leaving full writes the waiting address exactly once', () => {
  it('DU-03 writes on the push back to warning, and never again on later pushes or body changes', async () => {
    const world = open();
    enterSize(world.name, 'W');
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();
    pushSize(world.name, P_FULL);
    await finish(world);
    expect(images(world.doc)).toEqual([WAITING]);

    const writes = countLocalUpdates(world.doc);
    pushSize(world.name, P_WARNING);
    await settle();
    expect(images(world.doc)).toEqual([WRITTEN]);
    expect(writes()).toBe(1);

    pushSize(world.name, P_NORMAL);
    await settle();
    loadRemote(world.doc, (source) => {
      Y.applyUpdate(source, Y.encodeStateAsUpdate(world.doc));
      documentBodyFragment(source).insert(documentBodyFragment(source).length, [new Y.XmlElement('blockGroup')]);
    });
    await settle();
    expect(writes()).toBe(1);
    expect(images(world.doc)).toEqual([WRITTEN]);
  });
});

describe.each([
  ['O', true],
  ['Z', false],
] as const)('DU-04 an upload finishing at %s', (code: SizeCode, showsWait: boolean) => {
  it(`DU-04 writes no address and keeps the record done at ${code}; the waiting sentence ${showsWait ? 'shows' : 'does not show (Q11)'}`, async () => {
    const world = open();
    enterSize(world.name, 'W');
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();
    if (code === 'Z') startDocResync(world.name);
    else enterSize(world.name, code);
    renderBlock(world.link);

    await finish(world);

    expect(images(world.doc)).toEqual([WAITING]);
    expect(world.controller.entry('up1')?.phase).toBe('done');
    expectSizeToast(null);
    if (showsWait) expect(screen.getByText(SIZE_COPY_EN.T_WAIT)).toBeInTheDocument();
    else expect(screen.queryByText(SIZE_COPY_EN.T_WAIT)).toBeNull();
  });
});

describe('DU-05 an upload that finished during a rebuild lands in the rebuilt document', () => {
  it('DU-05 writes the address into the new body exactly once after synced', async () => {
    const world = open();
    enterSize(world.name, 'W');
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();

    // Collab refuses an update: the tab drops the document and opens a new one.
    startDocResync(world.name);
    world.link.detach();
    destroyDoc(world.name, world.doc);
    const fresh = getDoc(world.name);
    loadRemote(fresh, (source) => pendingBody(source));
    attachBody(world.controller, world.spaceId, fresh, world.access);
    const writes = countLocalUpdates(fresh);

    await finish(world);
    expect(images(fresh)).toEqual([WAITING]);

    pushSize(world.name, P_WARNING);
    await settle();
    expect(images(fresh)).toEqual([WAITING]);

    act(() => {
      docSizeSynced(world.name);
    });
    await settle();
    expect(images(fresh)).toEqual([WRITTEN]);
    expect(writes()).toBe(1);
    expectSizeToast(null);
  });
});

describe('DU-06 the address write is an edit judged without a toast', () => {
  it('DU-06 sends a structure update at U', async () => {
    const world = open();
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();
    const captured = await captureWriteAsync(world.doc, () => finish(world));
    expect(images(world.doc)).toEqual([WRITTEN]);
    expectKindShape('edit', captured);
  });

  it('DU-06 at F the skipped write shows no toast (notify: false)', async () => {
    const world = open();
    enterSize(world.name, 'N');
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();
    enterSize(world.name, 'F');
    const captured = await captureWriteAsync(world.doc, () => finish(world));
    expect(captured.shape).toBe('∅');
    expect(images(world.doc)).toEqual([WAITING]);
    expectSizeToast(null);
  });
});

describe('DU-07 Retry of a failed upload asks canAdd first', () => {
  it('DU-07 at F sends nothing, says T_ADD once, stays failed and keeps the file for a later Retry', async () => {
    const world = open();
    enterSize(world.name, 'N');
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();
    world.runs[0].resolve({ ok: false, failure: { reason: 'failed', retryable: true } });
    await settle();
    expect(world.controller.entry('up1')?.phase).toBe('failed');

    enterSize(world.name, 'F');
    vi.mocked(toast.warning).mockClear();
    act(() => {
      world.link.pending.retry('up1');
    });
    await settle();

    expect(world.run).toHaveBeenCalledTimes(1);
    expectSizeToast(SIZE_COPY_EN.T_ADD);
    expect(world.controller.entry('up1')?.phase).toBe('failed');

    pushSize(world.name, P_WARNING);
    act(() => {
      world.link.pending.retry('up1');
    });
    await settle();
    expect(world.run).toHaveBeenCalledTimes(2);
    expect(world.run.mock.calls[1][1]).toEqual(world.run.mock.calls[0][1]);
  });
});

describe('DU-08 a body without write access keeps the finished upload (existing behaviour)', () => {
  it('DU-08 writes nothing while access is denied, keeps it done, and writes once access is granted', async () => {
    const world = open();
    enterSize(world.name, 'N');
    world.access.value = 'denied';
    world.link.start('up1', { kind: 'file', file: new File(['x'], 'shot.png', { type: 'image/png' }) });
    await settle();
    await finish(world);
    expect(images(world.doc)).toEqual([WAITING]);
    expect(world.controller.entry('up1')?.phase).toBe('done');

    world.access.value = 'granted';
    act(() => {
      world.access.listeners.forEach((listener) => {
        listener();
      });
    });
    await settle();
    expect(images(world.doc)).toEqual([WRITTEN]);
  });
});

describe('DU-09 a pasted outside link is not fetched while the Space is full', () => {
  /**
   * Opens the page's link to a registered body holding the pending block.
   * @returns The Space, its document name and the link.
   */
  function openPage(): { spaceId: string; name: string; link: BodyUploads } {
    const spaceId = `s${seq++}`;
    const name = docName.documentSpace(PID, spaceId);
    const doc = getDoc(name);
    loadRemote(doc, (source) => pendingBody(source));
    const link = openPageBodyUploads({ projectId: PID, spaceId }, doc, name, undefined);
    links.push(link);
    return { spaceId, name, link };
  }

  it.each([
    ['an outside address', { kind: 'address', url: 'https://imgs.example/x.jpg' }],
    ['an address of ours', { kind: 'ours', url: 'https://cdn.example/a.png' }],
  ] as const)('DU-09 %s at F: no ingestUrl and no paste; the block fails with T_REASON and offers Retry', async (_label, source) => {
    const { name, link } = openPage();
    enterSize(name, 'F');
    vi.mocked(toast.warning).mockClear();
    render(
      <PendingUploadsContext.Provider value={link.pending}>
        <DocumentPendingMediaBlock
          props={{ url: '', name: 'x.jpg', caption: '', uploadId: 'up1' }}
          actions={{ remove: vi.fn() } as unknown as MediaBlockActions}
        />
      </PendingUploadsContext.Provider>,
    );

    act(() => {
      link.start('up1', source);
    });
    await settle();

    expect(assetsApi.ingestUrl).not.toHaveBeenCalled();
    expect(canvasApi.paste).not.toHaveBeenCalled();
    expect(screen.getByTestId('doc-pending-media').dataset['status']).toBe('failed');
    expect(screen.getByText(SIZE_COPY_EN.T_REASON)).toBeInTheDocument();
    expect(screen.getByTestId('doc-pending-retry')).toBeInTheDocument();
  });

  it('DU-09 Retry asks canAdd again: refused at F, fetched once the Space is back at warning', async () => {
    const { name, link } = openPage();
    enterSize(name, 'F');
    vi.mocked(assetsApi.ingestUrl).mockResolvedValue({ storage_key: 'k1' });
    vi.mocked(waitForUploadEnding).mockReturnValue(new Promise(() => undefined));
    act(() => {
      link.start('up1', { kind: 'address', url: 'https://imgs.example/x.jpg' });
    });
    await settle();
    vi.mocked(toast.warning).mockClear();

    act(() => {
      link.pending.retry('up1');
    });
    await settle();
    expect(assetsApi.ingestUrl).not.toHaveBeenCalled();
    expectSizeToast(SIZE_COPY_EN.T_ADD);

    pushSize(name, P_WARNING);
    act(() => {
      link.pending.retry('up1');
    });
    await settle();
    expect(assetsApi.ingestUrl).toHaveBeenCalledTimes(1);
  });
});
