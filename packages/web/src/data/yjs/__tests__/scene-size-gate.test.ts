// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-93 to W-96 and W-143: the 3D Space.
 *
 * Until inner#1875 lands, 3D only adds, so every command is refused once the
 * Space is full and nothing is judged by estimate below that. The check sits
 * after the read-only check in `planSceneCommand` and at the top of
 * `historyStep`; an unknown size allows, a rebuild refuses.
 *
 * Commands are driven through `SceneSession.execute`, the production caller
 * of `applySceneCommand`, so the tests do not depend on where the document
 * name lands in that function's parameter list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SCENE_FORMAT_VERSION } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { planSceneCommand, readSceneDocument, type SceneCommand } from '@web/data/yjs/scene-document';
import { evictSceneSession, getSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { latestProvider, openSizedDoc, pushSize, refuseTooLarge } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import { COPY_EN, F_FULL, F_NORMAL, F_WARNING, F_WARNING_TIGHT, type DocSizePush } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p1';
const SID = 's1';
const NAME = docName.threeDSpace(PID, SID);
const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
const COPY = '33333333-3333-4333-8333-333333333333';

/**
 * A valid builtin scene object.
 * @param id - Object id.
 * @param name - Object name.
 * @returns The object.
 */
function object(id: string, name = 'Figure'): { id: string; name: string; model: { kind: 'builtin'; id: 'figure' }; position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number]; locked: boolean } {
  return { id, name, model: { kind: 'builtin', id: 'figure' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
}

/**
 * Writes the scene format and one object o1 straight into the document, as
 * already-synced content (no command, so no gate is involved).
 * @param doc - The scene document.
 * @throws {Error} When the write fails.
 */
function seedScene(doc: Y.Doc): void {
  doc.transact(() => {
    doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
    const { id, ...values } = object(O1);
    doc.getMap<unknown>('objects').set(id, new Y.Map<unknown>(Object.entries(values)));
  });
}

/**
 * The editing session of the document, editable as for a synced editor.
 * @param doc - The scene document.
 * @returns The session.
 */
function editableSession(doc: Y.Doc): SceneSession {
  const session = getSceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  return session;
}

/**
 * A seeded 3D Space with an editable session, optionally after one push.
 * @param push - The size push, or null for none.
 * @returns The document and its session.
 * @throws {Error} When seeding fails.
 */
function sceneAt(push: DocSizePush | null): { doc: Y.Doc; session: SceneSession } {
  const { doc, provider } = openSizedDoc(NAME);
  seedScene(doc);
  if (push) pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
  return { doc, session: editableSession(doc) };
}

const COMMANDS: ReadonlyArray<readonly [string, SceneCommand]> = [
  ['create', { type: 'create', objects: [object(O2)] }],
  ['duplicate', { type: 'duplicate', copies: [{ sourceId: O1, id: COPY }] }],
  ['patch', { type: 'patch', patches: [{ id: O1, name: 'Renamed' }] }],
  ['lock', { type: 'lock', ids: [O1], locked: true }],
  ['delete', { type: 'delete', ids: [O1] }],
];

beforeEach(() => {
  sizeGateProviders.length = 0;
});

afterEach(() => {
  evictSceneSession(NAME);
  _resetCollabSocketForTests();
  _resetForTests();
  vi.clearAllMocks();
});

describe('W-93 the read-only check comes before the size check', () => {
  it('answers readOnly for a viewer of a full Space', () => {
    const { doc } = sceneAt(F_FULL);
    expect(planSceneCommand(doc, NAME, { type: 'create', objects: [object(O2)] }, false)).toEqual({ ok: false, reason: 'readOnly' });
  });
});

describe('W-94 every 3D command is refused once the Space is full', () => {
  it.each(COMMANDS)('%s answers full and leaves the document unchanged', (_name, command) => {
    const { doc, session } = sceneAt(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    expect(session.execute(command)).toEqual({ ok: false, reason: 'full' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readSceneDocument(doc).objects).toEqual([object(O1)]);
  });
});

describe('W-95 below full, 3D commands go through without an estimate', () => {
  it.each([['warning', F_WARNING], ['warning with one byte left', F_WARNING_TIGHT]] as const)('creates and patches at %s', (_label, push) => {
    const { doc, session } = sceneAt(push);
    expect(session.execute({ type: 'create', objects: [object(O2)] })).toEqual({ ok: true, ids: [O2] });
    expect(session.execute({ type: 'patch', patches: [{ id: O1, name: 'Renamed' }] })).toEqual({ ok: true, ids: [O1] });
    expect(Object.fromEntries(readSceneDocument(doc).objects.map((o) => [o.id, o.name]))).toEqual({ [O1]: 'Renamed', [O2]: 'Figure' });
  });
});

describe('W-96 historyStep returns early once the Space is full', () => {
  it('refuses undo and redo without touching the history', () => {
    const { doc, session } = sceneAt(F_NORMAL);
    expect(session.execute({ type: 'create', objects: [object(O2)] })).toEqual({ ok: true, ids: [O2] });
    pushSize(latestProvider(NAME), F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    const undo = vi.spyOn(session.history, 'undo');
    const redo = vi.spyOn(session.history, 'redo');
    expect(session.historyStep('undo')).toEqual({ ok: false, reason: 'full' });
    expect(session.historyStep('redo')).toEqual({ ok: false, reason: 'full' });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(readSceneDocument(doc).objects.some((o) => o.id === O2)).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(session.getSnapshot().commandError).toEqual({ ok: false, reason: 'full' });
  });

  it('undoes as before below full', () => {
    const { doc, session } = sceneAt(F_NORMAL);
    session.execute({ type: 'create', objects: [object(O2)] });
    expect(session.historyStep('undo')).toEqual({ ok: true, ids: expect.any(Array) });
    expect(readSceneDocument(doc).objects.some((o) => o.id === O2)).toBe(false);
  });
});

describe('W-143 unknown size allows, a rebuild refuses', () => {
  it('(a) creates and deletes before any push', () => {
    const { doc, session } = sceneAt(null);
    expect(session.execute({ type: 'create', objects: [object(O2)] })).toEqual({ ok: true, ids: [O2] });
    expect(session.execute({ type: 'delete', ids: [O1] })).toEqual({ ok: true, ids: [O1] });
    expect(readSceneDocument(doc).objects.map((o) => o.id)).toEqual([O2]);
  });

  it('(b) refuses every command and history step on the rebuilt document until it syncs', () => {
    const { provider } = openSizedDoc(NAME);
    seedScene(getDoc(NAME));
    pushSize(provider, F_NORMAL);
    vi.mocked(toast.warning).mockClear();
    refuseTooLarge(provider);
    const { doc: fresh, provider: replacement } = openSizedDoc(NAME);
    expect(replacement).not.toBe(provider);
    seedScene(fresh);
    const session = editableSession(fresh);
    const before = Y.encodeStateAsUpdate(fresh);
    expect(session.execute({ type: 'create', objects: [object(O2)] })).toEqual({ ok: false, reason: 'full' });
    expect(session.execute({ type: 'patch', patches: [{ id: O1, name: 'Renamed' }] })).toEqual({ ok: false, reason: 'full' });
    expect(session.execute({ type: 'delete', ids: [O1] })).toEqual({ ok: false, reason: 'full' });
    expect(session.historyStep('undo')).toEqual({ ok: false, reason: 'full' });
    expect(Y.encodeStateAsUpdate(fresh)).toEqual(before);
    const messages = vi.mocked(toast.warning).mock.calls.map(([message]) => message);
    expect(messages).toEqual([COPY_EN.T_RESYNC]);
  });
});
