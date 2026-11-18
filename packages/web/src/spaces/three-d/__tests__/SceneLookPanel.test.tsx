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

import { SCENE_FORMAT_VERSION, getLocale, t, type SceneObject } from '@breatic/shared';

import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import { SceneLookPanel } from '@web/spaces/three-d/SceneLookPanel';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import { uploadBytes } from '@web/spaces/three-d/model-texture-metadata';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));
type SizeOf = () => Promise<{ width: number; height: number; type: string } | null>;
const sizes = vi.hoisted(() => new Map<string, SizeOf>());
vi.mock('@web/spaces/three-d/viewport/look-texture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/spaces/three-d/viewport/look-texture-cache')>()),
  pageLookTextureCache: () => ({ size: (assetId: string) => sizes.get(assetId)?.() ?? Promise.resolve(null) }),
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
afterEach(() => { cleanup(); cleanups.splice(0).forEach((done) => done()); sizes.clear(); vi.clearAllMocks(); });

/** A panel on a scene with one figure, and its document. */
function panel(): { doc: Y.Doc; session: SceneSession; rerender: () => void } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol(), true, NAME);
  const awareness = new Awareness(doc);
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness });
  cleanups.push(() => { session.destroy(); awareness.destroy(); doc.destroy(); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  /** The panel for the object as it is now. */
  const view = (): React.JSX.Element => <QueryClientProvider client={client}>
    <SceneLookPanel session={session} object={session.getSnapshot().objects[0] as SceneObject} report={REPORT as never} projectId='p1' spaceId='s1'
      limits={IMPORT_LIMITS} mutable selectedPart='0' onSelectPart={vi.fn()} />
  </QueryClientProvider>;
  const result = render(view());
  return { doc, session, rerender: () => result.rerender(view()) };
}

/** Choose a picture for a part through the picker. */
async function pick(part: string, assetId: string, displayName = 'pattern.png'): Promise<void> {
  act(() => { (captured.section!.onChoosePicture as (part: string) => void)(part); });
  await act(async () => { (captured.picker!.onPick as (image: unknown) => void)({ assetId, displayName }); await Promise.resolve(); });
}

/** The object's look. */
const lookOf = (doc: Y.Doc): unknown => (readSceneDocument(doc).objects[0] as { look?: unknown }).look;

describe('picking a Project picture for a part', () => {
  it('names the formats a part takes when the picture is not PNG, JPEG or WebP, and writes nothing', async () => {
    const { doc } = panel();
    sizes.set(NEW, async () => ({ width: 64, height: 64, type: 'gif' }));
    await pick('0', NEW, 'clip.gif');
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('canvas.upload.unsupportedType', { filename: 'clip.gif', kind: 'image', formats: 'PNG, JPEG, WebP' })));
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
