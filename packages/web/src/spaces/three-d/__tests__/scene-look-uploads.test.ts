// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Uploading a part picture from the computer (inner#1693 design 6.3): a page-level holder that
 * outlives the panel and the editor. It checks the local header, the part limit and the object's
 * texture budget before asking for a ticket, sends only the bytes, and leaves the write to collab:
 * the part row waits until the picture shows on the part or collab says why it did not write.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { SCENE_FORMAT_VERSION, uploadableFormatList } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import * as uploadsModule from '@web/spaces/three-d/scene-look-uploads';
import { uploadMedia } from '@web/data/upload/media-upload';

vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/data/upload/media-upload')>(),
  // The page holder's upload never answers here; the arguments it was given are what is checked.
  uploadMedia: vi.fn(() => new Promise(() => undefined)),
}));

const NAME = 'project-p1/3d-s1';
const PROJECT = 'p1';
const SPACE = 's1';
const ID = '11111111-1111-4111-8111-111111111111';
const UPLOADED = '77777777-7777-4777-8777-777777777777';
const OTHER_IMAGE = '88888888-8888-4888-8888-888888888888';
const OBJECT = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false,
};
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** An editor session on a scene with one object. */
function editor(): { doc: Y.Doc; session: SceneSession } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true, NAME);
  const awareness = new Awareness(doc);
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness });
  cleanups.push(() => { session.destroy(); awareness.destroy(); doc.destroy(); });
  return { doc, session };
}

/** The look of the object, or undefined. */
function lookOf(doc: Y.Doc): unknown {
  return (readSceneDocument(doc).objects[0] as { look?: unknown } | undefined)?.look;
}

interface Harness {
  uploads: {
    start: (input: ReturnType<typeof startFor>) => Promise<void>;
    get: (spaceId: string, objectId: string, part: string) => { percent: number } | undefined;
    settled: (signal: { spaceId: string; objectId: string; part: string; picture: string; outcome: 'written' | 'objectGone' | 'partChanged' | 'partLimit' }) => void;
  };
  upload: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  invalidateImages: ReturnType<typeof vi.fn>;
  /** The header byte caps the local and Project size reads were given. */
  caps: number[];
  finish: (assetId?: string) => void;
  fail: (error: unknown) => void;
}

/**
 * A holder over controllable dependencies.
 * @param session - What the Space's name resolves to.
 * @param localSize - The local file header's answer, or the error reading it.
 * @param size - Sizes of pictures already in use.
 * @returns The harness.
 * @throws {AssertionError} When createSceneLookUploads is not exported.
 */
function harness(session: () => SceneSession | undefined, localSize: { width: number; height: number; type: string } | null | Error = { width: 64, height: 64, type: 'png' },
  size: (assetId: string) => Promise<{ width: number; height: number; type: string } | null> = async () => ({ width: 64, height: 64, type: 'png' })): Harness {
  const factory = (uploadsModule as Record<string, unknown>).createSceneLookUploads as ((deps: unknown) => Harness['uploads']) | undefined;
  expect(factory, 'createSceneLookUploads must be exported').toBeTypeOf('function');
  let finish: (assetId?: string) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const upload = vi.fn(() => new Promise((resolve, reject) => {
    finish = (assetId = UPLOADED) => resolve({ assetId, url: 'https://assets.example.test/u.png' });
    fail = reject;
  }));
  const notify = vi.fn(); const register = vi.fn(); const unregister = vi.fn(); const invalidateImages = vi.fn();
  const caps: number[] = [];
  const uploads = factory!({
    upload, notify, register, unregister, invalidateImages,
    readLocalSize: async (_file: File, maxBytes: number) => { caps.push(maxBytes); if (localSize instanceof Error) throw localSize; return localSize; },
    size: (_projectId: string, assetId: string, maxBytes: number) => { caps.push(maxBytes); return size(assetId); }, session,
  });
  return { uploads, upload, notify, register, unregister, invalidateImages, caps, finish: (id) => finish(id), fail: (error) => fail(error) };
}

