// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Putting a Project picture on a part (inner#1693 design 3.5, 7): the type and the object's texture limits are judged
 * from file headers against the object's current look, and a refusal says why.
 */

import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { SCENE_FORMAT_VERSION, getLocale, t, type SceneObject, uploadableFormatList } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { evictSceneSession, getSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { SceneLookPanel } from '@web/spaces/three-d/SceneLookPanel';
import type { SceneFieldDraft } from '@web/spaces/three-d/SceneField';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { uploadBytes } from '@web/spaces/three-d/texture-upload-bytes';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));
type SizeOf = () => Promise<{ width: number; height: number; type: string } | null>;
const sizes = vi.hoisted(() => new Map<string, SizeOf>());
const caps = vi.hoisted(() => [] as number[]);
vi.mock('@web/spaces/three-d/look-picture-size', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/spaces/three-d/look-picture-size')>()),
  pageLookPictureSizes: () => {
    const read = (assetId: string, maxBytes: number): ReturnType<SizeOf> => {
      caps.push(maxBytes);
      return sizes.get(assetId)?.() ?? Promise.resolve(null);
    };
    return { read, size: (assetId: string, maxBytes: number) => read(assetId, maxBytes).catch(() => null) };
  },
  readPictureSize: async () => ({ width: 64, height: 64, type: 'png' }),
}));
const uploadMedia = vi.hoisted(() => vi.fn());
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  uploadMedia,
}));
const captured = vi.hoisted(() => ({ section: null as null | Record<string, unknown>, picker: null as null | Record<string, unknown> }));
vi.mock('@web/spaces/three-d/SceneLookSection', () => ({ SceneLookSection: (props: Record<string, unknown>) => { captured.section = props; return null; } }));
vi.mock('@web/spaces/three-d/SceneImagePickerDialog', () => ({ SceneImagePickerDialog: (props: Record<string, unknown>) => { captured.picker = props; return null; } }));

const NAME = 'project-p1/3d-s1';
const ID = '11111111-1111-4111-8111-111111111111';
const NEW = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const OBJECT = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false,
};
const REPORT = { parts: [{ key: '0', name: null, color: '#969696', hasMap: false, unlit: false, line: false }, { key: '1', name: null, color: '#969696', hasMap: false, unlit: false, line: false }],
  ownBytes: 0, clampBytes: { 0: 0, 1: 0 }, deviceMaxEdge: 16_384 };
const cleanups: (() => void)[] = [];
const NO_PICTURES: readonly string[] = [];
const NO_DRAFTS: ReadonlyMap<string, SceneFieldDraft> = new Map<string, SceneFieldDraft>();
afterEach(() => { cleanup(); cleanups.splice(0).forEach((done) => done()); sizes.clear(); caps.length = 0; vi.clearAllMocks(); });

