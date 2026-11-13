// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The director console in the 3D Space (inner#1694): the panel, its cameras,
 * lights and ambient light, looking through a camera and the Escape order.
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
import { useUIStore } from '@web/stores/ui';

type Viewport = SceneViewportProps & {
  cameraView?: { kind: string; id?: string; canPilot?: boolean } | null;
  onLightPlan?: (plan: { defaultKey: boolean; lights: Record<string, { enabled: boolean; castsShadow: boolean; note: string | null }> }) => void;
};
const h = vi.hoisted(() => ({
  viewport: null as null | Viewport,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/scene')>()),
  listSpaceTasks: vi.fn(async () => ({ serverNow: new Date().toISOString(), tasks: [] })),
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1, import: IMPORT_LIMITS, progressPublishMs: 1000,
    capture: { longEdgePx: 2048, minFramePx: 120, canvasSyncTimeoutMs: 10000 },
    director: { monitorRefreshMs: 200, maxLights: 16, wheelCommitMs: 400, shadowMapPx: 2048, pointShadowMapPx: 512, shadowGroundReach: 3, shadowBias: -0.0005, shadowNormalBias: 0.02, pointShadowBias: -0.002, pointShadowNormalBias: 0.02 } })),
  resolveSceneAsset: vi.fn(),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: function MockViewport(props: SceneViewportProps): React.JSX.Element {
    h.viewport = props as Viewport;
    React.useEffect(() => {
      for (const object of props.objects) props.onModelStateChange?.(object.id, 'ready');
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, like the runtime
    }, []);
    return <canvas tabIndex={0} data-testid='scene-native-boundary' />;
  },
}));
vi.mock('@web/lib/scene-view-storage', () => ({ readSceneView: () => null, writeSceneView: () => true }));
vi.mock('@web/lib/toast', () => ({ toast: h.toast }));

const NAME = 'project-p1/3d-s1';
const BOX = '11111111-1111-4111-8111-111111111111';
const CAM = '00000000-0000-4000-8000-000000000001';
const LAMP = '00000000-0000-4000-8000-000000001001';
const POSE = { position: [0, 1, 4] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number], locked: false };
const camera = (id = CAM, n = 1, extra: Record<string, unknown> = {}): SceneObject => ({ id, name: `Camera ${n}`, model: { kind: 'camera' }, ...POSE, number: n, focalLength: 35, frame: '16:9', ...extra } as unknown as SceneObject);
const lamp = (id = LAMP, n = 1, type = 'point', extra: Record<string, unknown> = {}): SceneObject => ({ id, name: `Light ${n}`, model: { kind: 'light', type }, ...POSE, number: n, color: '#ffffff', intensity: 1, castShadow: true, ...(type === 'spot' ? { angle: 30 } : {}), ...extra } as unknown as SceneObject);
const owners: Array<{ doc: Y.Doc; session: SceneSession; client: QueryClient }> = [];

/**
 * The editor bound to a live session.
 * @param root0 - Props.
 * @param root0.session - The session.
 * @param root0.myRole - The member's role.
 * @returns The editor.
 */
function Bound({ session, myRole }: { session: SceneSession; myRole: 'editor' | 'viewer' }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <SceneEditor projectId='project' spaceId='scene' myRole={myRole} userId='alice' session={session} snapshot={snapshot}
    connection={{ status: 'connected', synced: true }} namedPeers={[]}
    readObjects={() => readSceneDocument(session.doc).objects} ownsKeyboard={() => true} UnlockIcon={Unlock} />;
}

/**
 * Render the editor with a box and the given director records.
 * @param records - Cameras and lights to start with.
 * @param myRole - The member's role.
 * @returns The session.
 */
