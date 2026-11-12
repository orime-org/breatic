// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The viewfinder in the 3D Space (#1411): the persistent top-right button,
 * framing with the minimap and creation menu put away, the capture, and the
 * three destinations with the states of design 6.1.
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
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';
import { useUIStore } from '@web/stores/ui';

const h = vi.hoisted(() => ({
  modelState: 'ready' as 'ready' | 'loading',
  viewport: null as null | { viewLocked?: boolean },
  capture: vi.fn(),
  spaces: [] as Array<{ id: string; name: string; type: string; createdAt?: number }>,
  placeImageOnCanvas: vi.fn(),
  openTray: vi.fn(),
  uploadTrayItem: vi.fn(),
  add: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  clipboardWrite: vi.fn(),
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
    h.viewport = props;
    React.useEffect(() => {
      props.onCapture?.(h.capture);
      for (const object of props.objects) props.onModelStateChange?.(object.id, h.modelState);
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
  useProjectMeta: () => ({ spaces: h.spaces, synced: true }),
}));
vi.mock('@web/spaces/canvas/place-image-on-canvas', () => ({ placeImageOnCanvas: h.placeImageOnCanvas }));
vi.mock('@web/stores/attach-to-chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/stores/attach-to-chat')>()),
  openTray: h.openTray,
  uploadTrayItem: h.uploadTrayItem,
}));
vi.mock('@web/stores/chat-attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/stores/chat-attachments')>();
  return { ...actual, chatAttachments: { ...actual.chatAttachments, add: h.add } };
});
vi.mock('@web/spaces/canvas/upload-derived-image', () => ({ uploadDerivedImage: vi.fn(async () => 'https://cdn.example.test/shot.png') }));
vi.mock('@web/spaces/three-d/viewfinder/encode-capture', () => ({
  encodeCapturePng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}));
vi.mock('@web/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api')>();
  return { ...actual, assetsApi: { ...actual.assetsApi, fetchUploadConfig: vi.fn(async () => ({ maxUploadBytes: 1 << 30 })) } };
});

const NAME = 'project-p1/3d-s1';
const ID = '11111111-1111-4111-8111-111111111111';
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
 * Render the editor with one box.
 * @param myRole - The member's role.
 * @returns The session.
 */
async function setup(myRole: 'editor' | 'viewer' = 'editor'): Promise<{ session: SceneSession }> {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const objects: SceneObject[] = [{ id: ID, name: 'Box', model: { kind: 'builtin', id: 'box' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }];
  applySceneCommand(doc, { type: 'create', objects }, Symbol('fixture'), true, NAME);
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: myRole === 'viewer', connected: true, hasEverSynced: true, writeAccess: myRole === 'viewer' ? 'denied' : 'granted', refused: false, awareness: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
  render(<QueryClientProvider client={client}><TooltipProvider><div data-space-outlet='scene'><Bound session={session} myRole={myRole} /></div></TooltipProvider></QueryClientProvider>);
  await screen.findByTestId('scene-native-boundary');
  return { session };
}

const trigger = (): HTMLElement => screen.getByTestId('scene-viewfinder-trigger');
const minimapButton = (): HTMLElement => within(screen.getByTestId('scene-viewport-toolbar')).getByRole('button', { name: t('spaces.threeD.minimap') });
const menu = (): HTMLElement => screen.getByTestId('scene-viewfinder-menu');
const button = (key: string): HTMLElement => within(menu()).getByRole('button', { name: t(`spaces.threeD.viewfinder.${key}`) });

/**
 * Open the viewfinder and press Confirm.
 * @throws {Error} When the capture menu does not appear.
 */
async function capture(): Promise<void> {
  fireEvent.click(trigger());
  fireEvent.click(button('confirm'));
  await within(menu()).findByRole('button', { name: t('spaces.threeD.viewfinder.toAgent') });
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  h.modelState = 'ready';
  h.capture.mockReset().mockResolvedValue({ width: 2048, height: 1152, pixels: new Uint8Array(4) });
  h.spaces = [{ id: 'c2', name: 'Second', type: 'canvas', createdAt: 2 }, { id: 'd1', name: 'Notes', type: 'document', createdAt: 1 }, { id: 'c1', name: 'First', type: 'canvas', createdAt: 1 }];
  h.placeImageOnCanvas.mockReset().mockResolvedValue({ status: 'uploaded', nodeId: 'n1' });
  h.openTray.mockReset().mockResolvedValue({ conversationId: 'conv', limits: { maxItems: 5, maxChars: 1000 } });
  h.uploadTrayItem.mockReset().mockResolvedValue('ready');
  h.add.mockReset().mockReturnValue('added');
  Object.values(h.toast).forEach((fn) => fn.mockReset());
  h.clipboardWrite.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: h.clipboardWrite } });
  (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = class { constructor(readonly items: Record<string, Blob>) {} };
  URL.createObjectURL = vi.fn(() => 'blob:shot');
  URL.revokeObjectURL = vi.fn();
  useCanvasRevealStore.setState({ request: null });
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); owner.client.clear(); }
  useUIStore.getState().setActiveOverlayId(null);
  vi.restoreAllMocks();
});