/** A panel on a scene with one figure, and its document; it can show another part or be opened again. */
function panel(report: typeof REPORT = REPORT): { doc: Y.Doc; session: SceneSession; rerender: () => void; select: (part: string) => void; reopen: () => void } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true, NAME);
  const awareness = new Awareness(doc);
  const session = getSceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness });
  cleanups.push(() => { evictSceneSession(NAME); awareness.destroy(); doc.destroy(); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let selected = '0';
  /** The panel for the object as it is now. */
  const view = (): React.JSX.Element => <QueryClientProvider client={client}>
    <SceneLookPanel session={session} objectId={ID} look={(session.getSnapshot().objects[0] as SceneObject).look ?? {}} report={report as never} projectId='p1' spaceId='s1'
      limits={IMPORT_LIMITS} mutable selectedPart={selected} onSelectPart={vi.fn()} showing={NO_PICTURES} fieldDrafts={NO_DRAFTS} onFieldDraftChange={vi.fn()} />
  </QueryClientProvider>;
  let result = render(view());
  return {
    doc, session,
    rerender: () => result.rerender(view()),
    select: (part) => { selected = part; result.rerender(view()); },
    reopen: () => { result.unmount(); result = render(view()); },
  };
}

/** Choose a picture for a part through the picker. */
async function pick(part: string, assetId: string, displayName: string | null = 'pattern.png'): Promise<void> {
  act(() => { (captured.section!.onChoosePicture as (part: string) => void)(part); });
  await act(async () => { (captured.picker!.onPick as (image: unknown) => void)({ assetId, displayName }); await Promise.resolve(); });
}

/** Lets every pending check step run. */
async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** The object's look. */
const lookOf = (doc: Y.Doc): unknown => (readSceneDocument(doc).objects[0] as { look?: unknown }).look;

describe('picking a Project picture for a part', () => {
  it('names the formats a part takes when the picture is not PNG, JPEG or WebP, and writes nothing', async () => {
    const { doc } = panel();
    sizes.set(NEW, async () => ({ width: 64, height: 64, type: 'gif' }));
    await pick('0', NEW, 'clip.gif');
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('canvas.upload.unsupportedType', { filename: 'clip.gif', kind: 'image', formats: uploadableFormatList('image') })));
    expect(lookOf(doc)).toBeUndefined();
  });

  it('says how far over the object\'s texture budget the picture would go, and writes nothing', async () => {
    const { doc, rerender } = panel();
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER } } as never, Symbol(), true, NAME);
    rerender();
    sizes.set(OTHER, async () => ({ width: 6000, height: 6000, type: 'png' }));
    sizes.set(NEW, async () => ({ width: 6000, height: 6000, type: 'png' }));
    await pick('0', NEW);
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    const mib = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 });
    const total = uploadBytes({ width: 6000, height: 6000 }, true) * 2;
    expect(toast.warning).toHaveBeenCalledWith(t('spaces.threeD.look.objectTexturesTooLarge', {
      actual: mib.format(Math.ceil(total / 1024 / 1024 * 10) / 10), allowed: mib.format(IMPORT_LIMITS.maxTextureBytes / 1024 / 1024) }));
    expect(lookOf(doc)).toEqual({ 1: { map: OTHER } });
    // The picked picture and the one already on the object are both read with the configured header cap.
    expect(caps.length).toBeGreaterThan(1);
    expect(new Set(caps)).toEqual(new Set([IMPORT_LIMITS.maxPictureHeaderBytes]));
  });

  it('counts the model\u2019s own textures, so a small picture on a model near its budget is refused', async () => {
    const { doc } = panel({ ...REPORT, ownBytes: IMPORT_LIMITS.maxTextureBytes - 1024 });
    sizes.set(NEW, async () => ({ width: 64, height: 64, type: 'png' }));
    await pick('0', NEW);
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    const mib = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 });
    const total = IMPORT_LIMITS.maxTextureBytes - 1024 + uploadBytes({ width: 64, height: 64 }, true);
    expect(toast.warning).toHaveBeenCalledWith(t('spaces.threeD.look.objectTexturesTooLarge', {
      actual: mib.format(Math.ceil(total / 1024 / 1024 * 10) / 10), allowed: mib.format(IMPORT_LIMITS.maxTextureBytes / 1024 / 1024) }));
    expect(lookOf(doc)).toBeUndefined();
  });

  it('fits a picked picture to this device\u2019s largest texture edge when judging the total', async () => {
    // With the edge capped at 4096 the picture is counted at 4096 px and fits exactly; at the configured edge it would not.
    const ownBytes = IMPORT_LIMITS.maxTextureBytes - uploadBytes({ width: 4096, height: 4096 }, true);
    const { doc } = panel({ ...REPORT, ownBytes, deviceMaxEdge: 4096 });
    sizes.set(NEW, async () => ({ width: 6000, height: 6000, type: 'png' }));
    await pick('0', NEW);
    await flush();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(lookOf(doc)).toEqual({ 0: { map: NEW } });
  });

  it('judges the picture against the look at the moment it is written, not the one the panel last drew', async () => {
    const { doc } = panel();
    sizes.set(OTHER, async () => ({ width: 6000, height: 6000, type: 'png' }));
    let release: () => void = () => undefined;
    sizes.set(NEW, () => new Promise((resolve) => { release = () => resolve({ width: 6000, height: 6000, type: 'png' }); }));
    await pick('0', NEW);
    // A collaborator puts a large picture on the other part while the new one's size is read.
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER } } as never, Symbol(), true, NAME);
    await act(async () => { release(); await Promise.resolve(); });
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(lookOf(doc)).toEqual({ 1: { map: OTHER } });
  });

  it('keeps one part\'s checking shown when another part\'s check ends first', async () => {
    panel();
    let releaseFirst: () => void = () => undefined;
    const first = new Promise<{ width: number; height: number; type: string }>((resolve) => { releaseFirst = () => resolve({ width: 64, height: 64, type: 'png' }); });
    sizes.set(NEW, () => first);
    let releaseSecond: () => void = () => undefined;
    const second = new Promise<{ width: number; height: number; type: string }>((resolve) => { releaseSecond = () => resolve({ width: 64, height: 64, type: 'png' }); });
    sizes.set(OTHER, () => second);
    await pick('1', NEW);
    await pick('0', OTHER);
    expect(captured.section!.checking).toBe(true);
    await act(async () => { releaseFirst(); await Promise.resolve(); await Promise.resolve(); });
    expect(captured.section!.checking).toBe(true);
    await act(async () => { releaseSecond(); await Promise.resolve(); });
    await vi.waitFor(() => expect(captured.section!.checking).toBe(false));
  });
});

