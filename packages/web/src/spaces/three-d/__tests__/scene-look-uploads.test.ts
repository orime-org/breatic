// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uploading a part picture from the computer (inner#1693 design 6.3): a page-level holder that
 * outlives the panel and the editor, checks the local header first, and writes on completion
 * only when the Space, the object, the user's access, the part's picture and the budget allow.
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
  uploads: { start: (input: { projectId: string; spaceId: string; name: string; objectId: string; part: string; file: File; ownBytes: number; clampBytes: Record<string, number>; limits: { maxTextureEdge: number; maxTextureBytes: number; maxPictureHeaderBytes: number } }) => Promise<void>;
    get: (spaceId: string, objectId: string, part: string) => { percent: number } | undefined };
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
 * @param session - What the Space's name resolves to at completion.
 * @param localSize - The local file header's answer, or the error reading it.
 * @param size - Sizes of pictures already in use.
 * @returns The harness.
 * @throws {AssertionError} When createSceneLookUploads is not exported.
 */
function harness(session: () => SceneSession | undefined, localSize: { width: number; height: number; type: string } | null | Error = { width: 64, height: 64, type: 'png' },
  size: (assetId: string) => Promise<{ width: number; height: number; type: string } | null> = async () => ({ width: 64, height: 64, type: 'png' }),
  uploadImpl?: (file: File, context: unknown, onProgress: (fraction: number) => void, signal: AbortSignal, beforeSend: () => Promise<void>) => Promise<{ assetId: string }>): Harness {
  const factory = (uploadsModule as Record<string, unknown>).createSceneLookUploads as ((deps: unknown) => Harness['uploads']) | undefined;
  expect(factory, 'createSceneLookUploads must be exported').toBeTypeOf('function');
  let finish: (assetId?: string) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const upload = vi.fn(uploadImpl ?? (() => new Promise((resolve, reject) => {
    finish = (assetId = UPLOADED) => resolve({ assetId, url: 'https://assets.example.test/u.png' });
    fail = reject;
  })));
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
function startFor(file = new File(['x'], 'pattern.png', { type: 'image/png' })): Parameters<Harness['uploads']['start']>[0] {
  return { projectId: PROJECT, spaceId: SPACE, name: NAME, objectId: ID, part: '0', file, ownBytes: 0, clampBytes: {},
    limits: { maxTextureEdge: 8192, maxTextureBytes: 268_435_456, maxPictureHeaderBytes: 12_345_678 } };
}

describe('SceneLookUploads', () => {
  it('holds the Space busy, writes the picture to the starting part and refreshes the project images', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    expect(h.register).toHaveBeenCalledWith(SPACE, expect.any(String));
    h.finish();
    await done;
    expect(lookOf(doc)).toEqual({ 0: { map: UPLOADED } });
    expect(h.invalidateImages).toHaveBeenCalledWith(PROJECT);
    expect(h.unregister).toHaveBeenCalledWith(SPACE, h.register.mock.calls[0]?.[1]);
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
    const { doc, session } = editor();
    const h = harness(() => session, { width: 9000, height: 10, type: 'png' });
    const done = h.uploads.start(startFor());
    await settle();
    expect(h.upload).toHaveBeenCalledTimes(1);
    h.finish();
    await done;
    expect(lookOf(doc)).toEqual({ 0: { map: UPLOADED } });
  });

  it('does not write when the Space is closed at completion, without creating a session', async () => {
    const h = harness(() => undefined);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.spaceClosed' }));
    expect(h.unregister).toHaveBeenCalled();
  });

  it('does not write when the object was locked or deleted meanwhile', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol(), true, NAME);
    h.finish();
    await done;
    expect(lookOf(doc)).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.objectGone' }));
  });

  it('says the object is gone and writes nothing when it was deleted meanwhile', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    applySceneCommand(doc, { type: 'delete', ids: [ID] }, Symbol(), true, NAME);
    h.finish();
    await done;
    expect(readSceneDocument(doc).objects).toEqual([]);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.objectGone' }));
    expect(session.getSnapshot().commandError).toBeNull();
  });

  it('does not write when the user can no longer edit the Space', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    session.setEnvironment({ readOnly: true, connected: true, hasEverSynced: true, writeAccess: 'denied', refused: false, awareness: new Awareness(doc) });
    h.finish();
    await done;
    expect(lookOf(doc)).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.noLongerEditable' }));
  });

  it('does not write over another picture set on the part meanwhile', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    applySceneCommand(doc, { type: 'look', id: ID, part: '0', set: { map: OTHER_IMAGE } } as never, Symbol(), true, NAME);
    h.finish();
    await done;
    expect(lookOf(doc)).toEqual({ 0: { map: OTHER_IMAGE } });
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.partChanged' }));
  });

  it('still writes after the part was reset meanwhile, whether or not it had a picture', async () => {
    for (const before of [{}, { map: OTHER_IMAGE }]) {
      const { doc, session } = editor();
      if ('map' in before) applySceneCommand(doc, { type: 'look', id: ID, part: '0', set: before } as never, Symbol(), true, NAME);
      const h = harness(() => session);
      const done = h.uploads.start(startFor());
      await settle();
      applySceneCommand(doc, { type: 'look', id: ID, part: null, set: {} } as never, Symbol(), true, NAME);
      h.finish();
      await done;
      expect(lookOf(doc)).toEqual({ 0: { map: UPLOADED } });
    }
  });

  it('does not write a picture that would go over the object budget at completion', async () => {
    const { doc, session } = editor();
    // Each picture fits alone (4096 and 6000 px); together they pass the 256 MiB budget.
    const h = harness(() => session, { width: 4096, height: 4096, type: 'png' }, async () => ({ width: 6000, height: 6000, type: 'png' }));
    const done = h.uploads.start({ ...startFor(), ownBytes: 0 });
    await settle();
    // A collaborator puts a picture on another part during the upload.
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER_IMAGE } } as never, Symbol(), true, NAME);
    h.finish();
    await done;
    expect(lookOf(doc)).toEqual({ 1: { map: OTHER_IMAGE } });
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.uploadedOverLimit' }));
  });

  it('names the part limit and sends nothing when the object already has a look on every part it can hold', async () => {
    const { doc, session } = editor();
    for (let part = 1; part <= 256; part += 1) applySceneCommand(doc, { type: 'look', id: ID, part: String(part), set: { opacity: 0.5 } } as never, Symbol(), true, NAME);
    const h = harness(() => session);
    await h.uploads.start(startFor());
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.partLimit', params: { max: '256' }, severity: 'warning' });
  });

  it('says the picture is in the Project images when the object reached its part limit during the upload', async () => {
    const { doc, session } = editor();
    for (let part = 1; part <= 255; part += 1) applySceneCommand(doc, { type: 'look', id: ID, part: String(part), set: { opacity: 0.5 } } as never, Symbol(), true, NAME);
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    // A collaborator changes one more part while the bytes are sent.
    applySceneCommand(doc, { type: 'look', id: ID, part: '256', set: { opacity: 0.5 } } as never, Symbol(), true, NAME);
    h.finish();
    await done;
    expect(lookOf(doc)).not.toHaveProperty('0');
    expect(h.notify).toHaveBeenCalledWith({ key: 'spaces.threeD.look.uploadedPartLimit', params: { max: '256' }, severity: 'warning' });
    expect(session.getSnapshot().commandError).toBeNull();
  });

  it('reads every header with the configured byte cap', async () => {
    const { doc, session } = editor();
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER_IMAGE } } as never, Symbol(), true, NAME);
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await done;
    expect(h.caps.length).toBeGreaterThan(1);
    expect(new Set(h.caps)).toEqual(new Set([12_345_678]));
  });

  it('judges every guard again after reading the other pictures, so a picture set on the part meanwhile stays', async () => {
    const { doc, session } = editor();
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER_IMAGE } } as never, Symbol(), true, NAME);
    let releaseSize: () => void = () => undefined;
    const h = harness(() => session, { width: 64, height: 64, type: 'png' },
      (assetId) => (assetId === OTHER_IMAGE ? new Promise((resolve) => { releaseSize = () => resolve({ width: 64, height: 64, type: 'png' }); }) : Promise.resolve({ width: 64, height: 64, type: 'png' })));
    const done = h.uploads.start(startFor());
    await settle();
    h.finish();
    await settle();
    // A collaborator puts their own picture on the part while the other picture's size is read.
    applySceneCommand(doc, { type: 'look', id: ID, part: '0', set: { map: OTHER_IMAGE } } as never, Symbol(), true, NAME);
    releaseSize();
    await done;
    expect(lookOf(doc)).toEqual({ 0: { map: OTHER_IMAGE }, 1: { map: OTHER_IMAGE } });
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.partChanged' }));
  });

  it('puts a picture on a part the object already changed when it holds the most parts it can', async () => {
    const { doc, session } = editor();
    for (let part = 0; part < 256; part += 1) applySceneCommand(doc, { type: 'look', id: ID, part: String(part), set: { opacity: 0.5 } } as never, Symbol(), true, NAME);
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    expect(h.upload).toHaveBeenCalledTimes(1);
    h.finish();
    await done;
    expect((lookOf(doc) as Record<string, { map?: string }>)['0']?.map).toBe(UPLOADED);
  });

  it('tells the reason when the upload fails and leaves the part alone', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const done = h.uploads.start(startFor());
    await settle();
    h.fail(new (await import('@web/data/upload/media-upload')).UploadFailedError('storage'));
    await done;
    expect(lookOf(doc)).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'canvas.upload.storageFull' }));
    expect(h.unregister).toHaveBeenCalled();
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

  it('puts the same picture already on another part on this one too, as picking it from the Project would', async () => {
    const { doc, session } = editor();
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER_IMAGE } } as never, Symbol(), true, NAME);
    // 6000 px alone fits the 256 MiB budget; counted twice it would not.
    const big = { width: 6000, height: 6000, type: 'png' };
    const h = harness(() => session, big, async () => big, async () => ({ assetId: OTHER_IMAGE }));
    await h.uploads.start(startFor());
    expect(lookOf(doc)).toEqual({ 0: { map: OTHER_IMAGE }, 1: { map: OTHER_IMAGE } });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('stops a new picture that would take the object over its budget before any byte is sent', async () => {
    const { doc, session } = editor();
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER_IMAGE } } as never, Symbol(), true, NAME);
    const big = { width: 6000, height: 6000, type: 'png' };
    let sent = false;
    const h = harness(() => session, big, async () => big, async (_file, _context, _progress, signal, beforeSend) => {
      await beforeSend();
      signal.throwIfAborted();
      sent = true;
      return { assetId: UPLOADED };
    });
    await h.uploads.start(startFor());
    expect(sent).toBe(false);
    expect(lookOf(doc)).toEqual({ 1: { map: OTHER_IMAGE } });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.look.objectTexturesTooLarge' }));
    expect(h.unregister).toHaveBeenCalled();
  });

  it('shows a part\'s upload from the moment it starts and runs one upload per part at a time', async () => {
    const { doc, session } = editor();
    const h = harness(() => session);
    const first = h.uploads.start(startFor());
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
    const second = h.uploads.start(startFor(new File(['y'], 'other.png', { type: 'image/png' })));
    await settle();
    await second;
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.uploads.get(SPACE, ID, '0')).toBeDefined();
    h.finish();
    await first;
    expect(lookOf(doc)).toEqual({ 0: { map: UPLOADED } });
    expect(h.uploads.get(SPACE, ID, '0')).toBeUndefined();
  });

  it('hands the page upload the check that runs before any byte is sent', async () => {
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
    const [, , , signal, onRegistering, beforeSend] = vi.mocked(uploadMedia).mock.calls[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(onRegistering).toBeUndefined();
    expect(beforeSend).toBeTypeOf('function');
    await expect((beforeSend as () => Promise<void>)()).resolves.toBeUndefined();
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
