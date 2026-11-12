// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Frame } from 'lucide-react';

import type { SceneCaptureConfig } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useTranslation } from '@web/i18n/use-translation';
import { readSpaceViewport } from '@web/lib/project-tabs-storage';
import { cn } from '@web/lib/utils';
import { toast } from '@web/lib/toast';
import { placeImageOnCanvas } from '@web/spaces/canvas/place-image-on-canvas';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { encodeCapturePng } from '@web/spaces/three-d/viewfinder/encode-capture';
import {
  VIEWFINDER_RATIOS,
  captureSize,
  largestFrame,
  menuCentre,
  refitFrame,
  resizeFrame,
  viewfinderRatioValue,
  viewfinderSafeArea,
  type ViewfinderCorner,
  type ViewfinderRatio,
  type ViewfinderRect,
} from '@web/spaces/three-d/viewfinder/viewfinder-geometry';
import { copyCapture, sendCaptureToAgent } from '@web/spaces/three-d/viewfinder/viewfinder-send';
import type { ViewfinderAction, ViewfinderOutcome, ViewfinderState, ViewfinderTarget } from '@web/spaces/three-d/viewfinder/viewfinder-state';
import type { SceneFrameCapture } from '@web/spaces/three-d/viewport/scene-viewport-props';
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';

const frameIcon = <Frame className='size-4' />;
const CORNERS: readonly ViewfinderCorner[] = ['nw', 'ne', 'sw', 'se'];
const CORNER_POSITION: Readonly<Record<ViewfinderCorner, string>> = {
  nw: '-left-[5px] -top-[5px] cursor-nwse-resize',
  ne: '-right-[5px] -top-[5px] cursor-nesw-resize',
  sw: '-bottom-[5px] -left-[5px] cursor-nesw-resize',
  se: '-bottom-[5px] -right-[5px] cursor-nwse-resize',
};
// What the chrome around the frame covers, in pixels: the top clears the
// viewfinder bar (10 + 42 + 10); the bottom keeps the menu under the frame
// (44 + 8) above the object toolbar (16 + 42 + 8), whether or not it shows;
// the right edge stops at an open right panel (10 + 320 + 10).
const INSETS = { top: 62, bottom: 118, side: 20, panel: 340 };
// The menu sits this far below the frame.
const MENU_GAP = 8;

export interface SceneViewfinderProps {
  state: ViewfinderState;
  dispatch: React.Dispatch<ViewfinderAction>;
  /** The 3D stage's size. */
  stage: { width: number; height: number };
  rightPanelOpen: boolean;
  /** The viewport's capture, while it lives. */
  capture: SceneFrameCapture | null;
  modelsLoading: boolean;
  /** A Viewer cannot capture. */
  disabled: boolean;
  /** The chat is switching conversations; nothing can be added to it meanwhile. */
  chatSwitching: boolean;
  projectId: string;
  spaceId: string;
  spaceName: string;
  userId: string;
  config: SceneCaptureConfig | undefined;
  spaces: readonly ProjectSpace[];
}

/**
 * The file name of a capture: the 3D Space's name and the local time.
 * @param spaceName - The 3D Space's name.
 * @returns The name.
 */
function captureFileName(spaceName: string): string {
  const now = new Date();
  /**
   * Two digits.
   * @param value - A date part.
   * @returns It, zero-padded.
   */
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `3D-${spaceName.replace(/[\\/:*?"<>|]/g, '_')}-${stamp}.png`;
}

/**
 * Where on a canvas a capture starts looking for room: the middle of that
 * canvas's last view, or the origin when it was never opened here.
 * @param userId - The signed-in account.
 * @param projectId - The project.
 * @param canvasId - The canvas.
 * @returns A point in canvas coordinates.
 */
function canvasOrigin(userId: string, projectId: string, canvasId: string): { x: number; y: number } {
  const view = readSpaceViewport(userId, projectId, canvasId);
  if (view === null || view.zoom <= 0) return { x: 0, y: 0 };
  // ponytail: the window stands in for the canvas pane, whose size is unknown while its tab is closed.
  return { x: (window.innerWidth / 2 - view.x) / view.zoom, y: (window.innerHeight / 2 - view.y) / view.zoom };
}

/**
 * The viewfinder of a 3D Space (#1411): the persistent top-right button, the
 * frame with its corners and the menu under it, the capture and its three
 * destinations. Its state is held by the editor, which also hides the minimap
 * and the creation menu while it is open.
 * @param props - See {@link SceneViewfinderProps}.
 * @returns The viewfinder.
 */