/** Lets pending promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** A start request for part 0 of the object. */
function startFor(file = new File(['x'], 'pattern.png', { type: 'image/png' })): {
  projectId: string; spaceId: string; name: string; objectId: string; part: string; file: File; ownBytes: number;
  clampBytes: Record<string, number>; limits: { maxTextureEdge: number; maxTextureBytes: number; maxPictureHeaderBytes: number };
} {
  return { projectId: PROJECT, spaceId: SPACE, name: NAME, objectId: ID, part: '0', file, ownBytes: 0, clampBytes: {},
    limits: { maxTextureEdge: 8192, maxTextureBytes: 268_435_456, maxPictureHeaderBytes: 12_345_678 } };
}

/** Put a look on the object as a member's command would. */
function look(doc: Y.Doc, part: string, set: Record<string, unknown>): void {
  applySceneCommand(doc, { type: 'look', id: ID, part, set } as never, Symbol(), true, NAME);
}

describe('SceneLookUploads', () => {
  it('asks for a ticket naming the part and its starting picture, holds the Space while bytes go, and writes nothing itself', async () => {
    const { doc, session } = editor();
    look(doc, '0', { map: OTHER_IMAGE });
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    expect(h.register).toHaveBeenCalledWith(SPACE, expect.any(String));
    expect(h.upload.mock.calls[0]?.[1]).toEqual({
      projectId: PROJECT, spaceId: SPACE, purpose: 'scene_look', objectId: ID, part: '0', startMap: OTHER_IMAGE,
    });
    h.finish();
    await done;
    expect(lookOf(doc)).toEqual({ 0: { map: OTHER_IMAGE } });
    expect(h.invalidateImages).toHaveBeenCalledWith(PROJECT);
    expect(h.unregister).toHaveBeenCalledWith(SPACE, h.register.mock.calls[0]?.[1]);
  });

  it('names no starting picture for a part that had none', async () => {
    const { session } = editor();
    const h = harness(() => session);
    void h.uploads.start(startFor());
    await settle();
    expect(h.upload.mock.calls[0]?.[1]).toMatchObject({ purpose: 'scene_look', startMap: null });
  });

  it('keeps the part row waiting once the bytes are stored, until the picture shows on the part', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    expect(h.uploads.get(SPACE, ID, '0')).toEqual(expect.objectContaining({ percent: 100 }));
    // Collab writes the picture.
    look(doc, '0', { map: UPLOADED });
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it('ends the upload once its picture showed, so removing the picture later offers a new choice', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    const version = (h.uploads as unknown as { getVersion: () => number }).getVersion();
    // Collab writes the picture while no panel reads the row, then the user removes it.
    look(doc, '0', { map: UPLOADED });
    expect((h.uploads as unknown as { getVersion: () => number }).getVersion()).toBeGreaterThan(version);
    look(doc, '0', { map: null });
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it('stops waiting when the part shows another picture or the object is gone, since collab will not write', async () => {
    for (const change of ['picture', 'gone'] as const) {
      const { doc, session } = editor();
      const h = harness(() => session);
      const done = h.uploads.start(startFor());
      await settle();
      h.finish();
      await done;
      if (change === 'picture') look(doc, '0', { map: OTHER_IMAGE });
      else applySceneCommand(doc, { type: 'delete', ids: [ID] } as never, Symbol(), true, NAME);
      expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
    }
  });

  it('keeps waiting while the part was reset meanwhile, which collab still writes over', async () => {
    const { doc, session } = editor();
    look(doc, '0', { map: OTHER_IMAGE });
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    look(doc, '0', { map: null });
    h.finish();
    await done;
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
  });

  it.each([
    ['objectGone', { key: 'spaces.threeD.look.objectGone', severity: 'warning' }],
    ['partChanged', { key: 'spaces.threeD.look.partChanged', severity: 'warning' }],
    ['partLimit', { key: 'spaces.threeD.look.uploadedPartLimit', params: { max: '256' }, severity: 'warning' }],
  ] as const)('says why collab did not write the picture (%s) and ends the wait', async (reason, notice) => {
    const { session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: UPLOADED, outcome: reason });
    expect(h.notify).toHaveBeenCalledWith(notice);
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it('says why when collab settled a picture the studio already held before its upload answered', async () => {
    const { session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: UPLOADED, outcome: 'partChanged' });
    h.finish();
    await done;
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.partChanged', severity: 'warning' });
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it('ends the wait quietly when collab says the picture was written, even while the Space is closed', async () => {
    const { doc, session } = editor();
    let open: SceneSession | undefined = session;
    const h = harness(() => open);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    open = undefined;
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: UPLOADED, outcome: 'written' });
    // Reopened after a collaborator removed the written picture: the row is free.
    look(doc, '0', { map: null });
    open = session;
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('frees the row once the open Space shows why collab will not write, and still says why when collab does', async () => {
    for (const change of ['picture', 'gone'] as const) {
      const { doc, session } = editor();
      const h = harness(() => session);
      const done = h.uploads.start(startFor());
      await settle();
      if (change === 'picture') look(doc, '0', { map: OTHER_IMAGE });
      else applySceneCommand(doc, { type: 'delete', ids: [ID] } as never, Symbol(), true, NAME);
      h.finish();
      await done;
      expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
      const outcome = change === 'picture' ? 'partChanged' : 'objectGone';
      h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: UPLOADED, outcome });
      expect(h.notify).toHaveBeenCalledWith({ key: `spaces.threeD.look.${outcome}`, severity: 'warning' });
    }
  });

  it('says why for an earlier freed upload when its settlement arrives while a later upload on the part is still sending', async () => {
    const SECOND = '99999999-9999-4999-8999-999999999999';
    const { doc, session } = editor();
    const h = harness(() => session);
    const first = h.uploads.start(startFor());
    await settle();
    look(doc, '0', { map: OTHER_IMAGE });
    h.finish();
    await first;
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
    const second = h.uploads.start(startFor());
    await settle();
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: UPLOADED, outcome: 'partChanged' });
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.partChanged', severity: 'warning' });
    h.finish(SECOND);
    await second;
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
  });

  it('says why for an ended upload a new upload on the part replaced before anything released it', async () => {
    const SECOND = '99999999-9999-4999-8999-999999999999';
    const { doc, session } = editor();
    let open: SceneSession | undefined = undefined;
    const h = harness(() => open);
    const first = h.uploads.start(startFor());
    await settle();
    h.finish();
    await first;
    // Opened again showing another picture on the part: collab will not write, and nothing has read the row yet.
    look(doc, '0', { map: OTHER_IMAGE });
    open = session;
    const second = h.uploads.start(startFor());
    await settle();
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: UPLOADED, outcome: 'partChanged' });
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.partChanged', severity: 'warning' });
    h.finish(SECOND);
    await second;
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while the Space is closed or still loading, and says why when collab settles it', async () => {
    const { session } = editor();
    const loading = new SceneSession(new Y.Doc(), NAME);
    loading.setEnvironment({ readOnly: false, connected: true, hasEverSynced: false, writeAccess: 'granted', refused: false, awareness: new Awareness(new Y.Doc()) });
    cleanups.push(() => { loading.destroy(); });
    let open: SceneSession | undefined = session;
    const h = harness(() => open);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    open = undefined;
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
    open = loading;
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: UPLOADED, outcome: 'partLimit' });
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.uploadedPartLimit', params: { max: '256' }, severity: 'warning' });
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it('names on the ticket the picture the part held before the file header was read', async () => {
    const { doc, session } = editor();
    let read: (size: { width: number; height: number; type: string }) => void = () => undefined;
    const factory = (uploadsModule as Record<string, unknown>).createSceneLookUploads as (deps: unknown) => Harness['uploads'];
    const upload = vi.fn((_file: File, _context: unknown) => new Promise(() => undefined));
    const uploads = factory({ upload, notify: vi.fn(), register: vi.fn(), unregister: vi.fn(), invalidateImages: vi.fn(),
      readLocalSize: () => new Promise((resolve) => { read = resolve; }), size: async () => null, session: () => session });
    void uploads.start(startFor());
    look(doc, '0', { map: OTHER_IMAGE });
    read({ width: 64, height: 64, type: 'png' });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]?.[1]).toMatchObject({ startMap: null });
  });

  it('ignores a settlement for another picture or a part it is not waiting on', async () => {
    const { session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '0', picture: OTHER_IMAGE, outcome: 'partChanged' });
    h.uploads.settled({ spaceId: SPACE, objectId: ID, part: '1', picture: UPLOADED, outcome: 'partChanged' });
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
  });

  it('refuses a file whose header it cannot read, or that is not PNG, JPEG or WebP, without uploading', async () => {
    const { session } = editor();
    for (const local of [null, { width: 64, height: 64, type: 'gif' }]) {
      const h = harness(() => session, local);
      await h.uploads.start(startFor(new File(['x'], 'clip.gif')));
      expect(h.upload).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'canvas.upload.unsupportedType',
        params: { filename: 'clip.gif', kind: 'image', formats: uploadableFormatList('image') } }));
    }
  });

  it('uploads a file over the edge limit, which is shown scaled down (inner#1693 design 7)', async () => {
    const { session } = editor();
    const h = harness(() => session, { width: 16_384, height: 16_384, type: 'png' });
    void h.uploads.start({ ...startFor(), limits: { ...startFor().limits, maxTextureBytes: Number.MAX_SAFE_INTEGER } });
    await settle();
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it('counts the model’s own textures and the local picture before asking for a ticket', async () => {
    const { session } = editor();
    const near = harness(() => session);
    await near.uploads.start({ ...startFor(), ownBytes: 268_435_456 - 1024 });
    expect(near.upload).not.toHaveBeenCalled();
    expect(near.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.objectTexturesTooLarge' }));
    const room = harness(() => session);
    void room.uploads.start(startFor());
    await settle();
    expect(room.upload).toHaveBeenCalledTimes(1);
  });

  it('stops a picture that would take the object over its budget with the pictures it has, before asking for a ticket', async () => {
    const { doc, session } = editor();
    look(doc, '1', { map: OTHER_IMAGE });
    const big = { width: 6000, height: 6000, type: 'png' };
    const h = harness(() => session, big, async () => big);
    await h.uploads.start(startFor());
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.objectTexturesTooLarge' }));
    expect(h.unregister).toHaveBeenCalled();
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it('names the part limit and sends nothing when the object already has a look on every part it can hold', async () => {
    const { doc, session } = editor();
    for (let part = 1; part <= 256; part += 1) look(doc, String(part), { opacity: 0.5 });
    const h = harness(() => session);
    await h.uploads.start(startFor());
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.partLimit', params: { max: '256' }, severity: 'warning' });
  });

  it('reads every header with the configured byte cap', async () => {
    const { doc, session } = editor();
    look(doc, '1', { map: OTHER_IMAGE });
    const h = harness(() => session);
    void h.uploads.start(startFor());
    await settle();
    expect(h.caps.length).toBeGreaterThan(1);
    expect(new Set(h.caps)).toEqual(new Set([12_345_678]));
  });

  it('tells the reason when the upload fails and leaves the part and the row alone', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.fail(new (await import('@web/data/upload/media-upload')).UploadFailedError('storage'));
    await done;
    expect(lookOf(doc)).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'canvas.upload.storageFull' }));
    expect(h.unregister).toHaveBeenCalled();
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it.each([
    ['a transfer that failed', 'transfer'],
    ['an error with no upload reason', null],
  ] as const)('says the picture could not be uploaded after %s', async (_name, reason) => {
    const { session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    const { UploadFailedError } = await import('@web/data/upload/media-upload');
    h.fail(reason === null ? new Error('network') : new UploadFailedError(reason));
    await done;
    expect(h.notify).toHaveBeenCalledWith({ key: 'canvas.upload.failed', params: { filename: 'pattern.png', kind: 'image', formats: uploadableFormatList('image') }, severity: 'error' });
  });

  it('names the picture formats when the server refuses the file type', async () => {
    const { session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.fail(new (await import('@web/data/upload/media-upload')).UploadFailedError('unsupportedType'));
    await done;
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'canvas.upload.unsupportedType', params: { filename: 'pattern.png', kind: 'image', formats: uploadableFormatList('image') } }));
  });

  it('shows a part\'s upload from the moment it starts and runs one upload per part at a time', async () => {
    const { session } = editor();
    const h = harness(() => session);
    const first = h.uploads.start(startFor());
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
    const second = h.uploads.start(startFor(new File(['y'], 'other.png', { type: 'image/png' })));
    await settle();
    await second;
    expect(h.upload).toHaveBeenCalledTimes(1);
    h.finish();
    await first;
    // Still waiting for collab: another file for the part is not taken yet.
    await h.uploads.start(startFor(new File(['z'], 'third.png', { type: 'image/png' })));
    expect(h.upload).toHaveBeenCalledTimes(1);
  });

  it('takes another file for a part once the picture it waited for shows there', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const first = h.uploads.start(startFor());
    await settle();
    h.finish();
    await first;
    look(doc, '0', { map: UPLOADED });
    void h.uploads.start(startFor(new File(['z'], 'next.png', { type: 'image/png' })));
    await settle();
    expect(h.upload).toHaveBeenCalledTimes(2);
    expect(h.upload.mock.calls[1]?.[1]).toMatchObject({ startMap: UPLOADED });
  });

  it('hands the page upload the part context and nothing that runs before sending', async () => {
    const page = (uploadsModule as Record<string, unknown>).pageSceneLookUploads as () => Harness['uploads'];
    const header = new Uint8Array(33);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(header.buffer).setUint32(16, 64);
    new DataView(header.buffer).setUint32(20, 64);
    // jsdom's File has no stream(); a browser's does.
    const file = Object.assign(new File([header], 'pattern.png', { type: 'image/png' }), {
      stream: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(header); controller.close(); } }),
    });
    void page().start({ ...startFor(file), objectId: '99999999-9999-4999-8999-999999999999' });
    await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    const [, context, , signal, onRegistering] = vi.mocked(uploadMedia).mock.calls[0]!;
    expect(context).toMatchObject({ purpose: 'scene_look', objectId: '99999999-9999-4999-8999-999999999999', part: '0', startMap: null });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(onRegistering).toBeUndefined();
    expect(vi.mocked(uploadMedia).mock.calls[0]).toHaveLength(4);
  });

  it('refreshes the Project pictures through the page holder once an upload is stored', async () => {
    vi.resetModules();
    const fresh = await import('@web/spaces/three-d/scene-look-uploads');
    const { QueryClient } = await import('@tanstack/react-query');
    const { projectImagesQueryKey } = await import('@web/data/api/scene');
    const { uploadMedia: freshUpload } = await import('@web/data/upload/media-upload');
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    vi.mocked(freshUpload).mockResolvedValueOnce({ assetId: UPLOADED, url: 'https://assets.example.test/u.png' } as never);
    const header = new Uint8Array(33);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(header.buffer).setUint32(16, 64);
    new DataView(header.buffer).setUint32(20, 64);
    const file = Object.assign(new File([header], 'pattern.png', { type: 'image/png' }), {
      stream: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(header); controller.close(); } }),
    });
    await fresh.pageSceneLookUploads(client).start({ ...startFor(file), objectId: '99999999-9999-4999-8999-999999999999' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectImagesQueryKey(PROJECT) });
  });

  it('is one holder for the page', () => {
    const page = (uploadsModule as Record<string, unknown>).pageSceneLookUploads as (() => unknown) | undefined;
    expect(page, 'pageSceneLookUploads must be exported').toBeTypeOf('function');
    expect(page!()).toBe(page!());
  });
});