describe('showing a part as checking', () => {
  it('still shows a part checking after the panel was opened again', async () => {
    const { reopen } = panel();
    let release: () => void = () => undefined;
    sizes.set(NEW, () => new Promise((resolve) => { release = () => resolve({ width: 64, height: 64, type: 'gif' }); }));
    await pick('0', NEW);
    reopen();
    expect(captured.section!.checking).toBe(true);
    release();
    await flush();
    expect(captured.section!.checking).toBe(false);
  });

  it('keeps a part checking while its later pick runs after an earlier one ended', async () => {
    panel();
    let releaseLater: () => void = () => undefined;
    sizes.set(OTHER, () => new Promise((resolve) => { releaseLater = () => resolve({ width: 64, height: 64, type: 'png' }); }));
    let releaseEarlier: () => void = () => undefined;
    const earlier = new Promise<{ width: number; height: number; type: string }>((resolve) => { releaseEarlier = () => resolve({ width: 64, height: 64, type: 'gif' }); });
    sizes.set(NEW, () => earlier);
    await pick('0', NEW);
    await pick('0', OTHER);
    releaseEarlier();
    await flush();
    expect(captured.section!.checking).toBe(true);
    releaseLater();
    await flush();
    expect(captured.section!.checking).toBe(false);
  });

  it('shows a part checking when it is selected while its check runs and another part finished', async () => {
    const { select } = panel();
    let release: () => void = () => undefined;
    sizes.set(NEW, () => new Promise((resolve) => { release = () => resolve({ width: 64, height: 64, type: 'png' }); }));
    sizes.set(OTHER, async () => ({ width: 64, height: 64, type: 'gif' }));
    await pick('1', NEW);
    await pick('0', OTHER);
    await flush();
    expect(captured.section!.checking).toBe(false);
    select('1');
    expect(captured.section!.checking).toBe(true);
    release();
    await flush();
    expect(captured.section!.checking).toBe(false);
  });
});