describe('the viewfinder entry (acceptance 1)', () => {
  it('sits top-right whether or not anything is selected, and is unavailable to a Viewer', async () => {
    const { session } = await setup();
    expect(trigger()).toBeEnabled();
    act(() => session.select(ID, false));
    expect(trigger()).toBeEnabled();
    cleanup();
    await setup('viewer');
    expect(trigger()).toBeDisabled();
  });
});

describe('framing (acceptance 2)', () => {
  it('puts away the minimap and the creation menu without changing the stored minimap choice, and brings them back', async () => {
    await setup();
    expect(screen.getByTestId('scene-map')).toBeInTheDocument();
    fireEvent.click(trigger());
    expect(screen.getByTestId('scene-viewfinder-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-map')).toBeNull();
    expect(screen.queryByTestId('scene-left-menu')).toBeNull();
    expect(minimapButton()).toBeDisabled();
    fireEvent.click(button('cancel'));
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();
    expect(screen.getByTestId('scene-map')).toBeInTheDocument();
    expect(screen.getByTestId('scene-left-menu')).toBeInTheDocument();
    expect(minimapButton()).toBeEnabled();
  });

  it('offers the eight ratios with 16:9 first chosen, the output size and four square corners', async () => {
    await setup();
    fireEvent.click(trigger());
    expect(within(menu()).getByRole('combobox')).toHaveTextContent('16:9');
    expect(menu()).toHaveTextContent(t('spaces.threeD.viewfinder.size', { width: 2048, height: 1152 }));
    for (const corner of ['nw', 'ne', 'sw', 'se']) expect(screen.getByTestId(`scene-viewfinder-corner-${corner}`)).toHaveAttribute('data-shape', 'square');
  });

  it('does not open the properties panel when an object is selected while framing', async () => {
    const { session } = await setup();
    fireEvent.click(trigger());
    act(() => session.select(ID, false));
    expect(screen.queryByTestId('scene-right-panel')).toBeNull();
    expect(screen.getByTestId('scene-object-menu')).toBeInTheDocument();
  });

  it('closes on the button and on Escape, keeping the selection', async () => {
    const { session } = await setup();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();
    fireEvent.click(trigger());
    act(() => session.select(ID, false));
    fireEvent.keyDown(screen.getByTestId('scene-native-boundary'), { key: 'Escape' });
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
  });
});

describe('capturing (acceptance 3 and 4)', () => {
  it('does not capture while a model is loading and says so', async () => {
    h.modelState = 'loading';
    await setup();
    fireEvent.click(trigger());
    expect(button('confirm')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button('confirm'));
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.toast.warning).toHaveBeenCalledWith(t('spaces.threeD.viewfinder.modelsLoading'));
  });

  it('captures the frame at a 2048 long edge, locks the view and offers the destinations', async () => {
    await setup();
    await capture();
    expect(h.capture).toHaveBeenCalledOnce();
    const [frame, size] = h.capture.mock.calls[0] as [{ width: number; height: number }, { width: number; height: number }];
    expect(Math.max(size.width, size.height)).toBe(2048);
    expect(size.width / size.height).toBeCloseTo(frame.width / frame.height, 2);
    expect(h.viewport?.viewLocked).toBe(true);
    for (const key of ['toAgent', 'toCanvas', 'copy', 'reframe']) expect(button(key)).toBeEnabled();
    expect(screen.queryByTestId('scene-viewfinder-corner-nw')).toBeNull();
    fireEvent.click(button('reframe'));
    expect(button('confirm')).toBeInTheDocument();
    expect(h.viewport?.viewLocked).toBe(false);
  });
});

