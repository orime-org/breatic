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
import { getSceneControls } from '@web/data/api/scene';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import { useUIStore } from '@web/stores/ui';
import { ownsSceneKeyboard } from '@web/spaces/three-d/ThreeDSpace';

type Viewport = SceneViewportProps & {
  cameraView?: { kind: string; id?: string; canPilot?: boolean } | null;
  onLightPlan?: (plan: { defaultKey: boolean; lights: Record<string, { enabled: boolean; castsShadow: boolean; note: string | null }> }) => void;
};
const h = vi.hoisted(() => ({
  viewport: null as null | Viewport,
  capture: vi.fn(),
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
      props.onCapture?.(h.capture);
      for (const object of props.objects) props.onModelStateChange?.(object.id, 'ready');
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, like the runtime
    }, []);
    return <canvas tabIndex={0} data-testid='scene-native-boundary' />;
  },
}));
vi.mock('@web/lib/scene-view-storage', () => ({ readSceneView: () => null, writeSceneView: () => true }));
vi.mock('@web/lib/toast', () => ({ toast: h.toast }));
vi.mock('@web/spaces/three-d/viewfinder/encode-capture', () => ({
  encodeCapturePng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}));

const NAME = 'project-p1/3d-s1';
const BOX = '11111111-1111-4111-8111-111111111111';
const CAM = '00000000-0000-4000-8000-000000000001';
const LAMP = '00000000-0000-4000-8000-000000001001';
const LAMP2 = '00000000-0000-4000-8000-000000001002';
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
function Bound({ session, myRole, ownsKeyboard }: { session: SceneSession; myRole: 'editor' | 'viewer'; ownsKeyboard: (target: EventTarget | null) => boolean }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <SceneEditor projectId='project' spaceId='scene' myRole={myRole} userId='alice' session={session} snapshot={snapshot}
    connection={{ status: 'connected', synced: true }} namedPeers={[]}
    readObjects={() => readSceneDocument(session.doc).objects} ownsKeyboard={ownsKeyboard} UnlockIcon={Unlock} />;
}

/**
 * Render the editor with a box and the given director records.
 * @param records - Cameras and lights to start with.
 * @param myRole - The member's role.
 * @param viewport - Whether to wait for the viewport.
 * @param options - Options.
 * @param options.spaceKeyboard - Route keys through the Space host's rule inside a Space region.
 * @returns The session.
 */