describe('telling why a Project picture was not put on', () => {
  it('says the picture could not be read when reading it failed, and writes nothing', async () => {
    const { doc } = panel();
    sizes.set(NEW, async () => { throw new Error('network'); });
    await pick('0', NEW, 'pattern.png');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(t('spaces.threeD.look.pictureReadFailed', { filename: 'pattern.png' })));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(lookOf(doc)).toBeUndefined();
  });

  it('names a picture without a name the way the picker shows it', async () => {
    panel();
    sizes.set(NEW, async () => ({ width: 64, height: 64, type: 'gif' }));
    await pick('0', NEW, null);
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('canvas.upload.unsupportedType', {
      filename: t('spaces.threeD.picker.unnamed'), kind: 'image', formats: uploadableFormatList('image') })));
  });
});

describe('a pick that ends after its Space or object changed', () => {
  /** A pick for part 0 whose header read waits for the returned release. */
  async function slowPick(): Promise<() => void> {
    let release: () => void = () => undefined;
    sizes.set(NEW, () => new Promise((resolve) => { release = () => resolve({ width: 64, height: 64, type: 'png' }); }));
    await pick('0', NEW);
    return () => release();
  }

  it('writes nothing and says the Space was closed', async () => {
    const { doc } = panel();
    const release = await slowPick();
    evictSceneSession(NAME);
    release();
    await flush();
    expect(lookOf(doc)).toBeUndefined();
    expect(toast.warning).toHaveBeenCalledWith(t('spaces.threeD.look.pickSpaceClosed'));
  });

  it('writes nothing and says the Space was closed when it was opened again but has not loaded yet', async () => {
    const { doc } = panel();
    const release = await slowPick();
    evictSceneSession(NAME);
    const loading = new Y.Doc();
    cleanups.push(() => loading.destroy());
    getSceneSession(loading, NAME).setEnvironment({ readOnly: false, connected: true, hasEverSynced: false, writeAccess: 'granted', refused: false, awareness: null });
    release();
    await flush();
    expect(lookOf(doc)).toBeUndefined();
    expect(toast.warning).toHaveBeenCalledWith(t('spaces.threeD.look.pickSpaceClosed'));
    expect(toast.warning).not.toHaveBeenCalledWith(t('spaces.threeD.look.pickObjectGone'));
  });

  it('puts the picture on through the Space opened again meanwhile', async () => {
    const { doc, session } = panel();
    const release = await slowPick();
    const environment = { readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted' as const, refused: false, awareness: null };
    evictSceneSession(NAME);
    getSceneSession(doc, NAME).setEnvironment(environment);
    expect(getSceneSession(doc, NAME)).not.toBe(session);
    release();
    await flush();
    expect(lookOf(doc)).toEqual({ 0: { map: NEW } });
    expect(toast.warning).not.toHaveBeenCalled();
    // The pick is the open Space's own step: undoing there takes it off.
    const reopened = getSceneSession(doc, NAME);
    expect(reopened.history.undoStack).toHaveLength(1);
    act(() => { reopened.historyStep('undo'); });
    expect(lookOf(doc)).toBeUndefined();
  });

  it.each([
    ['the Space was closed', (): void => { evictSceneSession(NAME); }, 'spaces.threeD.look.pickSpaceClosed'],
    ['the object was deleted', (doc: Y.Doc): void => { applySceneCommand(doc, { type: 'delete', ids: [ID] }, Symbol('peer'), true, NAME); }, 'spaces.threeD.look.pickObjectGone'],
  ] as const)('writes nothing and says so when %s while the other pictures were judged', async (_name, change, key) => {
    const { doc, rerender } = panel();
    applySceneCommand(doc, { type: 'look', id: ID, part: '1', set: { map: OTHER } } as never, Symbol(), true, NAME);
    rerender();
    let releaseOther: () => void = () => undefined;
    sizes.set(OTHER, () => new Promise((resolve) => { releaseOther = () => resolve({ width: 64, height: 64, type: 'png' }); }));
    sizes.set(NEW, async () => ({ width: 64, height: 64, type: 'png' }));
    await pick('0', NEW);
    await flush();
    change(doc);
    releaseOther();
    await flush();
    expect(toast.warning).toHaveBeenCalledWith(t(key));
    expect((readSceneDocument(doc).objects.find((object) => object.id === ID) as SceneObject | undefined)?.look?.[0]).toBeUndefined();
  });

  it('writes nothing and says so when the object was deleted meanwhile', async () => {
    const { doc } = panel();
    const release = await slowPick();
    applySceneCommand(doc, { type: 'delete', ids: [ID] }, Symbol('peer'), true, NAME);
    release();
    await flush();
    expect(readSceneDocument(doc).objects).toHaveLength(0);
    expect(toast.warning).toHaveBeenCalledWith(t('spaces.threeD.look.pickObjectGone'));
  });
});

describe('writing a look through the section', () => {
  it('reports whether the Space took the write, so a refused value can stay in its box', () => {
    const { doc } = panel();
    const write = (): boolean => (captured.section!.onCommand as (command: unknown) => boolean)({ type: 'look', id: ID, part: '0', set: { mapRepeat: [2, 2] } });
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true } as never, Symbol('peer'), true, NAME);
    expect(write()).toBe(false);
    expect(lookOf(doc)).toBeUndefined();
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: false } as never, Symbol('peer'), true, NAME);
    expect(write()).toBe(true);
    expect(lookOf(doc)).toEqual({ 0: { mapRepeat: [2, 2] } });
  });
});

