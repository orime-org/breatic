// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Repeated presses in the 3D viewfinder (#1411 implementation review round 1):
 * a canvas entry pressed again before the list closes, and
 * Capture pressed again, or the viewfinder reopened, while a capture runs.
 */

import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { t, SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';
import SceneEditor from '@web/spaces/three-d/SceneEditor';

const h = vi.hoisted(() => ({
  capture: vi.fn(),
  placeImageOnCanvas: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/scene')>()),
  listSpaceTasks: vi.fn(async () => ({ serverNow: new Date().toISOString(), tasks: [] })),
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1, import: IMPORT_LIMITS, progressPublishMs: 1000,
    capture: { longEdgePx: 2048, minFramePx: 120, canvasSyncTimeoutMs: 10000 } })),
  resolveSceneAsset: vi.fn(),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: function MockViewport(props: SceneViewportProps): React.JSX.Element {
    React.useEffect(() => {
      props.onCapture?.(h.capture);
      for (const object of props.objects) props.onModelStateChange?.(object.id, 'ready');
      return () => props.onCapture?.(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, like the runtime
    }, []);
    return <canvas tabIndex={0} data-testid='scene-native-boundary' />;
  },
}));
vi.mock('@web/lib/scene-view-storage', () => ({ readSceneView: () => null, writeSceneView: () => true }));
vi.mock('@web/lib/toast', () => ({ toast: h.toast }));
vi.mock('@web/data/yjs/project-meta', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/yjs/project-meta')>()),
  useProjectSpaceList: () => [{ id: 'c1', name: 'Board', type: 'canvas', createdAt: 1 }],
}));
vi.mock('@web/spaces/canvas/place-image-on-canvas', () => ({ placeImageOnCanvas: h.placeImageOnCanvas }));
vi.mock('@web/spaces/three-d/viewfinder/encode-capture', () => ({
  encodeCapturePng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}));
const NAME = 'project-p1/3d-s1';
const ID = '11111111-1111-4111-8111-111111111111';
const owners: Array<{ doc: Y.Doc; session: SceneSession; client: QueryClient }> = [];

/**
 * The editor bound to a live session.
 * @param root0 - Props.
 * @param root0.session - The session.
 * @returns The editor.
 */
function Bound({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <SceneEditor projectId='project' spaceId='scene' myRole='editor' userId='alice' session={session} snapshot={snapshot}
    connection={{ status: 'connected', synced: true }} namedPeers={[]}
    readObjects={() => readSceneDocument(session.doc).objects} ownsKeyboard={() => true} UnlockIcon={Unlock} />;
}

/** Render the editor with one box. */
async function setup(): Promise<void> {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const objects: SceneObject[] = [{ id: ID, name: 'Box', model: { kind: 'builtin', id: 'box' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }];
  applySceneCommand(doc, { type: 'create', objects }, Symbol('fixture'), true, NAME);
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
  render(<QueryClientProvider client={client}><TooltipProvider><div data-space-outlet='scene'><Bound session={session} /></div></TooltipProvider></QueryClientProvider>);
  await screen.findByTestId('scene-native-boundary');
}

const trigger = (): HTMLElement => screen.getByTestId('scene-viewfinder-trigger');
const menu = (): HTMLElement => screen.getByTestId('scene-viewfinder-menu');
const button = (key: string): HTMLElement => within(menu()).getByRole('button', { name: t(`spaces.threeD.viewfinder.${key}`) });
const PIXELS = { width: 2048, height: 1152, pixels: new Uint8Array(4) };

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  h.capture.mockReset().mockResolvedValue(PIXELS);
  h.placeImageOnCanvas.mockReset().mockReturnValue(new Promise(() => undefined));
  Object.values(h.toast).forEach((fn) => fn.mockReset());
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); owner.client.clear(); }
  vi.restoreAllMocks();
});

describe('repeated presses in the viewfinder', () => {
  it('places one image when a canvas entry is pressed twice', async () => {
    await setup();
    fireEvent.click(trigger());
    fireEvent.click(button('confirm'));
    await within(menu()).findByRole('button', { name: t('spaces.threeD.viewfinder.toCanvas') });
    fireEvent.click(button('toCanvas'));
    // Both presses land before React re-renders, as a second press does while the list animates out.
    const entry = within(screen.getByTestId('scene-viewfinder-canvas-list')).getByRole('button', { name: 'Board' });
    act(() => { entry.click(); entry.click(); });
    await waitFor(() => expect(h.placeImageOnCanvas).toHaveBeenCalled());
    expect(h.placeImageOnCanvas).toHaveBeenCalledTimes(1);
  });

  it('captures once when Capture is pressed twice', async () => {
    let finish: (value: typeof PIXELS) => void = () => undefined;
    h.capture.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await setup();
    fireEvent.click(trigger());
    act(() => { button('confirm').click(); button('confirm').click(); });
    await act(async () => { finish(PIXELS); await Promise.resolve(); });
    await within(menu()).findByRole('button', { name: t('spaces.threeD.viewfinder.toAgent') });
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it('drops a capture that finishes after the viewfinder was closed and reopened', async () => {
    let finish: (value: typeof PIXELS) => void = () => undefined;
    h.capture.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await setup();
    fireEvent.click(trigger());
    fireEvent.click(button('confirm'));
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    await act(async () => { finish(PIXELS); await Promise.resolve(); await Promise.resolve(); });
    expect(button('confirm')).toBeInTheDocument();
  });
});