describe('isLookImageType', () => {
  it('takes the header types of the pictures the server lets a part use, and no other', () => {
    for (const type of ['png', 'jpeg', 'webp']) expect(uploadsModule.isLookImageType(type)).toBe(true);
    for (const type of ['gif', 'bmp', 'svg', 'jpg', '']) expect(uploadsModule.isLookImageType(type)).toBe(false);
  });
});

describe('reading the local file first (inner#1693 design 3.5)', () => {
  it('tells the user a file that cannot be read, and uploads nothing', async () => {
    const { doc, session } = editor();
    const h = harness(() => session, Object.assign(new Error('The file changed'), { name: 'NotReadableError' }));
    await expect(h.uploads.start(startFor())).resolves.toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.pictureReadFailed', params: { filename: 'pattern.png' }, severity: 'error' });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
    expect(lookOf(doc)).toBeUndefined();
  });

  it('holds the Space from the moment the row shows progress', async () => {
    const { session } = editor();
    let read: (size: { width: number; height: number; type: string }) => void = () => undefined;
    const factory = (uploadsModule as Record<string, unknown>).createSceneLookUploads as (deps: unknown) => Harness['uploads'];
    const register = vi.fn(); const unregister = vi.fn();
    const uploads = factory({ upload: vi.fn(), notify: vi.fn(), register, unregister, invalidateImages: vi.fn(),
      readLocalSize: () => new Promise((resolve) => { read = resolve; }), size: async () => null, session: () => session });
    const done = uploads.start(startFor());
    expect(uploads.get(SPACE, ID, '0')).toBeDefined();
    expect(register).toHaveBeenCalledTimes(1);
    read({ width: 64, height: 64, type: 'gif' });
    await done;
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(uploads.get(SPACE, ID, '0')).toBeUndefined();
  });
});
