// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 17: a viewer of a full Space never hears about its size (V-01 to V-03).
 *
 * The read-only checks that already stop every write of a viewer run first,
 * so none of the size sentences shows and nothing reaches Yjs. The canvas is
 * mounted for a viewer on the real document (binding hook real, socket stood
 * in for); the document body is the real editor, not editable; the 3D Space
 * is the real session in a read-only environment.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type * as React from 'react';
import type * as SpaceConnectionModule from '@web/data/yjs/space-connection';
import { SCENE_FORMAT_VERSION, encodeInitialSpaceContent } from '@breatic/shared';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: {
    warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(),
    loading: vi.fn(), promise: vi.fn(), dismiss: vi.fn(), custom: vi.fn(),
  },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({
    provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null,
  })),
}));
vi.mock('@web/data/yjs/space-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof SpaceConnectionModule>();
  const { useSocket } = await import('@web/data/yjs/use-socket');
  return { ...actual, useSpaceConnection: () => useSocket({ name: '', doc: undefined as never }) };
});
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock('@web/data/api/users', () => ({ usersApi: { getByIds: () => Promise.resolve([]) } }));

import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { assetsApi } from '@web/data/api';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { evictSceneSession, getSceneSession } from '@web/data/yjs/scene-session';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { useUIStore } from '@web/stores';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCurrentUserStore } from '@web/stores/current-user';
import { enterSize, localUpdate } from '@web/data/yjs/__tests__/helpers/history-fork-harness';
import { COPY_V2_EN, P_FULL } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = 'p';
const SID = 's';
const CANVAS = docName.canvasSpace(PID, SID);
const DOCUMENT = docName.documentSpace(PID, SID);
const SOURCE = docName.documentSpace(PID, 'source');
const SCENE = docName.threeDSpace(PID, SID);

/** Every size sentence a toast could carry (spec 0.5), in English. */
const SIZE_SENTENCES = new Set<string>(
  Object.values(COPY_V2_EN).filter((value): value is Extract<typeof value, string> => typeof value === 'string'),
);

/**
 * The size sentences shown as warnings so far.
 * @returns Their texts.
 */
function sizeToasts(): unknown[] {
  return vi.mocked(toast.warning).mock.calls.map(([text]) => text).filter((text) => typeof text === 'string' && SIZE_SENTENCES.has(text));
}

const containers: HTMLElement[] = [];
let picker: MockInstance;