export const SceneViewfinder = React.memo(function SceneViewfinder(props: SceneViewfinderProps): React.JSX.Element {
  const { state, dispatch, stage, rightPanelOpen, capture, modelsLoading, disabled, chatSwitching, projectId, spaceId, spaceName, userId, config, spaces } = props;
  const t = useTranslation();
  const { phase, frame, ratio, shot, sending } = state;
  const safe = React.useMemo(() => viewfinderSafeArea(stage, {
    top: INSETS.top, bottom: INSETS.bottom, left: INSETS.side, right: rightPanelOpen ? INSETS.panel : INSETS.side,
  }), [stage, rightPanelOpen]);
  const ratioValue = viewfinderRatioValue(ratio);
  const canvases = React.useMemo(() => spaces.filter((space) => space.type === 'canvas')
    .map((space, index) => ({ space, index }))
    .sort((a, b) => (a.space.createdAt ?? 0) - (b.space.createdAt ?? 0) || a.index - b.index)
    .map(({ space }) => space), [spaces]);

  // Put the frame back whenever the safe area changes: a window resize, the chat column, the right panel.
  const placedIn = React.useRef(safe);
  React.useEffect(() => {
    const from = placedIn.current;
    placedIn.current = safe;
    if (phase === 'off' || (from.width === safe.width && from.height === safe.height && from.x === safe.x && from.y === safe.y)) return;
    if (frame.width > 0 && frame.height > 0) dispatch({ type: 'frame', frame: refitFrame(frame, from, safe, ratioValue) });
  }, [safe, phase, frame, ratioValue, dispatch]);

  // The menu's width, so it can be kept inside the Space (it changes with the state and the locale).
  const [menuWidth, setMenuWidth] = React.useState(0);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const setMenu = React.useCallback((element: HTMLDivElement | null): void => { menuRef.current = element; }, []);
  React.useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    /**
     * Read the menu's laid-out width.
     * @returns Nothing.
     */
    const measure = (): void => setMenuWidth(element.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [phase]);

  // The phase as of the last press, ahead of the next render: a second press that lands before
  // React re-renders reads it here, so one press starts one send.
  const pressed = React.useRef(phase);
  pressed.current = phase;
  // Changes each time the viewfinder opens; a capture is kept only by the opening that started it.
  const opening = React.useRef(0);
  const capturing = React.useRef(false);

  const toggle = React.useCallback((): void => {
    if (phase !== 'off') { dispatch({ type: 'close' }); return; }
    opening.current += 1;
    placedIn.current = safe;
    dispatch({ type: 'open', frame: largestFrame(ratioValue, safe) });
  }, [phase, safe, ratioValue, dispatch]);

  const changeRatio = React.useCallback((next: string): void => {
    const value = VIEWFINDER_RATIOS.find((key) => key === next);
    if (value === undefined) return;
    const nextRatio = viewfinderRatioValue(value);
    dispatch({ type: 'ratio', ratio: value, frame: nextRatio === null ? frame : largestFrame(nextRatio, safe) });
  }, [frame, safe, dispatch]);

  const drag = React.useRef<{ corner: ViewfinderCorner; start: ViewfinderRect; origin: { x: number; y: number } } | null>(null);
  const onCornerDown = React.useCallback((event: React.PointerEvent<HTMLSpanElement>): void => {
    const corner = event.currentTarget.dataset.corner as ViewfinderCorner | undefined;
    if (corner === undefined || config === undefined) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { corner, start: frame, origin: { x: event.clientX, y: event.clientY } };
  }, [frame, config]);
  const onCornerMove = React.useCallback((event: React.PointerEvent<HTMLSpanElement>): void => {
    const gesture = drag.current;
    // A drag the viewfinder closed during never got its pointerup; a move without the button held ends it.
    if (gesture === null || config === undefined || (event.buttons & 1) === 0) { drag.current = null; return; }
    const { corner, start, origin } = gesture;
    const at = { x: (corner.includes('e') ? start.x + start.width : start.x) + event.clientX - origin.x,
      y: (corner.includes('s') ? start.y + start.height : start.y) + event.clientY - origin.y };
    dispatch({ type: 'frame', frame: resizeFrame(start, corner, at, safe, ratioValue, config.minFramePx) });
  }, [safe, ratioValue, config, dispatch]);
  const onCornerUp = React.useCallback((): void => { drag.current = null; }, []);

  const confirm = React.useCallback(async (): Promise<void> => {
    if (modelsLoading) { toast.warning(t('spaces.threeD.viewfinder.modelsLoading')); return; }
    if (capture === null || config === undefined || capturing.current) return;
    capturing.current = true;
    const started = opening.current;
    try {
      const size = captureSize(frame, config.longEdgePx);
      const blob = await encodeCapturePng(await capture(frame, size));
      if (opening.current !== started || pressed.current !== 'framing') return;
      const file = new File([blob], captureFileName(spaceName), { type: 'image/png' });
      dispatch({ type: 'captured', shot: { file, url: URL.createObjectURL(blob), ...size } });
    } catch (err) {
      console.warn('viewfinder capture failed', err);
      toast.error(t('spaces.threeD.viewfinder.captureFailed'));
    } finally {
      capturing.current = false;
    }
  }, [modelsLoading, capture, config, frame, spaceName, dispatch, t]);

  // The preview's address lives as long as its shot.
  React.useEffect(() => {
    if (shot === null) return;
    return () => URL.revokeObjectURL(shot.url);
  }, [shot]);

  /**
   * Send the shot to one destination; its result only touches this capture.
   * @param target - The destination.
   * @param run - The send, answering how the viewfinder goes on.
   */
  const send = React.useCallback((target: ViewfinderTarget, run: () => Promise<ViewfinderOutcome>): void => {
    if (pressed.current !== (target === 'canvas' ? 'picking' : 'captured')) return;
    pressed.current = 'sending';
    const session = state.session;
    dispatch({ type: 'send', target });
    void run().then((outcome) => dispatch({ type: 'settle', session, outcome }));
  }, [state.session, dispatch]);

  const toAgent = React.useCallback((): void => {
    if (shot === null) return;
    const { file } = shot;
    send('agent', async () => {
      if (!(await sendCaptureToAgent({ projectId, spaceId }, file))) return 'retry';
      toast.success(t('spaces.threeD.viewfinder.addedToAgent'));
      return 'done';
    });
  }, [shot, send, projectId, spaceId, t]);

  const copy = React.useCallback((): void => {
    if (shot === null) return;
    const { file } = shot;
    send('copy', async () => {
      if (!(await copyCapture(file))) { toast.error(t('spaces.threeD.viewfinder.copyFailed')); return 'retry'; }
      toast.success(t('spaces.threeD.viewfinder.copied'));
      return 'done';
    });
  }, [shot, send, t]);

  const toCanvas = React.useCallback((canvas: ProjectSpace): void => {
    if (shot === null || config === undefined) return;
    const { file, width, height } = shot;
    const name = canvas.name;
    send('canvas', async () => {
      const placed = await placeImageOnCanvas({ projectId, spaceId: canvas.id, file, size: { width, height }, userId,
        origin: canvasOrigin(userId, projectId, canvas.id), syncTimeoutMs: config.canvasSyncTimeoutMs });
      switch (placed.status) {
        case 'uploaded':
          toast.success(t('spaces.threeD.viewfinder.addedToCanvas', { name }), {
            action: { label: t('spaces.threeD.viewfinder.view'), onClick: () => useCanvasRevealStore.getState().reveal(canvas.id, placed.nodeId) },
          });
          return 'done';
        case 'unreachable':
          toast.error(t('spaces.threeD.viewfinder.canvasUnreachable', { name }));
          return 'retry';
        case 'lost':
          toast.error(t('spaces.threeD.viewfinder.canvasLost', { name }));
          return 'retry';
        case 'refused':
          return 'retry';
        case 'upload_failed':
          if (!placed.toasted) toast.error(t('spaces.threeD.viewfinder.canvasUploadFailed', { name }));
          return 'close';
      }
    });
  }, [shot, config, send, projectId, userId, t]);

  const onListOpen = React.useCallback((open: boolean): void => {
    dispatch(open ? { type: 'pick' } : { type: 'unpick' });
  }, [dispatch]);

  const trigger = <div className='absolute right-[var(--space-5)] top-[var(--space-5)] z-20 flex rounded-md border border-border bg-popover py-1 shadow'>
    <div className='flex px-1'>
      <SceneIconButton data-testid='scene-viewfinder-trigger' label={t('spaces.threeD.viewfinder.open')} active={phase !== 'off'}
        disabled={disabled || config === undefined} onClick={toggle}>{frameIcon}</SceneIconButton>
    </div>
  </div>;
  if (phase === 'off') return trigger;

  const busy = phase === 'sending';
  const framing = phase === 'framing';
  const size = config === undefined ? null : captureSize(frame, config.longEdgePx);
  const menuTop = frame.y + frame.height + MENU_GAP;
  const frameStyle = { left: frame.x, top: frame.y, width: frame.width, height: frame.height };
  return <>
    {trigger}
    {/* Beneath the floating toolbars (z-10), so they stay readable while the scene is dimmed. */}
    <div className='pointer-events-none absolute inset-0 z-[5] overflow-hidden'>
      <div data-testid='scene-viewfinder-frame' className='absolute border border-active-border shadow-[0_0_0_9999px_var(--color-overlay)]' style={frameStyle}>
        {framing ? CORNERS.map((corner) => <span key={corner} data-testid={`scene-viewfinder-corner-${corner}`} data-corner={corner}
          data-shape={ratioValue === null ? 'round' : 'square'}
          className={cn('pointer-events-auto absolute size-2.5 touch-none border border-active-border bg-background', ratioValue === null ? 'rounded-full' : 'rounded-none', CORNER_POSITION[corner])}
          onPointerDown={onCornerDown} onPointerMove={onCornerMove} onPointerUp={onCornerUp} onPointerCancel={onCornerUp} />) : null}
      </div>
    </div>
    <div ref={setMenu} data-testid='scene-viewfinder-menu' className='absolute z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-md border border-border bg-popover p-1 text-xs shadow'
      style={{ left: menuCentre(frame, menuWidth, safe.x + safe.width + INSETS.side, INSETS.side), top: menuTop }}>
      {framing ? <React.Fragment key='framing'>
        <Select value={ratio} onValueChange={changeRatio}>
          <SelectTrigger aria-label={t('spaces.threeD.viewfinder.ratio')} className='h-8 w-24 text-xs'><SelectValue /></SelectTrigger>
          <SelectContent>{VIEWFINDER_RATIOS.map((key: ViewfinderRatio) => <SelectItem key={key} value={key}>{key}</SelectItem>)}</SelectContent>
        </Select>
        {size ? <span className='px-1 tabular-nums text-muted-foreground'>{t('spaces.threeD.viewfinder.size', { width: size.width, height: size.height })}</span> : null}
        <Button size='sm' variant='outline' onClick={() => dispatch({ type: 'close' })}>{t('spaces.threeD.viewfinder.cancel')}</Button>
        <Button size='sm' aria-disabled={modelsLoading || undefined} className={cn(modelsLoading && 'opacity-50')} onClick={() => { void confirm(); }}>{t('spaces.threeD.viewfinder.confirm')}</Button>
      </React.Fragment> : <React.Fragment key='captured'>
        {shot ? <img src={shot.url} alt='' className='h-8 rounded-sm border border-border' style={{ aspectRatio: `${shot.width} / ${shot.height}` }} /> : null}
        <Button size='sm' variant='outline' loading={sending === 'agent'} disabled={busy || phase === 'picking' || chatSwitching} onClick={toAgent}>{t('spaces.threeD.viewfinder.toAgent')}</Button>
        <Popover open={phase === 'picking'} onOpenChange={onListOpen}>
          <PopoverTrigger asChild>
            <Button size='sm' variant='outline' loading={sending === 'canvas'} disabled={busy && sending !== 'canvas'}>{t('spaces.threeD.viewfinder.toCanvas')}</Button>
          </PopoverTrigger>
          <PopoverContent side='top' align='center' className='w-56 p-1' data-testid='scene-viewfinder-canvas-list'>
            <p className='px-2 py-1.5 text-xs font-medium'>{t('spaces.threeD.viewfinder.canvasListTitle')}</p>
            {canvases.length === 0 ? <p className='px-2 py-1.5 text-xs text-muted-foreground'>{t('spaces.threeD.viewfinder.noCanvas')}</p>
              : canvases.map((canvas) => <Button key={canvas.id} variant='ghost' size='sm' className='w-full justify-start truncate' onClick={() => toCanvas(canvas)}>{canvas.name}</Button>)}
          </PopoverContent>
        </Popover>
        <Button size='sm' variant='outline' loading={sending === 'copy'} disabled={busy || phase === 'picking'} onClick={copy}>{t('spaces.threeD.viewfinder.copy')}</Button>
        <Button size='sm' variant='outline' disabled={busy || phase === 'picking'} onClick={() => dispatch({ type: 'reframe' })}>{t('spaces.threeD.viewfinder.reframe')}</Button>
      </React.Fragment>}
    </div>
  </>;
});