async function setup(records: readonly SceneObject[] = [], myRole: 'editor' | 'viewer' = 'editor'): Promise<{ session: SceneSession }> {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const objects: SceneObject[] = [{ id: BOX, name: 'Box', model: { kind: 'builtin', id: 'box' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }, ...records];
  (applySceneCommand as unknown as (...args: unknown[]) => unknown)(doc, { type: 'create', objects }, Symbol('fixture'), true, NAME, { maxLights: 64 });
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: myRole === 'viewer', connected: true, hasEverSynced: true, writeAccess: myRole === 'viewer' ? 'denied' : 'granted', refused: false, awareness: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
  render(<QueryClientProvider client={client}><TooltipProvider><div data-space-outlet='scene'><Bound session={session} myRole={myRole} /></div></TooltipProvider></QueryClientProvider>);
  await screen.findByTestId('scene-native-boundary');
  return { session };
}

const directorTrigger = (): HTMLElement => screen.getByTestId('scene-director-trigger');
const panel = (): HTMLElement => screen.getByTestId('scene-right-panel');
const header = (): HTMLElement => screen.getByTestId('scene-panel-header');
const label = (key: string): string => t(`spaces.threeD.director.${key}`);

/**
 * Open the director console and wait for its panel.
 * @returns The panel.
 */
async function openDirector(): Promise<HTMLElement> {
  fireEvent.click(directorTrigger());
  await screen.findByTestId('scene-right-panel');
  return panel();
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  Object.values(h.toast).forEach((fn) => fn.mockReset());
  h.viewport = null;
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); owner.client.clear(); }
  useUIStore.getState().setActiveOverlayId(null);
  vi.restoreAllMocks();
});