beforeEach(() => {
  changeLocale('en');
  useUIStore.setState({ activeRegion: 'space' });
  canvasSessions.of(SID).setState({ panelHostId: null, panelKind: null, pickSession: null });
  useCurrentUserStore.getState().setUser({ id: 'u-1', name: 'Ada', email: 'ada@example.com', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue({
    maxUploadBytes: 2147483648,
    clientMaxAttempts: 1,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 60000,
    uploadStatusPollSeconds: 2,
    assetUrlPrefix: 'https://cdn/',
  });
  picker = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetDocumentEditorCacheForTests();
  containers.splice(0).forEach((container) => { container.remove(); });
  evictSceneSession(SCENE);
  _resetCanvasUndoCacheForTests();
  clearAllDocSizes();
  _resetForTests();
});

/**
 * A key press at the focused element, as a browser aims it.
 * @param key - `KeyboardEvent.key`.
 * @param target - Where it lands; the focused element by default.
 */
function press(key: string, target?: Element): void {
  act(() => {
    (target ?? document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

describe('V-01 a viewer on a full canvas', () => {
  it('V-01 Delete on a selected node and a double-click to upload say nothing about size and write nothing', () => {
    const base = { createdAt: 1, createdBy: 'u1', locked: false, attachments: [] };
    addNode(PID, SID, { id: 'e1', type: 'image', position: { x: 0, y: 0 }, data: { name: 'e1', ...base } });
    addNode(PID, SID, { id: 't1', type: 'text', position: { x: 600, y: 0 }, data: { name: 't1', ...base } });
    const doc = getDoc(CANVAS);
    enterSize(CANVAS, P_FULL);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <div data-region='space'>
          <CanvasSpace projectId={PID} spaceId={SID} readOnly />
        </div>
      </QueryClientProvider>,
    );
    const nodeOf = (id: string): HTMLElement => {
      const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      if (!el) throw new Error(`node ${id} is not rendered`);
      return el;
    };
    const before = Y.encodeStateAsUpdate(doc);

    const update = localUpdate(doc, () => {
      act(() => { nodeOf('t1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
      press('Delete', nodeOf('t1'));
      press('Backspace', nodeOf('t1'));
      act(() => {
        const target = nodeOf('e1').querySelector('[data-testid="node-placeholder"]') ?? nodeOf('e1');
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      });
    });

    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap('nodesMap').has('t1')).toBe(true);
    expect(picker).not.toHaveBeenCalled();
    expect(sizeToasts()).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('V-02 a viewer on a full document', () => {
  it('V-02 the body is not editable; typing, deleting and pasting say nothing about size and write nothing', () => {
    const doc = getDoc(DOCUMENT);
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    const inputs = (editable: boolean, d: Y.Doc): Parameters<typeof getDocumentEditor>[2] => ({
      caretProvider: { awareness: new Awareness(d) },
      readWho: () => ({ role: editable ? 'owner' : 'viewer', viewerId: 'u1' }),
      editable,
    });
    const handle = getDocumentEditor(doc, DOCUMENT, inputs(false, doc));
    const container = document.createElement('div');
    document.body.appendChild(container);
    containers.push(container);
    adoptDocumentEditor(handle, container);
    // The content arrives as a remote update written by a second editor.
    const source = getDoc(SOURCE);
    Y.applyUpdate(source, Y.encodeStateAsUpdate(doc));
    const writer = getDocumentEditor(source, SOURCE, inputs(true, source));
    const writerBox = document.createElement('div');
    document.body.appendChild(writerBox);
    containers.push(writerBox);
    adoptDocumentEditor(writer, writerBox);
    act(() => { writer.editor.replaceBlocks(writer.editor.document, [{ type: 'paragraph', content: 'hello' } as never, { type: 'paragraph', content: '' } as never]); });
    act(() => { Y.applyUpdate(doc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(doc)), 'remote'); });
    enterSize(DOCUMENT, P_FULL);
    const view = handle.editor.prosemirrorView;
    expect(handle.editor.isEditable).toBe(false);
    expect(view.dom.getAttribute('contenteditable')).toBe('false');
    const before = Y.encodeStateAsUpdate(doc);

    const update = localUpdate(doc, () => {
      for (const key of ['a', 'Enter', 'Backspace', 'Delete']) press(key, view.dom);
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        configurable: true,
        value: { getData: (type: string): string => (type === 'text/plain' ? 'pasted words' : ''), files: [], types: ['text/plain'] },
      });
      act(() => { view.dom.dispatchEvent(paste); });
    });

    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(sizeToasts()).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('V-03 a viewer on a full 3D Space', () => {
  it('V-03 a patch is refused as read-only, with no size toast', () => {
    const doc = getDoc(SCENE);
    const id = '11111111-1111-4111-8111-111111111111';
    doc.transact(() => {
      doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
      doc.getMap<unknown>('objects').set(id, new Y.Map<unknown>(Object.entries({
        name: 'Figure', model: { kind: 'builtin', id: 'figure' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false,
      })));
    }, 'setup');
    const session = getSceneSession(doc, SCENE);
    session.setEnvironment({ readOnly: true, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
    enterSize(SCENE, P_FULL);
    vi.mocked(toast.warning).mockClear();
    const before = Y.encodeStateAsUpdate(doc);

    const result = session.execute({ type: 'patch', patches: [{ id, name: 'Renamed' }] });

    expect(result).toEqual({ ok: false, reason: 'readOnly' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readSceneDocument(doc).objects.map((object) => object.name)).toEqual(['Figure']);
    expect(sizeToasts()).toEqual([]);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
