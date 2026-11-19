// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import type { MiniToolAnalysisResult, VideoToolDraftById } from '@breatic/shared/mini-tools';
import type { TrackedBox } from '@web/spaces/canvas/mini-tool/video/tracked-box';

export type VideoEraseRegion = VideoToolDraftById['video.erase']['params']['region'];
export interface VideoToolNodeOverlayProps {
  region?: VideoEraseRegion;
  onRegion?: (region: VideoEraseRegion) => void;
  selection?: 'rectangle' | 'point';
  people?: Extract<MiniToolAnalysisResult, { kind: 'people' }>;
  activePersonId?: string | null;
  onPerson?: (personId: string) => void;
  /** The people a press would take past the people limit: dimmed and aria-disabled, their press still reported to say so. */
  cappedPersonIds?: ReadonlySet<string>;
  /** The box following the tracked object on the presented frame; the selection box is drawn there while present (§10.3). */
  trackedBox?: TrackedBox | null;
  /** Whether the tracking applies to the current selection, which the chip on the video says. */
  tracked?: boolean;
  disabled: boolean;
  revision: string;
  sourceEpoch: number;
  seekEpoch: number;
}

/**
 * Keeps a point inside the original source's normalized bounds.
 * @throws {never} Never.
 * @param value - The current value value.
 * @returns The current value derived from these inputs.
 */
function unit(value: number): number { return Math.min(1, Math.max(0, value)); }

/**
 * Draws source-space region and person controls over the existing source player.
 * @param props - The current draft geometry and source presentation epochs.
 * @returns The controlled source selection layer.
 * @throws {never} Never.
 */