async function setup(records: readonly SceneObject[] = [], myRole: 'editor' | 'viewer' = 'editor', viewport = true, { spaceKeyboard = false }: { spaceKeyboard?: boolean } = {}): Promise<{ session: SceneSession }> {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const objects: SceneObject[] = [{ id: BOX, name: 'Box', model: { kind: 'builtin', id: 'box' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }, ...records];
  (applySceneCommand as unknown as (...args: unknown[]) => unknown)(doc, { type: 'create', objects }, Symbol('fixture'), true, NAME, { maxLights: 64 });
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: myRole === 'viewer', connected: true, hasEverSynced: true, writeAccess: myRole === 'viewer' ? 'denied' : 'granted', refused: false, awareness: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
  const bound = <div data-space-outlet='scene'><Bound session={session} myRole={myRole} ownsKeyboard={spaceKeyboard ? ownsSceneKeyboard : () => true} /></div>;
  render(<QueryClientProvider client={client}><TooltipProvider>{spaceKeyboard ? <div data-region='space'>{bound}</div> : bound}</TooltipProvider></QueryClientProvider>);
  if (viewport) await screen.findByTestId('scene-native-boundary');
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
  URL.createObjectURL = vi.fn(() => 'blob:still');
  URL.revokeObjectURL = vi.fn();
  h.capture.mockReset().mockResolvedValue({ width: 648, height: 1152, pixels: new Uint8Array(4),
    pose: { position: [3, 2, 7], quaternion: [0, 0.38268343236508984, 0, 0.9238795325112867], fov: 20, aspect: 648 / 1152 } });
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

describe('saving and lighting from what is on screen (round 1 fixes, design 3.5, 3.6)', () => {
  const FAR = camera(CAM, 1, { position: [3, 2, 7], rotation: [0, 0.38268343236508984, 0, 0.9238795325112867], focalLength: 85, frame: '9:16' });
  const cameras = (session: SceneSession): Array<Record<string, unknown>> =>
    readSceneDocument(session.doc).objects.filter((object) => object.model.kind === ('camera' as never)) as unknown as Array<Record<string, unknown>>;
  const viewfinderButton = (key: string): HTMLElement => within(screen.getByTestId('scene-viewfinder-menu')).getByRole('button', { name: t(`spaces.threeD.viewfinder.${key}`) });

  it('saves the still on screen, not the camera record moved after it, when + is pressed', async () => {
    const { session } = await setup([FAR]);
    const opened = await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    fireEvent.click(viewfinderButton('confirm'));
    await waitFor(() => expect(h.viewport?.cameraView?.kind).toBe('frozen'));
    act(() => { (applySceneCommand as unknown as (...args: unknown[]) => unknown)(session.doc, { type: 'patch', patches: [{ id: CAM, position: [9, 9, 9], focalLength: 35 }] }, Symbol('peer'), true, NAME, { maxLights: 16 }); });
    fireEvent.click(within(opened).getByRole('button', { name: label('saveView') }));
    await waitFor(() => expect(cameras(session)).toHaveLength(2));
    expect(cameras(session)[1]).toMatchObject({ number: 2, position: [3, 2, 7], frame: '9:16' });
    expect(cameras(session)[1]?.focalLength).toBeCloseTo(36 / (2 * Math.tan((10 * Math.PI) / 180)), 6);
  });

  it('saves the pose of the still when its camera was deleted meanwhile', async () => {
    const { session } = await setup([FAR]);
    const opened = await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    fireEvent.click(viewfinderButton('confirm'));
    await waitFor(() => expect(h.viewport?.cameraView?.kind).toBe('frozen'));
    act(() => { (applySceneCommand as unknown as (...args: unknown[]) => unknown)(session.doc, { type: 'delete', ids: [CAM] }, Symbol('peer'), true, NAME, { maxLights: 16 }); });
    await waitFor(() => expect(h.viewport?.cameraView).toMatchObject({ kind: 'frozen', id: null }));
    fireEvent.click(within(opened).getByRole('button', { name: label('saveView') }));
    await waitFor(() => expect(cameras(session)).toHaveLength(1));
    expect(cameras(session)[0]).toMatchObject({ position: [3, 2, 7], frame: '9:16' });
  });

  it('keeps a Free camera\'s ratio when the right panel closes', async () => {
    await setup([camera(CAM, 1, { frame: 'Free', freeRatio: 2 })]);
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    await waitFor(() => expect(h.viewport?.viewFrame?.width).toBeGreaterThan(0));
    fireEvent.click(directorTrigger());
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    const frame = h.viewport?.viewFrame as { width: number; height: number };
    expect(frame.width / frame.height).toBeCloseTo(2, 3);
  });

  it('keeps a still\'s ratio when the right panel closes after its camera was deleted', async () => {
    const { session } = await setup([FAR]);
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    fireEvent.click(viewfinderButton('confirm'));
    await waitFor(() => expect(h.viewport?.cameraView?.kind).toBe('frozen'));
    act(() => { (applySceneCommand as unknown as (...args: unknown[]) => unknown)(session.doc, { type: 'delete', ids: [CAM] }, Symbol('peer'), true, NAME, { maxLights: 16 }); });
    await waitFor(() => expect(h.viewport?.cameraView).toMatchObject({ kind: 'frozen', id: null }));
    fireEvent.click(directorTrigger());
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    const frame = h.viewport?.viewFrame as { width: number; height: number };
    expect(frame.width / frame.height).toBeCloseTo(648 / 1152, 3);
  });

  it('refits the frame to a new ratio after a corner drag was cut off by a lock', async () => {
    const { session } = await setup([camera(CAM, 1, { frame: 'Free', freeRatio: 2 })]);
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    const corner = await screen.findByTestId('scene-viewfinder-corner-se');
    corner.setPointerCapture = (): void => undefined;
    fireEvent.pointerDown(corner, { pointerId: 1, button: 0, buttons: 1, clientX: 900, clientY: 600 });
    act(() => { session.execute({ type: 'lock', ids: [CAM], locked: true }); });
    expect(screen.queryByTestId('scene-viewfinder-corner-se')).toBeNull();
    act(() => { session.execute({ type: 'lock', ids: [CAM], locked: false }); });
    act(() => { session.execute({ type: 'patch', patches: [{ id: CAM, frame: '1:1' }] }); });
    await waitFor(() => {
      const frame = h.viewport?.viewFrame as { width: number; height: number };
      expect(frame.width / frame.height).toBeCloseTo(1, 3);
    });
  });
});

describe('a Free camera corner drag that never gets its release (round 2 fixes, design 3.4 item 1)', () => {
  const ratio = (): number => { const frame = h.viewport?.viewFrame as { width: number; height: number }; return frame.width / frame.height; };
  /** Look through a Free 2:1 camera and drag its se corner to a wider shape without letting go. */
  async function dragWider(): Promise<{ session: SceneSession; corner: HTMLElement }> {
    const { session } = await setup([camera(CAM, 1, { frame: 'Free', freeRatio: 2 })]);
    await openDirector();
    fireEvent.click(screen.getByTestId(`scene-director-monitor-${CAM}`));
    const corner = await screen.findByTestId('scene-viewfinder-corner-se');
    corner.setPointerCapture = (): void => undefined;
    fireEvent.pointerDown(corner, { pointerId: 1, button: 0, buttons: 1, clientX: 900, clientY: 600 });
    fireEvent.pointerMove(corner, { pointerId: 1, buttons: 1, clientX: 1000, clientY: 520 });
    await waitFor(() => expect(ratio()).toBeGreaterThan(2.2));
    return { session, corner };
  }

  it('puts the frame back to the record when a lock takes the corners away', async () => {
    const { session } = await dragWider();
    act(() => { session.execute({ type: 'lock', ids: [CAM], locked: true }); });
    await waitFor(() => expect(ratio()).toBeCloseTo(2, 3));
  });

  it('puts the frame back to the new frame when the camera leaves Free mid-drag', async () => {
    const { session } = await dragWider();
    act(() => { (applySceneCommand as unknown as (...args: unknown[]) => unknown)(session.doc, { type: 'patch', patches: [{ id: CAM, frame: '1:1' }] }, Symbol('peer'), true, NAME, { maxLights: 16 }); });
    await waitFor(() => expect(ratio()).toBeCloseTo(1, 3));
  });

  it('puts the frame back to the record at a move without the button held', async () => {
    const { session, corner } = await dragWider();
    fireEvent.pointerMove(corner, { pointerId: 1, buttons: 0, clientX: 1010, clientY: 510 });
    await waitFor(() => expect(ratio()).toBeCloseTo(2, 3));
    expect(readSceneDocument(session.doc).objects.find((object) => object.id === CAM)).toMatchObject({ freeRatio: 2 });
  });
});

describe('monitor cards and the object list (round 1 fixes, design 3.7, 4.2)', () => {
  it('shows the failure text on every card once the renderer fails', async () => {
    await setup([camera()]);
    await openDirector();
    act(() => { h.viewport?.onError?.(new Error('lost context')); });
    const monitor = await screen.findByTestId(`scene-director-monitor-${CAM}`);
    expect(monitor).toHaveTextContent(t('spaces.threeD.loadFailed'));
    expect(monitor.querySelector('.skeleton-shimmer')).toBeNull();
  });

  it('shows the failure text on every card when the scene controls fail to load', async () => {
    vi.mocked(getSceneControls).mockRejectedValueOnce(new Error('offline'));
    await setup([camera()], 'editor', false);
    await screen.findByText(t('spaces.threeD.retry'));
    await openDirector();
    const monitor = await screen.findByTestId(`scene-director-monitor-${CAM}`);
    expect(monitor).toHaveTextContent(t('spaces.threeD.loadFailed'));
    expect(monitor.querySelector('.skeleton-shimmer')).toBeNull();
  });

  it('lists cameras and lights in the object list by number', async () => {
    const first = '00000000-0000-4000-8000-000000000009';
    await setup([camera(CAM, 2), camera(first, 1)]);
    fireEvent.click(screen.getByTestId('scene-objects-trigger'));
    const list = await screen.findByTestId('scene-objects-panel');
    const rows = within(list).getAllByTestId(/^scene-object-/).map((row) => row.dataset.testid);
    expect(rows).toEqual([`scene-object-${BOX}`, `scene-object-${first}`, `scene-object-${CAM}`]);
  });
});

describe('continuous controls end on release and on Escape (round 1 fixes, design 3.8)', () => {
  /** Give jsdom the pointer capture Radix Slider relies on, and a 400 px wide track. */
  function sliderPointers(): void {
    const held = new WeakMap<Element, Set<number>>();
    vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(function (this: Element, id: number) { held.set(this, (held.get(this) ?? new Set()).add(id)); });
    vi.spyOn(Element.prototype, 'hasPointerCapture').mockImplementation(function (this: Element, id: number) { return held.get(this)?.has(id) ?? false; });
    vi.spyOn(Element.prototype, 'releasePointerCapture').mockImplementation(function (this: Element, id: number) { held.get(this)?.delete(id); });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 10, right: 400, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  }
  const drag = (thumb: HTMLElement, xs: readonly number[], release = true): void => {
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, buttons: 1, clientX: xs[0] });
    for (const x of xs.slice(1)) fireEvent.pointerMove(thumb, { pointerId: 1, buttons: 1, clientX: x });
    if (release) fireEvent.pointerUp(thumb, { pointerId: 1, clientX: xs[xs.length - 1] });
  };

  it('ends a light slider drag let go where it started', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    sliderPointers();
    const [thumb] = within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider');
    drag(thumb as HTMLElement, [1, 120, 1]);
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it('drops an ambient drag on Escape and keeps the console open', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    sliderPointers();
    const before = session.getSnapshot().environment.ambientIntensity;
    const [thumb] = within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('slider');
    drag(thumb as HTMLElement, [0, 200], false);
    expect(h.viewport?.environment?.ambientIntensity).not.toBe(before);
    fireEvent.keyDown(thumb as HTMLElement, { key: 'Escape' });
    expect(h.viewport?.environment?.ambientIntensity).toBe(before);
    expect(screen.getByTestId('scene-right-panel')).toBeInTheDocument();
  });

  it('ignores the rest of an ambient press after Escape', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    sliderPointers();
    const before = session.getSnapshot().environment.ambientIntensity;
    const [thumb] = within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('slider');
    drag(thumb as HTMLElement, [0, 200], false);
    fireEvent.keyDown(thumb as HTMLElement, { key: 'Escape' });
    fireEvent.pointerMove(thumb as HTMLElement, { pointerId: 1, buttons: 1, clientX: 300 });
    fireEvent.pointerUp(thumb as HTMLElement, { pointerId: 1, clientX: 300 });
    expect(session.getSnapshot().environment.ambientIntensity).toBe(before);
    expect(h.viewport?.environment?.ambientIntensity).toBe(before);
  });

  it('ignores the rest of a light slider press after Escape', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    sliderPointers();
    const intensity = (): unknown => session.getSnapshot().objects.find((object) => object.id === LAMP)?.['intensity' as never];
    const before = intensity();
    const [thumb] = within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider');
    drag(thumb as HTMLElement, [0, 200], false);
    fireEvent.keyDown(thumb as HTMLElement, { key: 'Escape' });
    fireEvent.pointerMove(thumb as HTMLElement, { pointerId: 1, buttons: 1, clientX: 300 });
    fireEvent.pointerUp(thumb as HTMLElement, { pointerId: 1, clientX: 300 });
    expect(intensity()).toBe(before);
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  const lampValue = (session: SceneSession, key: string): unknown => (readSceneDocument(session.doc).objects.find((object) => object.id === LAMP) as unknown as Record<string, unknown> | undefined)?.[key];

  it('writes a light slider key step as one undo step', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    const [thumb] = within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider');
    fireEvent.keyDown(thumb as HTMLElement, { key: 'ArrowRight' });
    await waitFor(() => expect(lampValue(session, 'intensity')).toBe(2));
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it('writes an ambient slider key step', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    const before = session.getSnapshot().environment.ambientIntensity;
    const [thumb] = within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('slider');
    fireEvent.keyDown(thumb as HTMLElement, { key: 'ArrowRight' });
    await waitFor(() => expect(session.getSnapshot().environment.ambientIntensity).toBeCloseTo(before + 0.1, 9));
  });

  it('keeps a typed light colour when the intensity slider is pressed next', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    sliderPointers();
    const fields = screen.getByTestId(`scene-director-fields-${LAMP}`);
    fireEvent.click(within(fields).getByRole('button', { name: t('spaces.threeD.color') }));
    await screen.findByRole('slider', { name: 'Color' });
    fireEvent.input(screen.getAllByRole('textbox').at(-1) as HTMLElement, { target: { value: 'ff0000' } });
    const [thumb] = within(fields).getAllByRole('slider');
    const track = (thumb as HTMLElement).parentElement?.parentElement as HTMLElement;
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, buttons: 1, clientX: 200 });
    fireEvent.pointerMove(track, { pointerId: 1, buttons: 1, clientX: 260 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 260 });
    expect(lampValue(session, 'intensity')).not.toBe(1);
    await waitFor(() => expect(lampValue(session, 'color')).toBe('#ff0000'));
  });

  it('writes a colour on each release of the picker, also after the window lost focus', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    sliderPointers();
    fireEvent.click(within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getByRole('button', { name: t('spaces.threeD.color') }));
    const saturation = (await screen.findByRole('slider', { name: 'Color' })) as HTMLElement;
    const pickAt = (x: number): void => {
      fireEvent.pointerDown(saturation, { pointerId: 1, buttons: 1 });
      fireEvent.mouseDown(saturation, { button: 0, pageX: x, pageY: 2, clientX: x, clientY: 2 });
      fireEvent.mouseUp(window);
      fireEvent.pointerUp(window, { pointerId: 1 });
    };
    const shown = (): unknown => (h.viewport?.objects.find((object) => object.id === LAMP) as unknown as Record<string, unknown> | undefined)?.color;
    pickAt(380);
    expect(shown()).not.toBe('#ffffff');
    await waitFor(() => expect(lampValue(session, 'color')).not.toBe('#ffffff'));
    const first = lampValue(session, 'color');
    act(() => session.setFocused(false));
    act(() => session.setFocused(true));
    pickAt(40);
    await waitFor(() => expect(lampValue(session, 'color')).not.toBe(first));
  });

  const ambientSwatch = (opened: HTMLElement): HTMLElement => within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('button')[0] as HTMLElement;
  const lightSwatch = (id = LAMP): HTMLElement => within(screen.getByTestId(`scene-director-fields-${id}`)).getByRole('button', { name: t('spaces.threeD.color') });
  const hexInput = (): HTMLInputElement => screen.getAllByRole('textbox').at(-1) as HTMLInputElement;
  const pickerClosed = async (): Promise<void> => { await waitFor(() => expect(screen.queryByRole('slider', { name: 'Color' })).toBeNull()); };
  const ambientColor = (session: SceneSession): string => session.getSnapshot().environment.ambientColor;

  it('writes a colour typed key by key once, as shown, when the input is left', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    fireEvent.click(lightSwatch());
    await screen.findByRole('slider', { name: 'Color' });
    const input = hexInput();
    fireEvent.focus(input);
    const writes = vi.spyOn(session, 'execute');
    fireEvent.input(input, { target: { value: '' } });
    // Each key goes at the end of what the box shows by then, as typing does.
    for (const key of 'ff0000') fireEvent.input(input, { target: { value: input.value + key } });
    // A digit put into the middle of a full colour: the box keeps six digits.
    fireEvent.input(input, { target: { value: '#ff10000' } });
    expect(input.value).toBe('#ff1000');
    expect(lampValue(session, 'color')).toBe('#ffffff');
    expect(h.viewport?.objects.find((object) => object.id === LAMP)?.['color' as never]).toBe('#ffffff');
    fireEvent.blur(input);
    await waitFor(() => expect(lampValue(session, 'color')).toBe('#ff1000'));
    expect(writes.mock.calls.filter(([command]) => command.type === 'patch' && command.patches.some((patch) => 'color' in patch))).toHaveLength(1);
  });

  it('writes a picker arrow-key step when the key is released', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    fireEvent.click(lightSwatch());
    const saturation = await screen.findByRole('slider', { name: 'Color' });
    fireEvent.keyDown(saturation, { key: 'ArrowRight', keyCode: 39 });
    fireEvent.keyUp(saturation, { key: 'ArrowRight', keyCode: 39 });
    await waitFor(() => expect(lampValue(session, 'color')).not.toBe('#ffffff'));
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it('takes a three-digit colour as its six-digit form when the picker closes', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    fireEvent.click(ambientSwatch(opened));
    const input = await screen.findByRole('textbox');
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: '0f0' } });
    expect(input).toHaveValue('#0f0');
    expect(h.viewport?.environment?.ambientColor).not.toBe('#00ff00');
    fireEvent.click(ambientSwatch(opened));
    await waitFor(() => expect(ambientColor(session)).toBe('#00ff00'));
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['leaving the input', (input: HTMLElement): void => { fireEvent.blur(input); }],
    ['pressing Enter', (input: HTMLElement): void => { fireEvent.keyDown(input, { key: 'Enter' }); }],
  ])('takes a three-digit colour on %s', async (_, leave) => {
    const { session } = await setup();
    const opened = await openDirector();
    fireEvent.click(ambientSwatch(opened));
    const input = await screen.findByRole('textbox');
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: '0f0' } });
    leave(input);
    await waitFor(() => expect(ambientColor(session)).toBe('#00ff00'));
    expect(input).toHaveValue('#00ff00');
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it('drops typed text on Escape', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    fireEvent.click(ambientSwatch(opened));
    const input = await screen.findByRole('textbox');
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: '00ff00' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await pickerClosed();
    expect(ambientColor(session)).toBe('#ffffff');
    fireEvent.click(ambientSwatch(opened));
    expect(await screen.findByRole('textbox')).toHaveValue('#ffffff');
  });

  it('takes typed text only in the picker it was typed in', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    sliderPointers();
    fireEvent.click(ambientSwatch(opened));
    const input = await screen.findByRole('textbox');
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: '0f0' } });
    fireEvent.click(ambientSwatch(opened));
    await waitFor(() => expect(ambientColor(session)).toBe('#00ff00'));
    await pickerClosed();
    fireEvent.click(ambientSwatch(opened));
    const saturation = await screen.findByRole('slider', { name: 'Color' });
    fireEvent.mouseDown(saturation, { button: 0, buttons: 1, pageX: 40, pageY: 2, clientX: 40, clientY: 2 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(ambientColor(session)).not.toBe('#00ff00'));
    const picked = ambientColor(session);
    fireEvent.click(ambientSwatch(opened));
    await pickerClosed();
    expect(ambientColor(session)).toBe(picked);
  });

  it('takes typed text only for the light it was typed for', async () => {
    const { session } = await setup([lamp(), lamp(LAMP2, 2)]);
    act(() => session.select(LAMP, false));
    const props = await screen.findByTestId('scene-properties-panel');
    fireEvent.click(within(props).getByRole('button', { name: t('spaces.threeD.color') }));
    await screen.findByRole('slider', { name: 'Color' });
    fireEvent.focus(hexInput());
    fireEvent.input(hexInput(), { target: { value: '0f0' } });
    fireEvent.click(within(props).getByRole('button', { name: t('spaces.threeD.color') }));
    await waitFor(() => expect(lampValue(session, 'color')).toBe('#00ff00'));
    act(() => session.select(LAMP2, false));
    const next = await screen.findByTestId(`scene-director-fields-${LAMP2}`);
    fireEvent.click(within(next).getByRole('button', { name: t('spaces.threeD.color') }));
    await screen.findByRole('slider', { name: 'Color' });
    fireEvent.click(within(next).getByRole('button', { name: t('spaces.threeD.color') }));
    await pickerClosed();
    expect((readSceneDocument(session.doc).objects.find((object) => object.id === LAMP2) as unknown as Record<string, unknown>).color).toBe('#ffffff');
  });

  it('lets a click on the picker decide the colour after typing', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    sliderPointers();
    fireEvent.click(ambientSwatch(opened));
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    act(() => input.focus());
    fireEvent.input(input, { target: { value: '0f0' } });
    const writes = vi.spyOn(session, 'execute');
    fireEvent.mouseDown(await screen.findByRole('slider', { name: 'Color' }), { button: 0, buttons: 1, pageX: 200, pageY: 2, clientX: 200, clientY: 2 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(ambientColor(session)).toBe('#cc6666'));
    expect(writes.mock.calls.filter(([command]) => command.type === 'environment')).toHaveLength(1);
    expect(hexInput()).toHaveValue('#cc6666');
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('drops a held picker drag of %s on Escape', async (_, light) => {
    const { session } = await setup([lamp()]);
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    sliderPointers();
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const saturation = await screen.findByRole('slider', { name: 'Color' });
    fireEvent.mouseDown(saturation, { button: 0, buttons: 1, pageX: 200, pageY: 2, clientX: 200, clientY: 2 });
    fireEvent.mouseMove(window, { buttons: 1, pageX: 300, pageY: 2, clientX: 300, clientY: 2 });
    fireEvent.keyDown(saturation, { key: 'Escape' });
    fireEvent.mouseUp(window);
    await pickerClosed();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(light ? lampValue(session, 'color') : ambientColor(session)).toBe('#ffffff');
    expect(session.getSnapshot().gestureActive).toBe(false);
    // The next pick is a press of its own.
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    fireEvent.mouseDown(await screen.findByRole('slider', { name: 'Color' }), { button: 0, buttons: 1, pageX: 40, pageY: 2, clientX: 40, clientY: 2 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(light ? lampValue(session, 'color') : ambientColor(session)).not.toBe('#ffffff'));
  });

  it('drops an ambient slider drag on undo', async () => {
    const { session } = await setup();
    act(() => { session.execute({ type: 'environment', set: { ambientIntensity: 2.7 } }); });
    const opened = await openDirector();
    sliderPointers();
    const [thumb] = within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('slider');
    drag(thumb as HTMLElement, [0, 200], false);
    fireEvent.keyDown(thumb as HTMLElement, { key: 'z', ctrlKey: true });
    const undone = session.getSnapshot().environment.ambientIntensity;
    expect(h.viewport?.environment?.ambientIntensity).toBe(undone);
    fireEvent.pointerMove(thumb as HTMLElement, { pointerId: 1, buttons: 1, clientX: 300 });
    fireEvent.pointerUp(thumb as HTMLElement, { pointerId: 1, clientX: 300 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getSnapshot().environment.ambientIntensity).toBe(undone);
  });

  it('writes the last colour of a picker drag released right after its last move', async () => {
    const { session } = await setup([lamp()]);
    await openDirector();
    act(() => session.select(LAMP, false));
    sliderPointers();
    vi.spyOn(MouseEvent.prototype, 'pageX', 'get').mockImplementation(function (this: MouseEvent) { return this.clientX; });
    fireEvent.click(lightSwatch());
    const saturation = (await screen.findByRole('slider', { name: 'Color' })) as HTMLElement;
    fireEvent.mouseDown(saturation, { button: 0, buttons: 1, clientX: 380, clientY: 2 });
    const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;
    // Outside act React schedules the move's render, as a browser does when the release follows at once.
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 40, clientY: 2 }));
      window.dispatchEvent(new MouseEvent('mouseup', {}));
      await vi.waitFor(() => expect(lampValue(session, 'color')).not.toBe('#ffffff'));
    } finally { scope.IS_REACT_ACT_ENVIRONMENT = actEnvironment; }
    const shown = h.viewport?.objects.find((object) => object.id === LAMP)?.['color' as never];
    expect(lampValue(session, 'color')).toBe(shown);
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it.each([['editing access goes', 'access'], ['a peer lock', 'lock']])('keeps a slider press started while a refused picker arrow is held, after %s and comes back', async (_, how) => {
    const { session } = await setup([lamp(LAMP, 1, 'point', { color: '#ff0000' })], 'editor', true, { spaceKeyboard: true });
    await openDirector();
    act(() => session.select(LAMP, false));
    fireEvent.click(lightSwatch());
    const hue = await screen.findByRole('slider', { name: 'Hue' });
    hue.focus();
    const access = (granted: boolean): void => act(() => session.setEnvironment({ readOnly: !granted, connected: true, hasEverSynced: true, writeAccess: granted ? 'granted' : 'denied', refused: false, awareness: null }));
    const lock = (locked: boolean): void => act(() => { applySceneCommand(session.doc, { type: 'lock', ids: [LAMP], locked }, Symbol('peer'), true, NAME, { maxLights: 64 }); });
    if (how === 'access') access(false); else lock(true);
    // Hue 0 with ArrowLeft changes nothing, so the refused press stays held.
    fireEvent.keyDown(hue, { key: 'ArrowLeft', keyCode: 37 });
    if (how === 'access') access(true); else lock(false);
    sliderPointers();
    const thumb = within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider')[0] as HTMLElement;
    drag(thumb, [300, 320]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lampValue(session, 'intensity')).not.toBe(1);
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('writes a picker drag of %s that starts on the current colour and is released right after its first move', async (_, light) => {
    const { session } = await setup([lamp()]);
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    vi.spyOn(MouseEvent.prototype, 'pageX', 'get').mockImplementation(function (this: MouseEvent) { return this.clientX; });
    vi.spyOn(MouseEvent.prototype, 'pageY', 'get').mockImplementation(function (this: MouseEvent) { return this.clientY; });
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const saturation = (await screen.findByRole('slider', { name: 'Color' })) as HTMLElement;
    // The knob reaches past the picker's corner; a press there is the white the picker already shows.
    fireEvent.mouseDown(saturation.querySelector('.react-colorful__pointer') as HTMLElement, { button: 0, buttons: 1, clientX: -6, clientY: -6 });
    const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 120, clientY: 40 }));
      window.dispatchEvent(new MouseEvent('mouseup', {}));
      await vi.waitFor(() => expect(light ? lampValue(session, 'color') : ambientColor(session)).not.toBe('#ffffff'));
    } finally { scope.IS_REACT_ACT_ENVIRONMENT = actEnvironment; }
    const shown = light ? h.viewport?.objects.find((object) => object.id === LAMP)?.['color' as never] : h.viewport?.environment?.ambientColor;
    expect(shown).not.toBe('#ffffff');
    expect(light ? lampValue(session, 'color') : ambientColor(session)).toBe(shown);
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('ends a held picker drag of %s on undo while the picker has focus', async (_, light) => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    const intensity = (): unknown => (light ? lampValue(session, 'intensity') : session.getSnapshot().environment.ambientIntensity);
    const before = intensity();
    act(() => { session.execute(light ? { type: 'patch', patches: [{ id: LAMP, intensity: 3 }] } : { type: 'environment', set: { ambientIntensity: 2.7 } }); });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    sliderPointers();
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const saturation = await screen.findByRole('slider', { name: 'Color' });
    fireEvent.mouseDown(saturation, { button: 0, buttons: 1, pageX: 200, pageY: 2, clientX: 200, clientY: 2 });
    expect(document.activeElement).toBe(saturation);
    fireEvent.keyDown(saturation, { key: 'z', ctrlKey: true });
    expect(intensity()).toBe(before);
    fireEvent.mouseMove(window, { buttons: 1, pageX: 300, pageY: 2, clientX: 300, clientY: 2 });
    fireEvent.mouseUp(window);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(light ? lampValue(session, 'color') : ambientColor(session)).toBe('#ffffff');
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it('keeps typed text in the box when the browser loses focus', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    fireEvent.click(ambientSwatch(opened));
    const input = await screen.findByRole('textbox');
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: '0f0' } });
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    fireEvent.blur(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ambientColor(session)).toBe('#ffffff');
    expect(input).toHaveValue('#0f0');
    focused.mockReturnValue(true);
    fireEvent.blur(input);
    await waitFor(() => expect(ambientColor(session)).toBe('#00ff00'));
  });

  /** Give the picker a 400 x 300 area and the page coordinates react-colorful reads. */
  function pickerArea(): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    vi.spyOn(MouseEvent.prototype, 'pageX', 'get').mockImplementation(function (this: MouseEvent) { return this.clientX; });
    vi.spyOn(MouseEvent.prototype, 'pageY', 'get').mockImplementation(function (this: MouseEvent) { return this.clientY; });
  }

  it('keeps a part typed colour in the box when the browser loses focus', async () => {
    await setup();
    const opened = await openDirector();
    fireEvent.click(ambientSwatch(opened));
    const input = await screen.findByRole('textbox');
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: 'ff00' } });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    fireEvent.blur(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(input).toHaveValue('#ff00');
  });

  it.each([
    ['the ambient light', true],
    ['a light', false],
  ])('writes nothing of %s when another Space tab is pressed while typing', async (_, ambient) => {
    const tab = document.createElement('button');
    tab.setAttribute('data-space-tab', 'other');
    // The Space tab keeps focus where it is, as SpaceTab's preventFocusOnPress does for a box inside a Space.
    tab.addEventListener('mousedown', (event) => event.preventDefault());
    document.body.appendChild(tab);
    try {
      const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
      const opened = await openDirector();
      if (!ambient) act(() => session.select(LAMP, false));
      fireEvent.click(ambient ? ambientSwatch(opened) : lightSwatch());
      await screen.findByRole('slider', { name: 'Color' });
      const input = hexInput();
      act(() => input.focus());
      fireEvent.input(input, { target: { value: '0f0' } });
      fireEvent.pointerDown(tab, { pointerId: 1, button: 0, buttons: 1, pointerType: 'mouse' });
      fireEvent.mouseDown(tab, { button: 0 });
      (document.querySelector('[data-space-outlet="scene"]') as HTMLElement).style.display = 'none';
      fireEvent.pointerUp(tab);
      fireEvent.mouseUp(tab);
      fireEvent.click(tab);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ambient ? ambientColor(session) : lampValue(session, 'color')).toBe('#ffffff');
    } finally { tab.remove(); }
  });

  it('keeps a transform drag that starts while a typed colour is pending', async () => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    await openDirector();
    act(() => session.select(LAMP, false));
    fireEvent.click(lightSwatch());
    await screen.findByRole('slider', { name: 'Color' });
    fireEvent.input(hexInput(), { target: { value: 'ff0000' } });
    const canvas = screen.getByTestId('scene-native-boundary');
    // The transform gizmo starts its gesture from the canvas pointerdown, before the press reaches the document.
    canvas.addEventListener('pointerdown', () => { h.viewport?.onGestureStart(); }, { once: true });
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, buttons: 1 });
    act(() => { h.viewport?.onGestureChange([{ id: LAMP, position: [5, 1, 4] }] as never); });
    act(() => { h.viewport?.onGestureEnd(true); });
    await waitFor(() => expect(lampValue(session, 'color')).toBe('#ff0000'));
    expect(lampValue(session, 'position')).toEqual([5, 1, 4]);
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('ends a held picker press of %s on undo before its first change', async (_, light) => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute(light ? { type: 'patch', patches: [{ id: LAMP, intensity: 3 }] } : { type: 'environment', set: { ambientIntensity: 2.7 } }); });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    pickerArea();
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const saturation = (await screen.findByRole('slider', { name: 'Color' })) as HTMLElement;
    // The knob reaches past the picker's corner; a press there is the white the picker already shows.
    fireEvent.mouseDown(saturation.querySelector('.react-colorful__pointer') as HTMLElement, { button: 0, buttons: 1, clientX: -6, clientY: -6 });
    fireEvent.keyDown(saturation, { key: 'z', ctrlKey: true });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 120, clientY: 40 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200, clientY: 60 });
    fireEvent.mouseUp(window);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(light ? lampValue(session, 'color') : ambientColor(session)).toBe('#ffffff');
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it('ends a held ambient slider press on undo before its first change', async () => {
    const { session } = await setup([], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute({ type: 'environment', set: { ambientIntensity: 2.7 } }); });
    const opened = await openDirector();
    sliderPointers();
    const [thumb] = within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('slider');
    const undone = (): number => session.getSnapshot().environment.ambientIntensity;
    // 2.7 of 10 on a 400 px track: the press lands on the current value.
    fireEvent.pointerDown(thumb as HTMLElement, { pointerId: 1, button: 0, buttons: 1, clientX: 108 });
    fireEvent.keyDown(thumb as HTMLElement, { key: 'z', ctrlKey: true });
    const afterUndo = undone();
    fireEvent.pointerMove(thumb as HTMLElement, { pointerId: 1, buttons: 1, clientX: 300 });
    fireEvent.pointerUp(thumb as HTMLElement, { pointerId: 1, clientX: 300 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(undone()).toBe(afterUndo);
  });

  it('ends a held light slider press on undo before its first change', async () => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute({ type: 'patch', patches: [{ id: LAMP, intensity: 100 }] }); });
    await openDirector();
    act(() => session.select(LAMP, false));
    sliderPointers();
    const [thumb] = within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider');
    // 100 of a point light's 400 on a 400 px track: the press lands on the current value.
    fireEvent.pointerDown(thumb as HTMLElement, { pointerId: 1, button: 0, buttons: 1, clientX: 100 });
    fireEvent.keyDown(thumb as HTMLElement, { key: 'z', ctrlKey: true });
    const afterUndo = lampValue(session, 'intensity');
    fireEvent.pointerMove(thumb as HTMLElement, { pointerId: 1, buttons: 1, clientX: 300 });
    fireEvent.pointerUp(thumb as HTMLElement, { pointerId: 1, clientX: 300 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lampValue(session, 'intensity')).toBe(afterUndo);
    expect(session.getSnapshot().gestureActive).toBe(false);
  });

  it('ends a held ambient slider press on Escape before its first change and keeps the console open', async () => {
    const { session } = await setup([], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute({ type: 'environment', set: { ambientIntensity: 2.7 } }); });
    await openDirector();
    sliderPointers();
    const thumb = (): HTMLElement => within(within(screen.getByTestId('scene-right-panel')).getByTestId('scene-director-ambient')).getAllByRole('slider')[0] as HTMLElement;
    // 2.7 of 10 on a 400 px track: the press lands on the current value.
    fireEvent.pointerDown(thumb(), { pointerId: 1, button: 0, buttons: 1, clientX: 108 });
    fireEvent.keyDown(thumb(), { key: 'Escape' });
    expect(screen.queryByTestId('scene-right-panel')).toBeInTheDocument();
    fireEvent.pointerUp(thumb(), { pointerId: 1, clientX: 108 });
    drag(thumb(), [108, 200]);
    await waitFor(() => expect(session.getSnapshot().environment.ambientIntensity).toBe(5));
  });

  it('opens no ambient press for a Viewer, so Escape on the slider takes its usual step', async () => {
    await setup([], 'viewer', true, { spaceKeyboard: true });
    await openDirector();
    sliderPointers();
    const [thumb] = within(within(screen.getByTestId('scene-right-panel')).getByTestId('scene-director-ambient')).getAllByRole('slider');
    fireEvent.pointerDown(thumb as HTMLElement, { pointerId: 1, button: 0, buttons: 1, clientX: 108 });
    fireEvent.keyDown(thumb as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
  });

  it('takes the next ambient press after the console closed during a dropped one', async () => {
    const { session } = await setup([], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute({ type: 'environment', set: { ambientIntensity: 2.7 } }); });
    await openDirector();
    sliderPointers();
    const thumb = (): HTMLElement => within(within(screen.getByTestId('scene-right-panel')).getByTestId('scene-director-ambient')).getAllByRole('slider')[0] as HTMLElement;
    drag(thumb(), [108, 300], false);
    const held = thumb();
    fireEvent.keyDown(held, { key: 'Escape' });
    // The second Escape closes the console while the button is still held; its release never reaches the slider.
    fireEvent.keyDown(held, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
    await openDirector();
    drag(thumb(), [108, 200]);
    await waitFor(() => expect(session.getSnapshot().environment.ambientIntensity).toBe(5));
  });

  it('drops a held ambient slider press silently when editing access is lost', async () => {
    const { session } = await setup([], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute({ type: 'environment', set: { ambientIntensity: 2.7 } }); });
    await openDirector();
    sliderPointers();
    const thumb = (): HTMLElement => within(within(screen.getByTestId('scene-right-panel')).getByTestId('scene-director-ambient')).getAllByRole('slider')[0] as HTMLElement;
    fireEvent.pointerDown(thumb(), { pointerId: 1, button: 0, buttons: 1, clientX: 108 });
    fireEvent.pointerMove(thumb(), { pointerId: 1, buttons: 1, clientX: 200 });
    act(() => session.setEnvironment({ readOnly: true, connected: true, hasEverSynced: true, writeAccess: 'denied', refused: false, awareness: null }));
    expect(h.viewport?.environment?.ambientIntensity).toBe(2.7);
    fireEvent.pointerUp(thumb(), { pointerId: 1, clientX: 200 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getSnapshot().environment.ambientIntensity).toBe(2.7);
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('writes the first key step of %s after a press whose release never came', async (_, light) => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute(light ? { type: 'patch', patches: [{ id: LAMP, intensity: 100 }] } : { type: 'environment', set: { ambientIntensity: 2.7 } }); });
    await openDirector();
    if (light) act(() => session.select(LAMP, false));
    sliderPointers();
    const thumb = (): HTMLElement => (light
      ? within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider')[0]
      : within(within(screen.getByTestId('scene-right-panel')).getByTestId('scene-director-ambient')).getAllByRole('slider')[0]) as HTMLElement;
    const value = (): unknown => (light ? lampValue(session, 'intensity') : session.getSnapshot().environment.ambientIntensity);
    fireEvent.pointerDown(thumb(), { pointerId: 1, button: 0, buttons: 1, clientX: light ? 100 : 108 });
    fireEvent.pointerMove(thumb(), { pointerId: 1, buttons: 1, clientX: 300 });
    // The browser loses focus and the button is let go outside it: no pointerup arrives.
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    focused.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    fireEvent.keyDown(thumb(), { key: 'ArrowRight' });
    await waitFor(() => expect(value()).toBe(light ? 101 : 2.8));
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('leaves no press open after a key step of %s at its bound, so Escape closes the console', async (_, light) => {
    const { session } = await setup([lamp(LAMP, 1, 'point', { intensity: 400 })], 'editor', true, { spaceKeyboard: true });
    act(() => { session.execute({ type: 'environment', set: { ambientIntensity: 10 } }); });
    await openDirector();
    if (light) act(() => session.select(LAMP, false));
    const [thumb] = light
      ? within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider')
      : within(within(screen.getByTestId('scene-right-panel')).getByTestId('scene-director-ambient')).getAllByRole('slider');
    fireEvent.keyDown(thumb as HTMLElement, { key: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.getSnapshot().gestureActive).toBe(false);
    fireEvent.keyDown(thumb as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('writes the first picker key step of %s after a press whose release never came', async (_, light) => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    sliderPointers();
    const [thumb] = light
      ? within(screen.getByTestId(`scene-director-fields-${LAMP}`)).getAllByRole('slider')
      : within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('slider');
    fireEvent.pointerDown(thumb as HTMLElement, { pointerId: 1, button: 0, buttons: 1, clientX: 100 });
    fireEvent.pointerMove(thumb as HTMLElement, { pointerId: 1, buttons: 1, clientX: 300 });
    // The browser loses focus and the button is let go outside it: no pointerup arrives.
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    focused.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const saturation = await screen.findByRole('slider', { name: 'Color' });
    fireEvent.keyDown(saturation, { key: 'ArrowRight', keyCode: 39 });
    fireEvent.keyUp(saturation, { key: 'ArrowRight', keyCode: 39 });
    await waitFor(() => expect(light ? lampValue(session, 'color') : ambientColor(session)).not.toBe('#ffffff'));
  });

  it.each([
    ['the ambient light', 'Hue', false, 'ArrowRight', 39],
    ['the ambient light', 'Color', false, 'ArrowUp', 38],
    ['a light', 'Hue', true, 'ArrowRight', 39],
    ['a light', 'Color', true, 'ArrowUp', 38],
  ])('leaves no press open after a picker key of %s on %s that changes nothing', async (_, control, light, key, keyCode) => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    const swatch = (): HTMLElement => (light ? lightSwatch() : ambientSwatch(opened));
    fireEvent.click(swatch());
    // On white the hue moves without changing the colour, and the saturation area is already at its top.
    const picker = await screen.findByRole('slider', { name: control });
    fireEvent.keyDown(picker, { key, keyCode });
    fireEvent.keyUp(picker, { key, keyCode });
    fireEvent.click(swatch());
    await pickerClosed();
    expect(session.getSnapshot().gestureActive).toBe(false);
    fireEvent.keyDown(swatch(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('takes a held picker arrow key on %s as one press, written on its release', async (_, light) => {
    const { session } = await setup([lamp(LAMP, 1, 'point', { color: '#ff0000' })], 'editor', true, { spaceKeyboard: true });
    if (!light) act(() => { session.execute({ type: 'environment', set: { ambientColor: '#ff0000' } }); });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    const stored = (): unknown => (light ? lampValue(session, 'color') : ambientColor(session));
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const hue = await screen.findByRole('slider', { name: 'Hue' });
    const shown: number[] = [];
    // The first keydown, then the browser's auto-repeats while the key is held.
    for (let step = 0; step < 5; step += 1) {
      fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39, repeat: step > 0 });
      shown.push(Number(hue.getAttribute('aria-valuenow')));
    }
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(new Set(shown).size).toBe(5);
    expect(stored()).toBe('#ff0000');
    fireEvent.keyUp(hue, { key: 'ArrowRight', keyCode: 39 });
    await waitFor(() => expect(stored()).toBe('#80ff00'));
    expect(session.getSnapshot().gestureActive).toBe(false);
    act(() => session.historyStep('undo'));
    expect(stored()).toBe('#ff0000');
  });

  it.each([
    ['the ambient light', 'focus loss', false],
    ['a light', 'focus loss', true],
    ['a light', 'a lock', true],
  ])('puts the picker of %s back on the stored colour when %s ends its drag', async (_, how, light) => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    pickerArea();
    const stored = (): unknown => (light ? lampValue(session, 'color') : ambientColor(session));
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const saturation = (): HTMLElement => screen.getByRole('slider', { name: 'Color' });
    await screen.findByRole('slider', { name: 'Color' });
    const white = saturation().getAttribute('aria-valuetext');
    fireEvent.mouseDown(saturation(), { button: 0, buttons: 1, clientX: 100, clientY: 50 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 150, clientY: 60 });
    if (how === 'a lock') act(() => { session.execute({ type: 'lock', ids: [LAMP], locked: true }); });
    else {
      const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      act(() => { window.dispatchEvent(new Event('blur')); });
      focused.mockReturnValue(true);
      act(() => { window.dispatchEvent(new Event('focus')); });
    }
    // The mouse is still held and keeps moving: the picker stays on what is stored.
    fireEvent.mouseMove(window, { buttons: 1, clientX: 250, clientY: 70 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(saturation().getAttribute('aria-valuetext')).toBe(white));
    expect(stored()).toBe('#ffffff');
    if (how === 'a lock') return;
    // A press on the point the pointer was let go writes that colour.
    fireEvent.mouseDown(saturation(), { button: 0, buttons: 1, clientX: 250, clientY: 70 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(stored()).not.toBe('#ffffff'));
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('takes two picker arrow keys held together on %s as one press, written as the picker shows it', async (_, light) => {
    const { session } = await setup([lamp(LAMP, 1, 'point', { color: '#804040' })], 'editor', true, { spaceKeyboard: true });
    if (!light) act(() => { session.execute({ type: 'environment', set: { ambientColor: '#804040' } }); });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    const stored = (): unknown => (light ? lampValue(session, 'color') : ambientColor(session));
    const swatch = (): HTMLElement => (light ? lightSwatch() : ambientSwatch(opened));
    fireEvent.click(swatch());
    const area = await screen.findByRole('slider', { name: 'Color' });
    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(area, { key: 'ArrowRight', keyCode: 39, repeat: step > 0 });
    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(area, { key: 'ArrowUp', keyCode: 38, repeat: step > 0 });
    fireEvent.keyUp(area, { key: 'ArrowRight', keyCode: 39 });
    for (let step = 0; step < 4; step += 1) fireEvent.keyDown(area, { key: 'ArrowUp', keyCode: 38, repeat: true });
    expect(stored()).toBe('#804040');
    fireEvent.keyUp(area, { key: 'ArrowUp', keyCode: 38 });
    await waitFor(() => expect(stored()).not.toBe('#804040'));
    const shown = area.getAttribute('aria-valuetext');
    fireEvent.click(swatch());
    await pickerClosed();
    fireEvent.click(swatch());
    expect((await screen.findByRole('slider', { name: 'Color' })).getAttribute('aria-valuetext')).toBe(shown);
    act(() => session.historyStep('undo'));
    expect(stored()).toBe('#804040');
  });

  it.each([
    ['the ambient light', 'focus loss', false],
    ['a light', 'focus loss', true],
    ['a light', 'an undo', true],
    ['a light', 'a lock', true],
  ])('takes the next picker arrow press on %s after %s ended one whose key was held', async (_, how, light) => {
    const { session } = await setup([lamp(LAMP, 1, 'point', { color: '#ff0000' })], 'editor', true, { spaceKeyboard: true });
    if (!light) act(() => { session.execute({ type: 'environment', set: { ambientColor: '#ff0000' } }); });
    act(() => { session.execute({ type: 'patch', patches: [{ id: LAMP, intensity: 3 }] }); });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    const stored = (): unknown => (light ? lampValue(session, 'color') : ambientColor(session));
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    await screen.findByRole('slider', { name: 'Hue' });
    const hue = (): HTMLElement => screen.getByRole('slider', { name: 'Hue' });
    hue().focus();
    fireEvent.keyDown(hue(), { key: 'ArrowRight', keyCode: 39 });
    if (how === 'focus loss') {
      // The browser blurs the focused element when the window loses focus; the key comes up in another window.
      const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      act(() => { hue().blur(); window.dispatchEvent(new Event('blur')); });
      focused.mockReturnValue(true);
      act(() => { window.dispatchEvent(new Event('focus')); });
    } else {
      if (how === 'an undo') fireEvent.keyDown(hue(), { key: 'z', metaKey: true });
      else act(() => { session.execute({ type: 'lock', ids: [LAMP], locked: true }); });
      fireEvent.keyDown(hue(), { key: 'ArrowRight', keyCode: 39, repeat: true });
      fireEvent.keyUp(document.activeElement ?? document.body, { key: 'ArrowRight', keyCode: 39 });
      if (how === 'a lock') act(() => { session.execute({ type: 'lock', ids: [LAMP], locked: false }); });
    }
    const before = stored();
    hue().focus();
    fireEvent.keyDown(hue(), { key: 'ArrowRight', keyCode: 39 });
    fireEvent.keyUp(hue(), { key: 'ArrowRight', keyCode: 39 });
    await waitFor(() => expect(stored()).not.toBe(before));
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('ends a held picker arrow press on %s without writing when the picker is closed', async (_, light) => {
    const { session } = await setup([lamp(LAMP, 1, 'point', { color: '#ff0000' })], 'editor', true, { spaceKeyboard: true });
    if (!light) act(() => { session.execute({ type: 'environment', set: { ambientColor: '#ff0000' } }); });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    const stored = (): unknown => (light ? lampValue(session, 'color') : ambientColor(session));
    const shown = (): unknown => (light ? h.viewport?.objects.find((object) => object.id === LAMP)?.['color' as never] : h.viewport?.environment?.ambientColor);
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const hue = await screen.findByRole('slider', { name: 'Hue' });
    hue.focus();
    fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39 });
    fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39, repeat: true });
    expect(shown()).not.toBe('#ff0000');
    // With the key still held, a click on the console's heading closes the picker.
    const heading = within(opened).getAllByRole('heading')[0] as HTMLElement;
    fireEvent.pointerDown(heading, { pointerId: 1, button: 0 });
    fireEvent.mouseDown(heading); fireEvent.pointerUp(heading, { pointerId: 1 }); fireEvent.mouseUp(heading); fireEvent.click(heading);
    await pickerClosed();
    fireEvent.keyUp(document.activeElement ?? document.body, { key: 'ArrowRight', keyCode: 39 });
    expect(stored()).toBe('#ff0000');
    expect(shown()).toBe('#ff0000');
    expect(session.getSnapshot().gestureActive).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('scene-right-panel')).toBeNull());
  });

  it.each([
    ['the ambient light', false],
    ['a light', true],
  ])('keeps a slider press on %s that starts while an arrow key is still down on its picker', async (_, light) => {
    const { session } = await setup([lamp()], 'editor', true, { spaceKeyboard: true });
    const opened = await openDirector();
    if (light) act(() => session.select(LAMP, false));
    const intensity = (): unknown => (light ? lampValue(session, 'intensity') : session.getSnapshot().environment.ambientIntensity);
    const before = intensity();
    fireEvent.click(light ? lightSwatch() : ambientSwatch(opened));
    const hue = await screen.findByRole('slider', { name: 'Hue' });
    hue.focus();
    fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39 });
    sliderPointers();
    const fields = light ? screen.getByTestId(`scene-director-fields-${LAMP}`) : within(opened).getByTestId('scene-director-ambient');
    const [thumb] = within(fields).getAllByRole('slider').filter((slider) => slider.getAttribute('aria-label') !== 'Hue');
    drag(thumb as HTMLElement, [300, 320]);
    await waitFor(() => expect(intensity()).not.toBe(before));
  });

  it('starts an ambient press from the stored values whatever an earlier press left', async () => {
    const { session } = await setup();
    act(() => { session.execute({ type: 'environment', set: { ambientColor: '#ff0000', ambientIntensity: 2 } }); });
    const opened = await openDirector();
    sliderPointers();
    const [thumb] = within(within(opened).getByTestId('scene-director-ambient')).getAllByRole('slider');
    // A drag of the intensity whose release came outside the browser.
    drag(thumb as HTMLElement, [0, 200], false);
    expect(h.viewport?.environment?.ambientIntensity).not.toBe(2);
    fireEvent.click(ambientSwatch(opened));
    const hue = await screen.findByRole('slider', { name: 'Hue' });
    fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39 });
    fireEvent.keyUp(hue, { key: 'ArrowRight', keyCode: 39 });
    await waitFor(() => expect(ambientColor(session)).not.toBe('#ff0000'));
    expect(session.getSnapshot().environment.ambientIntensity).toBe(2);
  });

  it('drops an ambient picker drag when the browser loses focus', async () => {
    const { session } = await setup();
    const opened = await openDirector();
    pickerArea();
    fireEvent.click(ambientSwatch(opened));
    const saturation = (await screen.findByRole('slider', { name: 'Color' })) as HTMLElement;
    fireEvent.mouseDown(saturation, { button: 0, buttons: 1, clientX: 100, clientY: 50 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200, clientY: 60 });
    expect(h.viewport?.environment?.ambientColor).not.toBe('#ffffff');
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(h.viewport?.environment?.ambientColor).toBe('#ffffff');
    focused.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event('focus')); });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 250, clientY: 70 });
    fireEvent.mouseUp(window);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ambientColor(session)).toBe('#ffffff');
  });
});