describe('the director console panel (inner#1694 design 3.1, 3.2)', () => {
  it('opens from the viewport toolbar and shows both empty states', async () => {
    await setup();
    expect(directorTrigger()).toHaveAccessibleName(label('open'));
    const opened = await openDirector();
    expect(header()).toHaveTextContent(label('open'));
    expect(opened).toHaveTextContent(label('camerasEmpty'));
    expect(opened).toHaveTextContent(label('lightsEmpty'));
    fireEvent.click(directorTrigger());
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
  });

  it('saves the current view as Camera 1 in 16:9 and shows its card with a placeholder until drawn', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    fireEvent.click(within(opened).getByRole('button', { name: label('saveView') }));
    // Saving loads the camera geometry on demand, so the camera is written a moment later.
    const saved = await waitFor(() => {
      const camera = readSceneDocument(session.doc).objects.find((object) => object.model.kind === ('camera' as never)) as unknown as Record<string, unknown> | undefined;
      expect(camera).toBeDefined();
      return camera;
    });
    expect(saved).toMatchObject({ number: 1, name: t('spaces.threeD.director.cameraName', { n: 1 }), frame: '16:9' });
    const card = await screen.findByTestId(`scene-director-camera-${saved?.id as string}`);
    expect(within(card).getByTestId(`scene-director-monitor-${saved?.id as string}`).querySelector('.skeleton-shimmer')).not.toBeNull();
  });

  it('lists cameras and lights by number and keeps the console open when something is selected', async () => {
    const { session } = await setup([camera(CAM, 2), camera('00000000-0000-4000-8000-000000000009', 1), lamp()]);
    const opened = await openDirector();
    const cards = within(opened).getAllByTestId(/^scene-director-camera-/);
    expect(cards.map((card) => card.dataset.testid)).toEqual(['scene-director-camera-00000000-0000-4000-8000-000000000009', `scene-director-camera-${CAM}`]);
    act(() => session.select(BOX, false));
    expect(header()).toHaveTextContent(label('open'));
    act(() => session.select(LAMP, false));
    expect(header()).toHaveTextContent(label('open'));
    expect(within(screen.getByTestId(`scene-director-light-${LAMP}`).parentElement as HTMLElement).getByText(t('spaces.threeD.intensity'))).toBeInTheDocument();
  });

  it('opens a camera inline with its focal length and frame', async () => {
    const { session } = await setup([camera()]);
    await openDirector();
    act(() => session.select(CAM, false));
    const card = screen.getByTestId(`scene-director-camera-${CAM}`).parentElement as HTMLElement;
    expect(within(card).getByText(t('spaces.threeD.focalLength'))).toBeInTheDocument();
    expect(within(card).getByText(t('spaces.threeD.frame'))).toBeInTheDocument();
  });

  it('shows the over-limit and shadow-budget notes the viewport reports', async () => {
    const second = '00000000-0000-4000-8000-000000001002';
    await setup([lamp(), lamp(second, 2)]);
    await openDirector();
    act(() => h.viewport?.onLightPlan?.({ defaultKey: false, lights: {
      [LAMP]: { enabled: true, castsShadow: false, note: 'shadowBudget' },
      [second]: { enabled: false, castsShadow: false, note: 'overLimit' },
    } }));
    expect(screen.getByTestId(`scene-director-light-${LAMP}`)).toHaveTextContent(label('shadowBudget'));
    expect(screen.getByTestId(`scene-director-light-${second}`)).toHaveTextContent(label('lightOverLimit'));
  });

  it('disables adding a light at the limit', async () => {
    await setup(Array.from({ length: 16 }, (_, i) => lamp(`00000000-0000-4000-8000-${String(2000 + i).padStart(12, '0')}`, i + 1)));
    const opened = await openDirector();
    fireEvent.pointerDown(within(opened).getByRole('button', { name: label('addLight') }), { button: 0, ctrlKey: false });
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(3);
    for (const item of items) expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('lets a Viewer watch but not add cameras or lights', async () => {
    await setup([camera()], 'viewer');
    const opened = await openDirector();
    expect(within(opened).getByRole('button', { name: label('saveView') })).toBeDisabled();
    expect(within(opened).getByRole('button', { name: label('addLight') })).toBeDisabled();
    expect(screen.getByTestId(`scene-director-monitor-${CAM}`)).toBeEnabled();
  });
});

describe('looking through a camera from the console (design 3.4, 3.8)', () => {
  it('replaces Cancel with Exit camera and hands the viewport a live camera view', async () => {
    await setup([camera()]);
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    const menu = screen.getByTestId('scene-viewfinder-menu');
    expect(within(menu).getByRole('button', { name: label('exitCamera') })).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: t('spaces.threeD.viewfinder.cancel') })).toBeNull();
    expect(h.viewport?.cameraView).toEqual({ kind: 'live', id: CAM, canPilot: true });
  });

  it('gives a locked camera a view that cannot be piloted', async () => {
    const { session } = await setup([camera()]);
    act(() => { session.execute({ type: 'lock', ids: [CAM], locked: true }); });
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    expect(h.viewport?.cameraView).toEqual({ kind: 'live', id: CAM, canPilot: false });
  });

  it('leaves the camera on the first Escape and keeps the console open', async () => {
    await setup([camera()]);
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    fireEvent.keyDown(screen.getByTestId('scene-native-boundary'), { key: 'Escape' });
    expect(screen.queryByTestId('scene-viewfinder-menu')).toBeNull();
    expect(h.viewport?.cameraView ?? null).toBeNull();
    expect(screen.getByTestId('scene-right-panel')).toBeInTheDocument();
    expect(header()).toHaveTextContent(label('open'));
  });

  it('leaves the camera when it is deleted and says so', async () => {
    const { session } = await setup([camera()]);
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    act(() => { (applySceneCommand as unknown as (...args: unknown[]) => unknown)(session.doc, { type: 'delete', ids: [CAM] }, Symbol('peer'), true, NAME, { maxLights: 16 }); });
    await waitFor(() => expect(h.viewport?.cameraView ?? null).toBeNull());
    expect(screen.queryByTestId('scene-viewfinder-menu')).toBeNull();
  });
});

describe('the object toolbar with cameras and lights (design 3.3)', () => {
  const tool = (key: string): HTMLElement => within(screen.getByTestId('scene-object-menu')).getByRole('button', { name: t(`spaces.threeD.${key}`) });

  it('disables scale for any camera or light and rotate for a point light, falling back to move', async () => {
    const { session } = await setup([camera(), lamp()]);
    act(() => session.select(BOX, false));
    fireEvent.click(tool('scale'));
    expect(h.viewport?.mode).toBe('scale');
    act(() => session.select(CAM, true));
    expect(tool('scale')).toBeDisabled();
    expect(tool('rotate')).toBeEnabled();
    expect(h.viewport?.mode).toBe('translate');
    act(() => session.select(LAMP, true));
    expect(tool('rotate')).toBeDisabled();
  });
});
