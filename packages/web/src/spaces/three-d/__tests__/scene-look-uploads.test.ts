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

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import * as uploadsModule from '@web/spaces/three-d/scene-look-uploads';

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
  uploads: { start: (input: { projectId: string; spaceId: string; name: string; objectId: string; part: string; file: File; ownBytes: number; clampBytes: Record<string, number>; limits: { maxTextureEdge: number; maxTextureBytes: number } }) => Promise<void> };
  upload: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  invalidateImages: ReturnType<typeof vi.fn>;
  finish: (assetId?: string) => void;
  fail: (error: unknown) => void;
}

/**
 * A holder over controllable dependencies.
 * @param session - What the Space's name resolves to at completion.
 * @param localSize - The local file header's answer.
 * @param size - Sizes of pictures already in use.
 * @returns The harness.
 * @throws {AssertionError} When createSceneLookUploads is not exported.
 */
function harness(session: () => SceneSession | undefined, localSize: { width: number; height: number; type: string } | null = { width: 64, height: 64, type: 'png' },
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
  const uploads = factory!({
    upload, notify, register, unregister, invalidateImages,
    readLocalSize: async () => localSize,
    size: (_projectId: string, assetId: string) => size(assetId), session,
  });
  return { uploads, upload, notify, register, unregister, invalidateImages, finish: (id) => finish(id), fail: (error) => fail(error) };
}

/** Lets pending promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** A start request for part 0 of the object. */
function startFor(file = new File(['x'], 'pattern.png', { type: 'image/png' })): Parameters<Harness['uploads']['start']>[0] {
  return { projectId: PROJECT, spaceId: SPACE, name: NAME, objectId: ID, part: '0', file, ownBytes: 0, clampBytes: {},
    limits: { maxTextureEdge: 8192, maxTextureBytes: 268_435_456 } };
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
      expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'canvas.upload.unsupportedType' }));
    }
  });

  it('refuses a file over the edge limit without uploading', async () => {
    const { session } = editor();
    const h = harness(() => session, { width: 9000, height: 10, type: 'png' });
    await h.uploads.start(startFor());
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'spaces.threeD.importModel.limit.textureEdge' }));
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

  it('is one holder for the page', () => {
    const page = (uploadsModule as Record<string, unknown>).pageSceneLookUploads as (() => unknown) | undefined;
    expect(page, 'pageSceneLookUploads must be exported').toBeTypeOf('function');
    expect(page!()).toBe(page!());
  });
});