describe('the destinations (acceptance 5 to 8)', () => {
  it('adds the shot to the Agent tray, then closes with a success toast', async () => {
    await setup();
    await capture();
    fireEvent.click(button('toAgent'));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith(t('spaces.threeD.viewfinder.addedToAgent')));
    expect(useUIStore.getState().chatPanelCollapsed).toBe(false);
    expect(h.add).toHaveBeenCalledWith('conv', [expect.objectContaining({ type: 'image', status: 'uploading' })], { maxItems: 5, maxChars: 1000 });
    expect(h.uploadTrayItem).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();
  });

  it('stays on the captured shot when the Agent upload fails', async () => {
    h.uploadTrayItem.mockResolvedValue('failed');
    await setup();
    await capture();
    fireEvent.click(button('toAgent'));
    await waitFor(() => expect(button('toAgent')).toBeEnabled());
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('scene-viewfinder-frame')).toBeInTheDocument();
  });

  it('lists every canvas in creation order even when there is one, and places on the one clicked', async () => {
    await setup();
    await capture();
    fireEvent.click(button('toCanvas'));
    const list = await screen.findByTestId('scene-viewfinder-canvas-list');
    expect(within(list).getAllByRole('button').map((item) => item.textContent)).toEqual(['First', 'Second']);
    expect(button('toAgent')).toBeDisabled();
    fireEvent.click(within(list).getByRole('button', { name: 'Second' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(h.placeImageOnCanvas).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', spaceId: 'c2', size: { width: 2048, height: 1152 } }));
    const [message, options] = h.toast.success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(message).toBe(t('spaces.threeD.viewfinder.addedToCanvas', { name: 'Second' }));
    expect(options.action.label).toBe(t('spaces.threeD.viewfinder.view'));
    options.action.onClick();
    expect(useCanvasRevealStore.getState().request).toEqual({ spaceId: 'c2', nodeId: 'n1' });
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();
  });

  it('asks for a new canvas when there is none', async () => {
    h.spaces = [];
    await setup();
    await capture();
    fireEvent.click(button('toCanvas'));
    const list = await screen.findByTestId('scene-viewfinder-canvas-list');
    expect(list).toHaveTextContent(t('spaces.threeD.viewfinder.noCanvas'));
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
  });

  it.each([
    { outcome: { status: 'unreachable' }, key: 'canvasUnreachable', stays: true },
    { outcome: { status: 'lost' }, key: 'canvasLost', stays: true },
    { outcome: { status: 'upload_failed', nodeId: 'n1', toasted: false }, key: 'canvasUploadFailed', stays: false },
  ])('tells a canvas $outcome.status and stays only when nothing was placed', async ({ outcome, key, stays }) => {
    h.placeImageOnCanvas.mockResolvedValue(outcome);
    await setup();
    await capture();
    fireEvent.click(button('toCanvas'));
    fireEvent.click(within(await screen.findByTestId('scene-viewfinder-canvas-list')).getByRole('button', { name: 'First' }));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(t(`spaces.threeD.viewfinder.${key}`, { name: 'First' })));
    expect(screen.queryByTestId('scene-viewfinder-frame') !== null).toBe(stays);
  });

  it('says nothing more when a failed canvas upload already told the user', async () => {
    h.placeImageOnCanvas.mockResolvedValue({ status: 'upload_failed', nodeId: 'n1', toasted: true });
    await setup();
    await capture();
    fireEvent.click(button('toCanvas'));
    fireEvent.click(within(await screen.findByTestId('scene-viewfinder-canvas-list')).getByRole('button', { name: 'First' }));
    await waitFor(() => expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull());
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('copies the PNG and closes, or stays when the browser refuses', async () => {
    await setup();
    await capture();
    fireEvent.click(button('copy'));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith(t('spaces.threeD.viewfinder.copied')));
    expect(h.clipboardWrite).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();

    h.clipboardWrite.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await capture();
    fireEvent.click(button('copy'));
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith(t('spaces.threeD.viewfinder.copyFailed')));
    expect(button('copy')).toBeEnabled();
  });

  it('keeps every other destination and re-frame unavailable while one is sending, and closes mid-send on the button', async () => {
    let finish: (value: unknown) => void = () => undefined;
    h.placeImageOnCanvas.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await setup();
    await capture();
    fireEvent.click(button('toCanvas'));
    fireEvent.click(within(await screen.findByTestId('scene-viewfinder-canvas-list')).getByRole('button', { name: 'First' }));
    await waitFor(() => expect(button('toCanvas')).toHaveAttribute('aria-busy', 'true'));
    for (const key of ['toAgent', 'copy', 'reframe']) expect(button(key)).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();
    await act(async () => { finish({ status: 'unreachable' }); await Promise.resolve(); });
    expect(h.toast.error).toHaveBeenCalledWith(t('spaces.threeD.viewfinder.canvasUnreachable', { name: 'First' }));
    expect(screen.queryByTestId('scene-viewfinder-frame')).toBeNull();
  });
});