export function VideoToolNodeOverlay(props: VideoToolNodeOverlayProps): React.JSX.Element {
  const t = useTranslation();
  const root = React.useRef<HTMLDivElement>(null);
  const [preview, setPreview] = React.useState<VideoEraseRegion | null>(null);
  const gesture = React.useRef<{ pointerId: number; x: number; y: number; region: VideoEraseRegion; mode: string; latest: VideoEraseRegion | null; revision: string; sourceEpoch: number; seekEpoch: number } | null>(null);
  const latest = React.useRef(props);
  latest.current = props;
  const region = preview ?? props.region;
  // After tracking the selection box is drawn where the object is on the presented frame, in the success colour, and an
  // edit starts from there (execution design §10.3; demo SelectionOverlay); a preview is the user's edit in progress.
  const following = preview === null && props.trackedBox != null;
  const shownBox = following ? props.trackedBox! : region?.box ?? null;
  const selected = props.region !== undefined && (props.region.box !== null || props.region.points.length > 0);
  React.useEffect(() => { gesture.current = null; setPreview(null); }, [props.revision, props.sourceEpoch, props.seekEpoch, props.disabled]);
  React.useEffect(() => {
    /**
     * Cancels local uncommitted geometry when the document loses focus.
     * @throws {never} Never.
     */
    function cancel(): void { gesture.current = null; setPreview(null); }
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  /**
   * Converts screen-space pointers using the transformed source's actual box.
   * @param event - The current pointer event.
   * @returns A normalized point on the original source.
   * @throws {never} Never.
   */
  function point(event: React.PointerEvent): { x: number; y: number } {
    const box = root.current?.getBoundingClientRect();
    return box === undefined ? { x: 0, y: 0 } : { x: unit((event.clientX - box.left) / box.width), y: unit((event.clientY - box.top) / box.height) };
  }
  /**
   * Starts one attachment-scoped region edit from the authoritative revision.
   * @param event - The pointer that owns the gesture.
   * @param mode - Draw, move or one named source-box handle.
   * @throws {never} Never.
   */
  function begin(event: React.PointerEvent, mode: string): void {
    if (props.disabled || props.region === undefined || props.onRegion === undefined || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    root.current?.focus();
    const at = point(event);
    if (mode === 'draw' && props.selection === 'point') { props.onRegion({ ...props.region, points: [...props.region.points, { ...at, label: event.altKey ? 'negative' : 'positive' }] }); return; }
    gesture.current = { pointerId: event.pointerId, ...at, region: mode === 'draw' || shownBox === null ? props.region : { ...props.region, box: shownBox }, mode, latest: null, revision: props.revision, sourceEpoch: props.sourceEpoch, seekEpoch: props.seekEpoch };
    root.current?.setPointerCapture(event.pointerId);
  }
  /**
   * Updates only the transient geometry owned by this pointer.
   * @param event - The pointer's new source position.
   * @throws {never} Never.
   */
  function move(event: React.PointerEvent): void {
    const held = gesture.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const at = point(event);
    const initial = held.region.box;
    let box: VideoEraseRegion['box'];
    if (held.mode === 'draw') box = { x: Math.min(held.x, at.x), y: Math.min(held.y, at.y), width: Math.abs(at.x - held.x), height: Math.abs(at.y - held.y) };
    else if (initial === null) return;
    else if (held.mode === 'move') box = { ...initial, x: Math.max(0, Math.min(1 - initial.width, initial.x + at.x - held.x)), y: Math.max(0, Math.min(1 - initial.height, initial.y + at.y - held.y)) };
    else {
      const left = held.mode.includes('w') ? Math.min(at.x, initial.x + initial.width) : initial.x;
      const top = held.mode.includes('n') ? Math.min(at.y, initial.y + initial.height) : initial.y;
      const right = held.mode.includes('e') ? Math.max(at.x, initial.x) : initial.x + initial.width;
      const bottom = held.mode.includes('s') ? Math.max(at.y, initial.y) : initial.y + initial.height;
      box = { x: left, y: top, width: right - left, height: bottom - top };
    }
    if (box.width > 0 && box.height > 0) { held.latest = { ...held.region, box }; setPreview(held.latest); }
  }
  /**
   * Commits only if no remote, source, seek or permission change superseded it.
   * @param event - The completing or cancelling pointer.
   * @throws {never} Never.
   */
  function finish(event: React.PointerEvent): void {
    const held = gesture.current;
    gesture.current = null;
    if (held !== null && held.pointerId === event.pointerId && event.type !== 'pointercancel' && !latest.current.disabled && latest.current.revision === held.revision && latest.current.sourceEpoch === held.sourceEpoch && latest.current.seekEpoch === held.seekEpoch && held.latest !== null) latest.current.onRegion?.(held.latest);
    setPreview(null);
  }
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The source selection group owns geometry keyboard commands; its handles remain native focusable buttons.
  return <div ref={root} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} role='group' tabIndex={props.disabled ? undefined : 0} onKeyDown={(event) => {
    if (props.disabled || props.region === undefined || props.onRegion === undefined) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); props.onRegion({ box: null, points: [] }); return; }
    const box = shownBox;
    if (box === null || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const delta = event.shiftKey ? 0.02 : 0.005;
    const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0;
    const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0;
    const handle = event.target instanceof HTMLElement ? event.target.dataset.regionHandle : undefined;
    if (handle === undefined) props.onRegion({ ...props.region, box: { ...box, x: Math.min(1 - box.width, Math.max(0, box.x + dx)), y: Math.min(1 - box.height, Math.max(0, box.y + dy)) } });
    else {
      const left = handle.includes('w') ? unit(box.x + dx) : box.x;
      const top = handle.includes('n') ? unit(box.y + dy) : box.y;
      const right = handle.includes('e') ? unit(box.x + box.width + dx) : box.x + box.width;
      const bottom = handle.includes('s') ? unit(box.y + box.height + dy) : box.y + box.height;
      if (right > left && bottom > top) props.onRegion({ ...props.region, box: { x: left, y: top, width: right - left, height: bottom - top } });
    }
  }} className='nodrag nopan nokey nowheel pointer-events-none absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring' data-testid='video-tool-node-overlay'>
    {props.region === undefined ? null : <div data-testid='video-tool-region-gesture' role='presentation' className='pointer-events-auto absolute inset-0 cursor-crosshair' onPointerDown={(event) => begin(event, 'draw')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />}
    {shownBox === null ? null : <div data-testid='video-tool-region-box' className={`pointer-events-auto absolute cursor-move border ${following ? 'border-status-success bg-status-success/10' : 'border-status-selected bg-status-selected/10'}`} style={{ left: `${shownBox.x * 100}%`, top: `${shownBox.y * 100}%`, width: `${shownBox.width * 100}%`, height: `${shownBox.height * 100}%` }} onPointerDown={(event) => begin(event, 'move')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>{['nw', 'ne', 'sw', 'se'].map((handle) => <Button key={handle} data-region-handle={handle} variant={null} size={null} disabled={props.disabled} className={`absolute size-2 rounded-none border bg-popover ${following ? 'border-status-success' : 'border-status-selected'}`} style={{ left: handle.includes('w') ? 0 : '100%', top: handle.includes('n') ? 0 : '100%', transform: 'translate(-50%,-50%)', cursor: `${handle}-resize` }} onPointerDown={(event) => begin(event, handle)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />)}</div>}
    {region?.points.map((at, index) => <Button key={index} variant={null} size={null} disabled={props.disabled} className='pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-status-selected bg-popover' style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }} onClick={() => props.onRegion?.({ ...region, points: region.points.filter((_, position) => position !== index) })}>{at.label === 'positive' ? '+' : '−'}</Button>)}
    {/* While the player's control bar is shown it sits above it: the bar's buttons (--btn-inline) over its pb-1.5, plus this chip's bottom-2 gap. */}
    {props.region === undefined ? null : <span data-testid='video-tool-selection-status' className='pointer-events-none absolute bottom-2 left-2 group-data-[controls=shown]/media-overlay:bottom-[calc(var(--btn-inline)+0.875rem)] flex items-center gap-1 rounded-chrome bg-popover px-2 py-1 text-xs'>{props.tracked === true ? <Check className='size-3 text-status-success' aria-hidden='true' /> : null}{t(props.tracked === true ? 'canvas.miniTool.videoUI.tracked' : props.selection === 'point' ? 'canvas.miniTool.videoUI.point' : 'canvas.miniTool.videoUI.drawBox')}</span>}
    {selected ? <Button variant='outline' size='compact' disabled={props.disabled} aria-label={t('canvas.miniTool.videoUI.resetSelection')} className='pointer-events-auto absolute right-2 top-2' onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); props.onRegion?.({ box: null, points: [] }); }}><RotateCcw className='size-3' /></Button> : null}
    {/* Demo FaceOverlay: only the active row's person is drawn selected; the others stay neutral. */}
    {props.people?.people.map((person, index) => { const active = props.activePersonId === person.personId; const capped = props.cappedPersonIds?.has(person.personId) === true; return <Button key={person.personId} variant={null} size={null} disabled={props.disabled} aria-pressed={active} aria-disabled={capped ? true : undefined} className={`pointer-events-auto absolute border border-dashed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-disabled:opacity-50 ${active ? 'border-status-selected bg-status-selected/10' : 'border-border bg-background/15'}`} style={{ left: `${person.faceBox.x * 100}%`, top: `${person.faceBox.y * 100}%`, width: `${person.faceBox.width * 100}%`, height: `${person.faceBox.height * 100}%` }} onClick={(event) => { event.stopPropagation(); props.onPerson?.(person.personId); }}><span className={`absolute left-0 top-full mt-1 whitespace-nowrap rounded-chrome border border-border bg-popover px-1.5 py-0.5 text-xs ${active ? 'ring-1 ring-status-selected' : ''}`}>{t('canvas.miniTool.videoUI.personNumber', { number: index + 1 })}</span></Button>; })}
  </div>;
}