describe('picking twice for one part', () => {
  it('keeps the later pick when the earlier one finishes checking last', async () => {
    const { doc } = panel();
    let releaseFirst: () => void = () => undefined;
    sizes.set(NEW, () => new Promise((resolve) => { releaseFirst = () => resolve({ width: 64, height: 64, type: 'png' }); }));
    sizes.set(OTHER, async () => ({ width: 64, height: 64, type: 'png' }));
    await pick('0', NEW);
    await pick('0', OTHER);
    await vi.waitFor(() => expect(lookOf(doc)).toEqual({ 0: { map: OTHER } }));
    // The part's latest pick is done, so it offers a picture again.
    expect(captured.section!.checking).toBe(false);
    await act(async () => { releaseFirst(); await Promise.resolve(); await Promise.resolve(); });
    expect(lookOf(doc)).toEqual({ 0: { map: OTHER } });
  });

  it('keeps a pick made after the panel was opened again over an earlier one still checking', async () => {
    const { doc, reopen } = panel();
    let releaseFirst: () => void = () => undefined;
    sizes.set(NEW, () => new Promise((resolve) => { releaseFirst = () => resolve({ width: 64, height: 64, type: 'png' }); }));
    sizes.set(OTHER, async () => ({ width: 64, height: 64, type: 'png' }));
    await pick('0', NEW);
    reopen();
    await pick('0', OTHER);
    await vi.waitFor(() => expect(lookOf(doc)).toEqual({ 0: { map: OTHER } }));
    releaseFirst();
    await flush();
    expect(lookOf(doc)).toEqual({ 0: { map: OTHER } });
  });
});

describe('a part row waiting for its uploaded picture', () => {
  it('shows the upload until the stored picture shows on the part, then offers the part again', async () => {
    uploadMedia.mockResolvedValue({ assetId: NEW, url: 'https://assets.example.test/u.png' });
    const { doc, rerender } = panel();
    act(() => { (captured.section!.onChoosePicture as (part: string) => void)('0'); });
    // jsdom's File has no stream(); the header read is mocked above.
    const file = Object.assign(new File(['x'], 'pattern.png', { type: 'image/png' }), { stream: () => new ReadableStream() });
    await act(async () => { (captured.picker!.onPickFile as (file: File) => void)(file); });
    await flush();
    expect((captured.section!.uploadPercentOf as (part: string) => number | null)('0')).toBe(100);
    applySceneCommand(doc, { type: 'look', id: ID, part: '0', set: { map: NEW } } as never, Symbol(), true, NAME);
    rerender();
    expect((captured.section!.uploadPercentOf as (part: string) => number | null)('0')).toBeNull();
  });
});
