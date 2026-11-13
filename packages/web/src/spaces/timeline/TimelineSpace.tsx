// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type * as Y from 'yjs';
import { ArrowRightToLine, Code, Copy, Film, Link2, ListChecks, Magnet, Pause, Play, Plus, Redo2, Scissors, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  newId, TIMELINE_MAIN_TRACK_ID, timelineLayerBase, type TimelineFramePreset, timelineLayerContains, timelineLayerCorners, timelineLayerStyle,
  type TimelineClip, type TimelineDocumentV1, type TimelineExecution, type TimelineExecutionRow, type TimelineLayerBox, type TimelineLayerTransform, type TimelineWebAnimationClip,
} from '@breatic/shared';
import { TimelineExecutionCreateInputSchema, timelineExecutionEnded, timelineExecutionFailed, webAnimationDurationFrames } from '@breatic/shared/space-content';
import { resolveTimelineArrangement, timelineClipSource, timelineWebSourceOf, type TimelineArrangementReason } from '@web/data/yjs/timeline-arrangement';
import { isTimelineSizeRefusal, removeTimelineClip } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand, TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { timelineStackOrder, visibleTimelineClipsAt } from '@web/data/yjs/timeline-layers';
import { orderedTimelineClips, timelineTrackRank } from '@web/data/yjs/timeline-order';

import { CountChip } from '@web/components/CountChip';
import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Separator } from '@web/components/ui/separator';
import { Slider } from '@web/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { spaceTasksQueryKey } from '@web/data/api/scene';
import { serverMessage } from '@web/data/api/server-message';
import { timelineApi } from '@web/data/api/timeline';
import { docName, getDoc } from '@web/data/yjs/manager';
import { checkAdd } from '@web/data/yjs/space-write';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';
import { TIMELINE_MAX_PIXELS_PER_FRAME, TIMELINE_TRACK_HEADER_PX, timelineMinZoom } from '@web/spaces/timeline/timeline-zoom';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useTranslation } from '@web/i18n/use-translation';
import { isEditableTarget } from '@web/lib/is-editable-target';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { runOnce } from '@web/stores/task-actions-in-flight';
import type { SpaceBodyProps } from '@web/spaces';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';
import { TimelineClipProperties } from '@web/spaces/timeline/TimelineClipProperties';
import { TimelineFrameRatio } from '@web/spaces/timeline/TimelineFrameRatio';
import { timelinePreviewFit } from '@web/spaces/timeline/timeline-preview-fit';
import { TimelineMaterialDialog } from '@web/spaces/timeline/TimelineMaterialDialog';
import { TimelineTrackArea } from '@web/spaces/timeline/TimelineTrackArea';
import { getTimelineEditSession, type TimelineEditOptions } from '@web/data/yjs/timeline-edit-session';
import { timelineKeyAction } from '@web/spaces/timeline/timeline-keyboard';
import { getTimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { getTimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { timelineUploadText, useTimelineUploadViews } from '@web/spaces/timeline/use-timeline-upload-views';
import { formatTimelineTimecode } from '@web/spaces/timeline/timeline-timecode';
import { useTimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';
import { useTimelineDocument } from '@web/spaces/timeline/use-timeline-document';
import { useTimelineEditPrefs } from '@web/spaces/timeline/use-timeline-edit-prefs';
import { useTimelinePlayback } from '@web/spaces/timeline/use-timeline-playback';
import { useTimelineAsset, useTimelineAssets } from '@web/spaces/timeline/use-timeline-asset';
import { TimelineExecutionList, timelineCancelIntent, timelineExecutionInput, type TimelineExecutionView } from '@web/spaces/timeline/TimelineExecutionList';
import type { TimelineWebClipView } from '@web/spaces/timeline/TimelineTrackArea';
import { TimelineWebAnimationDialog } from '@web/spaces/timeline/TimelineWebAnimationDialog';
import { TimelineWebPreview, PreviewNote, type TimelineUploadNote, type TimelineWebEntry } from '@web/spaces/timeline/TimelineWebPreview';
import { useTimelineExecutions } from '@web/spaces/timeline/use-timeline-executions';
import { useTimelineLimits, useTimelinePreviewLimits } from '@web/spaces/timeline/use-timeline-limits';
import { useTimelineWebResolution } from '@web/spaces/timeline/use-timeline-web-resolution';
import { transitionCreationDraft, type CreationDraftInput, type CreationDraftState } from '@web/spaces/timeline/web-animation-creation-draft';
import type { TimelineWebLayer, WebAnimationPlayerElement } from '@web/spaces/timeline/web-animation-host';
import { EMPTY_WEB_INSTANCE_POOL, allocateWebInstances } from '@web/spaces/timeline/web-instance-pool';

/** The existing content document and its supported native projection. */
interface TimelineEditorProps extends SpaceBodyProps { doc: Y.Doc; document: TimelineDocumentV1; damagedClipIds: readonly string[] }

/** One conflicting placement listed with its frames. */
interface TimelineConflictRowProps {
  projectId: string;
  clip: TimelineClip;
  assetId: string;
  /** A web copy's or upload placeholder's name; null names a video by its asset. */
  name: string | null;
  track: string;
  reason: TimelineArrangementReason['code'] | null;
  selected: boolean;
  onLocate: (clipId: string) => void;
}

/** A clip record that can no longer be read, listed so an Editor can delete it. */
interface TimelineDamagedRowProps { clipId: string; readOnly: boolean; onDelete: (clipId: string) => void }

/**
 * List one damaged clip record with its reason and, for an Editor, a delete control.
 * @param props - The record and the delete callback.
 * @param props.clipId - The damaged record's id.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.onDelete - Deletes the record.
 * @returns The row.
 * @throws {never} Never.
 */
function TimelineDamagedRow({ clipId, readOnly, onDelete }: TimelineDamagedRowProps): React.JSX.Element {
  const t = useTranslation();
  const remove = React.useCallback((): void => onDelete(clipId), [onDelete, clipId]);
  return <div data-testid={`timeline-conflict-${clipId}`} className='flex w-full min-w-0 items-center gap-2 rounded-chrome border border-status-error-border bg-status-error-bg px-2 py-2 text-xs'>
    <Film className='size-4 shrink-0' />
    <span className='min-w-0 flex-1 truncate leading-normal text-status-error-foreground'>{t('timeline.conflictReason.damaged')}</span>
    {!readOnly && <Button data-testid={`timeline-damaged-delete-${clipId}`} variant='outline' size='compact' onClick={remove} icon={<Trash2 className='mr-1.5 size-3.5' />}>{t('timeline.edit.delete')}</Button>}
  </div>;
}

const DEFAULT_PIXELS_PER_FRAME = 2;
const LOCATE_MARGIN_PX = 24;
// The zoom slider moves in powers of two so every zoom level is equally reachable.
const ZOOM_STEP = 0.1;

/**
 * List one conflicting placement; pressing it selects it and brings it into view.
 * @param props - The placement and its selection.
 * @param props.projectId - The Project authorizing its source.
 * @param props.clip - The placement.
 * @param props.assetId - Its registered asset.
 * @param props.name - A web copy's or upload placeholder's name, or null to use its video's name.
 * @param props.track - Its track's name.
 * @param props.reason - The first reason it conflicts.
 * @param props.selected - Whether it is selected.
 * @param props.onLocate - Selects it, seeks to it and scrolls the tracks to it.
 * @returns The conflict row.
 * @throws {never} Never.
 */
function TimelineConflictRow({ projectId, clip, assetId, name: label, track, reason, selected, onLocate }: TimelineConflictRowProps): React.JSX.Element {
  const t = useTranslation();
  const asset = useTimelineAsset(projectId, assetId);
  const name = label ?? (asset.data?.displayName || t('timeline.video'));
  const locate = React.useCallback((): void => onLocate(clip.id), [onLocate, clip.id]);
  return <Button data-testid={`timeline-conflict-${clip.id}`} type='button' variant={null} size={null} aria-pressed={selected} onClick={locate}
    className={cn('flex w-full min-w-0 flex-col items-start gap-0.5 overflow-hidden rounded-chrome border border-status-error-border bg-status-error-bg px-2 py-1.5 text-left text-xs hover-enabled:border-status-error', selected && 'border-active-border')}>
    <span className='flex w-full min-w-0 items-center gap-2'>
      {clip.kind === 'web-animation' ? <Code className='size-4 shrink-0' /> : <Film className='size-4 shrink-0' />}
      <Tooltip>
        <TooltipTrigger asChild><span className='min-w-0 truncate leading-normal'>{name}</span></TooltipTrigger>
        <TooltipContent portal className='max-w-sm break-all'>{name}</TooltipContent>
      </Tooltip>
    </span>
    {reason !== null && <span data-testid={`timeline-reason-${clip.id}`} className='w-full truncate text-status-error-foreground'>{t(`timeline.conflictReason.${reason}`)}</span>}
    <span className='w-full tabular-nums text-muted-foreground'>{`${track} · ${t('timeline.clipFrames', { start: clip.startFrame, duration: clip.durationFrames })}`}</span>
  </Button>;
}

/**
 * A toolbar button's shortcut, in the type the menus use for theirs.
 * @param props - The shortcut.
 * @param props.children - The shortcut label.
 * @returns The shortcut.
 * @throws {never} Never.
 */
function ToolbarShortcut({ children }: { children: string }): React.JSX.Element {
  return <kbd className='font-sans text-xs tracking-widest text-muted-foreground'>{children}</kbd>;
}

/** One of the editing switches. */
interface TimelineSwitchProps { testId: string; label: string; shortcut?: string; pressed: boolean; icon: React.ReactElement<{ className?: string }>; onToggle: () => void }

/**
 * An editing switch drawn as an icon button whose tooltip names it and its shortcut.
 * @param props - The switch.
 * @param props.testId - Its test id.
 * @param props.label - Its name.
 * @param props.shortcut - Its key, when it has one.
 * @param props.pressed - Whether it is on.
 * @param props.icon - Its icon.
 * @param props.onToggle - Turns it on or off.
 * @returns The switch.
 * @throws {never} Never.
 */
function TimelineSwitch({ testId, label, shortcut, pressed, icon, onToggle }: TimelineSwitchProps): React.JSX.Element {
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button data-testid={testId} variant='outline' size='sm' aria-label={label} aria-pressed={pressed} onClick={onToggle} icon={icon}
        className='px-2 aria-pressed:border-active-border aria-pressed:bg-accent-strong aria-pressed:hover-enabled:bg-accent-strong' />
    </TooltipTrigger>
    <TooltipContent className='flex items-center gap-2'>{label}{shortcut !== undefined && <span className='tracking-widest text-muted-foreground'>{shortcut}</span>}</TooltipContent>
  </Tooltip>;
}
const PANEL = 'flex flex-col gap-2 rounded-chrome border border-border p-3 text-xs';
const CLOSED_DRAFT: CreationDraftState = { status: 'closed' };
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * A configured aspect as the creation input names it.
 * @param value - The configured aspect.
 * @returns It, or null when the creation input does not accept it.
 * @throws {never} Never.
 */
function aspectOf(value: string | undefined): CreationDraftInput['aspect'] | null {
  const parsed = TimelineExecutionCreateInputSchema.shape.aspect.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The offered web-animation aspect closest to the Timeline frame (#1502): the one that covers most of the frame when
 * fitted into it, which is the smallest gap between the logarithms of the two ratios; on a tie, the one with the frame's
 * orientation.
 * @param frame - The Timeline frame size.
 * @param frame.width - Frame width.
 * @param frame.height - Frame height.
 * @param offered - The aspects the creation dialog offers.
 * @returns The closest offered aspect, or null when none is accepted.
 * @throws {never} Never.
 */
function nearestAspect(frame: { width: number; height: number }, offered: readonly string[]): CreationDraftInput['aspect'] | null {
  const ratio = Math.log(frame.width / frame.height);
  let best: { aspect: CreationDraftInput['aspect']; gap: number; same: boolean } | null = null;
  for (const value of offered) {
    const aspect = aspectOf(value);
    if (aspect === null) continue;
    const [width, height] = aspect.split(':').map(Number) as [number, number];
    const own = Math.log(width / height);
    const gap = Math.abs(own - ratio);
    const same = Math.sign(own) === Math.sign(ratio);
    if (best === null || gap < best.gap - 1e-12 || (Math.abs(gap - best.gap) <= 1e-12 && same && !best.same)) best = { aspect, gap, same };
  }
  return best?.aspect ?? null;
}

/**
 * What a web copy on a track shows, and the request it came from.
 * @param clip - The copy.
 * @param web - The resolution of its references.
 * @param rows - The Space's executions by result and by id.
 * @param rows.bySource - By the source version they produced.
 * @param rows.byId - By id.
 * @returns Its view.
 * @throws {never} Never.
 */
function webClipView(clip: TimelineWebAnimationClip, web: Parameters<typeof timelineWebSourceOf>[0], rows: { bySource: ReadonlyMap<string, TimelineExecutionRow>; byId: ReadonlyMap<string, TimelineExecutionRow> }): TimelineWebClipView {
  const { operationId } = clip.contentBinding;
  const sourceId = timelineWebSourceOf(web, clip);
  const row = (operationId === null ? undefined : rows.byId.get(operationId)) ?? (sourceId === null ? undefined : rows.bySource.get(sourceId));
  const prompt = row === undefined ? null : timelineExecutionInput(row)?.prompt ?? null;
  if (sourceId !== null && web.sources[sourceId] !== undefined) return { state: 'ready', prompt, status: null, phase: null };
  const execution = operationId === null ? undefined : web.executions[operationId];
  if (execution === undefined) return { state: 'unresolved', prompt, status: null, phase: null };
  return { state: timelineExecutionFailed(execution.status) ? 'failed' : 'pending', prompt, status: execution.status, phase: row?.status === 'running' ? row.phase : null };
}
const MAGNET_ICON = <Magnet className='size-4' />;
// The preview handles carry react-moveable, loaded the first time an editable layer is selected (#1410 design §4.3).
const TimelineLayerHandles = React.lazy(() => import('@web/spaces/timeline/TimelineLayerHandles').then((module) => ({ default: module.TimelineLayerHandles })));
const NOTE_LAYER_STYLE = { zIndex: 20 } as const;
const OPERATION_LAYER_STYLE = { zIndex: 10 } as const;
const SNAP_ICON = <ArrowRightToLine className='size-4' />;
const LINKAGE_ICON = <Link2 className='size-4' />;

/**
 * Arrange registered videos on tracks, edit them and preview the shared integer-frame sequence.
 * @param props - The open Timeline's supported content and current role.
 * @param props.projectId - The owning Project.
 * @param props.spaceId - The open Space tab's identity.
 * @param props.readOnly - The existing Project role's editing restriction.
 * @param props.doc - The content document held by the existing Space connection.
 * @param props.document - Its validated native Timeline projection.
 * @param props.damagedClipIds - Clip records that can no longer be read.
 * @returns The preview, toolbar, tracks, properties and conflicts.
 * @throws {never} Never.
 */
function TimelineEditor({ projectId, spaceId, readOnly = false, doc, document, damagedClipIds }: TimelineEditorProps): React.JSX.Element {
  const t = useTranslation();
  const [frame, setFrame] = React.useState(0);
  const [zoom, setZoom] = React.useState(DEFAULT_PIXELS_PER_FRAME);
  const [trackWidth, setTrackWidth] = React.useState(0);
  const name = docName.timelineSpace(projectId, spaceId);
  const session = React.useMemo(() => getTimelineEditSession(doc, name), [doc, name]);
  const history = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const prefs = useTimelineEditPrefs();
  const placement = React.useMemo(() => ({ magnet: prefs.magnet, linkage: prefs.linkage }), [prefs.magnet, prefs.linkage]);
  const labels = useTimelineTrackLabels(document);
  const queryClient = useQueryClient();
  // Every edit, including one placed from the Add media dialog, says when linkage moved clips to a track above.
  const editWithNotice = React.useCallback((command: TimelineEditCommand, options?: TimelineEditOptions): TimelineEditPlan => {
    const plan = session.edit(command, options);
    if (plan.ok && plan.bumped.length > 0) toast.info(t('timeline.edit.bumped', { count: plan.bumped.length }));
    return plan;
  }, [session, t]);
  // Background uploads live with the document, so a hidden tab keeps uploading and writing results.
  const uploads = React.useMemo(() => getTimelineUploads(doc, name, {
    projectId, spaceId, onRegistered: () => { void queryClient.invalidateQueries({ queryKey: ['timeline-videos', projectId] }); },
  }), [doc, name, projectId, spaceId, queryClient]);
  const material = React.useMemo(() => getTimelineMediaDraft(doc, name, { projectId, spaceId, queryClient, edit: editWithNotice, startUpload: uploads.start }), [doc, name, projectId, spaceId, queryClient, editWithNotice, uploads]);
  const materialState = React.useSyncExternalStore(material.subscribe, material.getSnapshot);
  const [materialOpen, setMaterialOpen] = useExclusiveOverlay(`timeline-material:${projectId}:${spaceId}`);
  // Activity suspends effects while hidden; the material draft and the edit session read the current rendered role.
  material.setCanWrite(!readOnly);
  session.setCanWrite(!readOnly);
  React.useEffect(() => {
    if (!materialState.open && materialOpen) setMaterialOpen(false);
    if (materialState.open && !materialOpen) material.close();
  }, [materialState.open, materialOpen, setMaterialOpen, material]);
  const clips = React.useMemo(() => orderedTimelineClips(document.clips), [document.clips]);
  const webLimits = useTimelineLimits(projectId)?.webAnimation;
  const refreshMs = webLimits?.sourceRefreshIntervalMs;
  // The tab bar polls this list while it has unfinished rows (useSpaceTaskStatus); this view shares its cache.
  const executions = useTimelineExecutions(projectId, spaceId);
  const rows = executions.data;
  const web = useTimelineWebResolution(projectId, spaceId, document, refreshMs);
  // Edits of web copies plan against the extents this resolution gives.
  session.setWebResolution(web);
  const arrangement = React.useMemo(() => resolveTimelineArrangement(document, web), [document, web]);
  const readyIds = React.useMemo(() => new Set(arrangement.readyClipIds), [arrangement.readyClipIds]);
  const reasons = React.useMemo(() => new Map(arrangement.conflicts.map((placement) => [placement.clipId, placement.reasons[0]?.code ?? null])), [arrangement.conflicts]);
  const selectedId = history.selectedClipId;
  const selected = selectedId === null ? undefined : document.clips[selectedId];
  const selectedAssetId = selected === undefined ? '' : timelineClipSource(document.sources, selected)?.assetId ?? '';
  const selectedResource = useTimelineAsset(projectId, selectedAssetId);
  const visible = React.useMemo(() => visibleTimelineClipsAt(document, readyIds, frame), [document, readyIds, frame]);
  // The preview frame is contained in the area measured around it, and its factor (display pixels per canvas pixel)
  // places every layer and handle (#1502 design §6.2).
  const [previewArea, setPreviewArea] = React.useState<HTMLDivElement | null>(null);
  const [areaSize, setAreaSize] = React.useState({ width: 0, height: 0 });
  React.useLayoutEffect(() => {
    if (previewArea === null) return;
    /**
     * Read the area's displayed size.
     * @throws {never} Never.
     */
    const measure = (): void => {
      const { width, height } = previewArea.getBoundingClientRect();
      setAreaSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(previewArea);
    return () => observer.disconnect();
  }, [previewArea]);
  const canvas = document.settings;
  const fit = React.useMemo(() => timelinePreviewFit(areaSize, canvas), [areaSize, canvas]);
  const factor = fit.factor;
  // The live value of a layer being dragged in the preview; it is never written to the document.
  const [override, setOverride] = React.useState<{ clipId: string; transform: TimelineLayerTransform } | null>(null);
  const transformOf = React.useCallback((clip: TimelineClip): TimelineLayerTransform => override?.clipId === clip.id ? override.transform : clip.transform, [override]);
  const rowsBy = React.useMemo(() => {
    const bySource = new Map<string, TimelineExecutionRow>();
    const byId = new Map<string, TimelineExecutionRow>();
    for (const row of rows ?? []) {
      byId.set(row.id, row);
      if (row.resultSourceVersionId !== null) bySource.set(row.resultSourceVersionId, row);
    }
    return { bySource, byId };
  }, [rows]);
  const webClips = React.useMemo(() => new Map(clips.flatMap((clip) => clip.kind === 'web-animation' ? [[clip.id, webClipView(clip, web, rowsBy)] as const] : [])), [clips, web, rowsBy]);
  const uploadViews = useTimelineUploadViews(name, uploads, clips);
  // A visible placeholder draws no picture and hides nothing below it; the preview notes it by track.
  const uploadNotes = React.useMemo(() => visible.flatMap((clip, index): TimelineUploadNote[] => {
    const view = clip.kind === 'upload' ? uploadViews.get(clip.id) : undefined;
    return view === undefined ? [] : [{ clipId: clip.id, z: index + 1, text: t('timeline.upload.preview', { track: labels.nameOf(clip.trackId) ?? clip.trackId, state: view.state }) }];
  }), [visible, uploadViews, labels, t]);
  const selectedUploadView = selected?.kind === 'upload' ? uploadViews.get(selected.id) : undefined;
  const selectedUploadId = selected?.kind === 'upload' ? selected.upload.uploadId : null;
  const selectedUploadName = selected?.kind === 'upload' ? selected.upload.name : '';
  const retryUpload = React.useCallback((): void => { if (selectedUploadId !== null) uploads.retry(selectedUploadId); }, [uploads, selectedUploadId]);
  const selectedUpload = React.useMemo(() => selectedUploadView === undefined ? null
    : { text: timelineUploadText(t, selectedUploadView, selectedUploadName), failed: selectedUploadView.state === 'failed', progress: selectedUploadView.progress, onRetry: selectedUploadView.retryable && !readOnly ? retryUpload : null },
  [selectedUploadView, selectedUploadName, readOnly, retryUpload, t]);
  // The web preview's instance pool (inner#1711 design §7.4): visible copies, copies within the premount lead and
  // loaded pages no copy uses. It is allocated again whenever the frame, the document or the resolution changes, and
  // without the Timeline limits it premounts and keeps nothing.
  const sourceOf = React.useCallback((clip: TimelineWebAnimationClip): string | null => {
    const sourceId = timelineWebSourceOf(web, clip);
    return sourceId !== null && web.sources[sourceId] !== undefined ? sourceId : null;
  }, [web]);
  const premountMs = webLimits?.premountMs;
  const premountFrames = premountMs === undefined ? 0 : Math.round(premountMs * document.settings.fps.num / document.settings.fps.den / 1000);
  const idleInstancesMax = webLimits?.idleInstancesMax ?? 0;
  // The instances the playback failed, as of its last report; a failed one is unloaded once its copy leaves.
  const [failedKeys, setFailedKeys] = React.useState<ReadonlySet<string>>(NO_KEYS);
  // Instances that can register no player until a retry: their address was refused or the player module failed.
  const [unregistrable, setUnregistrable] = React.useState<ReadonlySet<string>>(() => new Set());
  // Either kind of failure unloads the instance once its copy leaves, so the next copy asks for its page again.
  const unloadKeys = React.useMemo(() => unregistrable.size === 0 ? failedKeys : new Set([...failedKeys, ...unregistrable]), [failedKeys, unregistrable]);
  const [heldPool, setHeldPool] = React.useState(EMPTY_WEB_INSTANCE_POOL);
  const pool = React.useMemo(() => allocateWebInstances(heldPool, { document, readyClipIds: readyIds, frame, premountFrames, idleInstancesMax, sourceOf, failedKeys: unloadKeys }),
    [heldPool, document, readyIds, frame, premountFrames, idleInstancesMax, sourceOf, unloadKeys]);
  // Allocation is idempotent, so holding its result settles in one extra render.
  if (pool !== heldPool) setHeldPool(pool);
  const webEntries = React.useMemo(() => {
    const assigned = new Map(pool.assignments.flatMap((assignment) => assignment.clipId === null ? [] : [[assignment.clipId, assignment] as const]));
    const shown = visible.flatMap((clip, index): TimelineWebEntry[] => {
      if (clip.kind !== 'web-animation') return [];
      const assignment = assigned.get(clip.id);
      const resolved = assignment === undefined ? undefined : web.sources[assignment.sourceVersionId];
      const track = labels.nameOf(clip.trackId) ?? clip.trackId;
      const status = clip.contentBinding.operationId === null ? null : web.executions[clip.contentBinding.operationId]?.status ?? null;
      if (assignment === undefined || resolved === undefined) return [{ clip, track, z: index + 1, instance: null, status }];
      const box = timelineLayerStyle(canvas, timelineLayerBase(canvas, resolved.viewport), transformOf(clip), factor);
      return [{ clip, track, z: index + 1, instance: { key: assignment.key, sourceVersionId: assignment.sourceVersionId, fps: resolved.fps, role: 'visible' }, status, box }];
    });
    // Premounted and idle instances stay mounted, hidden; an idle one keeps the copy it last showed.
    const hidden = pool.assignments.flatMap((assignment): TimelineWebEntry[] => {
      const clip = pool.lastClips[assignment.key];
      const resolved = web.sources[assignment.sourceVersionId];
      if (assignment.role === 'visible' || clip === undefined || resolved === undefined) return [];
      const instance = { key: assignment.key, sourceVersionId: assignment.sourceVersionId, fps: resolved.fps, role: assignment.role };
      return [{ clip, track: labels.nameOf(clip.trackId) ?? clip.trackId, z: 0, status: null, box: timelineLayerStyle(canvas, timelineLayerBase(canvas, resolved.viewport), clip.transform, factor),
        instance: assignment.targetFrame === null ? instance : { ...instance, targetFrame: assignment.targetFrame } }];
    });
    return [...shown, ...hidden];
  }, [visible, web, labels, pool, factor, canvas, transformOf]);
  const [players, setPlayers] = React.useState<ReadonlyMap<string, WebAnimationPlayerElement>>(() => new Map());
  const registerPlayer = React.useCallback((key: string, player: WebAnimationPlayerElement | null): void => setPlayers((current) => {
    if ((current.get(key) ?? null) === player) return current;
    const next = new Map(current);
    if (player === null) next.delete(key);
    else next.set(key, player);
    return next;
  }), []);
  const reportUnavailable = React.useCallback((key: string, unavailable: boolean): void => setUnregistrable((current) => {
    if (current.has(key) === unavailable) return current;
    const next = new Set(current);
    if (unavailable) next.add(key);
    else next.delete(key);
    return next;
  }), []);
  const layerSpecs = webEntries.flatMap((entry) => {
    if (entry.instance === null) return [];
    const { key, fps, role, targetFrame } = entry.instance;
    return [{ key, clip: entry.clip, fps, role, ...(targetFrame === undefined ? {} : { targetFrame }) }];
  });
  // A visible copy whose player has not registered yet holds play like a loading instance (inner#1711 design §7.2);
  // premounted and idle instances never hold it.
  const webPending = layerSpecs.some((spec) => spec.role === 'visible' && !players.has(spec.key) && !unregistrable.has(spec.key));
  const layerSignature = JSON.stringify(layerSpecs);
  // The layer set keeps its identity while its content is unchanged, so playing on does not resync the instances.
  const webLayers = React.useMemo((): TimelineWebLayer[] => layerSpecs.flatMap((spec) => {
    const player = players.get(spec.key);
    return player === undefined ? [] : [{ ...spec, player }];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the specs change only when their signature does.
  }), [layerSignature, players]);
  // Every visible video clip and every one starting within the premount lead, bottom-up; each has its own element
  // (#1410 design §6.2), and its asset is read through the cache the properties panel shares.
  const rank = React.useMemo(() => timelineTrackRank(document.tracks), [document.tracks]);
  const videoClips = React.useMemo(() => clips.flatMap((clip) => clip.kind === 'video' && readyIds.has(clip.id) && rank.has(clip.trackId)
    && frame < clip.startFrame + clip.durationFrames && frame >= clip.startFrame - premountFrames ? [clip] : [])
    .sort(timelineStackOrder(rank)), [clips, readyIds, rank, frame, premountFrames]);
  const assetSignature = [...new Set(videoClips.flatMap((clip) => document.sources[clip.sourceId]?.assetId ?? []))].sort().join(' ');
  const videoAssetIds = React.useMemo(() => (assetSignature === '' ? [] : assetSignature.split(' ')), [assetSignature]);
  const assets = useTimelineAssets(projectId, videoAssetIds);
  const assetOf = React.useCallback((clip: TimelineClip) => clip.kind === 'video' ? assets.get(document.sources[clip.sourceId]?.assetId ?? '') : undefined, [assets, document.sources]);
  const videoSpecs = videoClips.map((clip) => {
    const asset = assetOf(clip);
    // Cached data stays usable when a refetch fails; only a read that never returned data fails the layer (#1410 design §6.2).
    const state = asset?.data !== undefined ? 'ready' as const : asset?.isError === true ? 'failed' as const : 'loading' as const;
    return { clipId: clip.id, fileUrl: state === 'ready' ? asset?.data?.fileUrl ?? null : null, coverUrl: asset?.data?.coverUrl ?? null, state };
  });
  const videoSignature = JSON.stringify(videoSpecs);
  // The layer set keeps its identity while its content is unchanged, so playing on does not resync the elements.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the specs change only when their signature does.
  const videoLayers = React.useMemo(() => videoSpecs, [videoSignature]);
  const preview = useTimelinePreviewLimits(projectId);
  const playback = useTimelinePlayback({
    document, readyClipIds: readyIds, frame, onFrame: setFrame, videoLayers, enabled: true, preview,
    webLayers, webPending, webLoadTimeoutMs: webLimits?.playerLoadTimeoutMs,
  });
  const { seek, retryVideo, retryWeb, videoElement, videoStates } = playback;
  /**
   * A layer's base box in canvas pixels: its registered size contained in the canvas (#1410 design §2).
   * @param clip - The layer's clip.
   * @returns The box, or null for a clip that draws no layer.
   * @throws {never} Never.
   */
  const baseOf = React.useCallback((clip: TimelineClip): TimelineLayerBox | null => {
    if (clip.kind === 'video') {
      const data = assetOf(clip)?.data;
      return timelineLayerBase(canvas, { width: data?.width ?? null, height: data?.height ?? null });
    }
    if (clip.kind === 'web-animation') {
      const sourceId = sourceOf(clip);
      const viewport = sourceId === null ? undefined : web.sources[sourceId]?.viewport;
      return viewport === undefined ? null : timelineLayerBase(canvas, viewport);
    }
    return null;
  }, [assetOf, canvas, sourceOf, web.sources]);
  // The layers a click can pick and a selection can handle: visible ready videos and web copies with a source (#1410
  // design §4.2).
  // A video's asset state is read in this render; its element's error arrives through `videoStates`.
  const pickable = React.useMemo(() => {
    const assetStates = new Map(videoLayers.map((layer) => [layer.clipId, layer.state]));
    return visible.flatMap((clip) => {
      const unready = clip.kind === 'video' && (assetStates.get(clip.id) !== 'ready' || videoStates.get(clip.id) === 'failed');
      const base = unready ? null : baseOf(clip);
      return base === null ? [] : [{ clip, base }];
    });
  }, [visible, baseOf, videoLayers, videoStates]);
  // Each video element sits in the frame on its base box with its transform, stacked by track; a premounted one waits
  // there hidden.
  const videoHost = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const host = videoHost.current;
    if (host === null) return;
    for (const clip of videoClips) {
      const element = videoElement(clip.id);
      if (element === undefined) continue;
      if (element.parentElement !== host) host.append(element);
      const index = visible.indexOf(clip);
      const base = baseOf(clip);
      if (base === null) continue;
      Object.assign(element.style, {
        ...timelineLayerStyle(canvas, base, transformOf(clip), factor), position: 'absolute', objectFit: 'contain', pointerEvents: 'none',
        zIndex: String(index + 1), visibility: index < 0 ? 'hidden' : '',
      });
    }
  });
  const failedSignature = [...playback.webStates].flatMap(([key, state]) => state === 'failed' ? [key] : []).sort().join(' ');
  React.useEffect(() => {
    setFailedKeys(failedSignature === '' ? NO_KEYS : new Set(failedSignature.split(' ')));
  }, [failedSignature]);
  const previewTokenTtlMs = webLimits?.previewTokenTtlMs;
  const playerLoadTimeoutMs = webLimits?.playerLoadTimeoutMs;
  // Before the Timeline limits arrive every player asks for its own address.
  const sharing = React.useMemo(() => previewTokenTtlMs === undefined || playerLoadTimeoutMs === undefined ? undefined : { previewTokenTtlMs, playerLoadTimeoutMs },
    [previewTokenTtlMs, playerLoadTimeoutMs]);
  const duration = Math.max(0, ...clips.map((clip) => clip.startFrame + clip.durationFrames));
  const fps = document.settings.fps;
  const extent = Math.max(duration, Math.ceil(fps.num / fps.den * 12)) + Math.ceil(fps.num / fps.den * 2);
  const seekValue = React.useMemo(() => [Math.min(frame, Math.max(0, duration - 1))], [frame, duration]);
  const onSeek = React.useCallback((value: number[]): void => seek(value[0] ?? 0), [seek]);
  const seekTo = React.useCallback((target: number): void => seek(Math.max(0, Math.min(target, Math.max(0, duration - 1)))), [seek, duration]);
  const selectClip = React.useCallback((clipId: string | null): void => session.select(clipId), [session]);
  const trackViewport = React.useRef<HTMLDivElement>(null);

  const commit = React.useCallback((command: TimelineEditCommand, options?: TimelineEditOptions): TimelineEditPlan | null => {
    if (readOnly) return null;
    const plan = editWithNotice(command, options);
    // A size refusal was told by its own toast.
    if (!plan.ok && !isTimelineSizeRefusal(plan)) toast.warning(t(`timeline.errors.${plan.reason}`));
    return plan;
  }, [readOnly, editWithNotice, t]);
  const removeDamaged = React.useCallback((clipId: string): void => { if (!readOnly) removeTimelineClip(doc, clipId, session.origin); }, [readOnly, doc, session]);
  const commitCommand = React.useCallback((command: TimelineEditCommand): void => { commit(command); }, [commit]);
  const vanished = React.useCallback((): void => { toast.warning(t('timeline.errors.clip_removed')); }, [t]);

  // Web animation (inner#1711 design §8, §9): the creation dialog, the landing of what it accepted, and the list.
  const [draft, dispatchDraft] = React.useReducer(transitionCreationDraft, CLOSED_DRAFT);
  const [retryDialog, setRetryDialog] = React.useState(false);
  const [listOpen, setListOpen] = React.useState(false);
  const [listView, setListView] = React.useState<TimelineExecutionView>('inProgress');
  const [openRow, setOpenRow] = React.useState<string | null>(null);
  // What a landing reads when its accept answers, which may be after the role or switches changed.
  const landing = React.useRef({ readOnly, placement });
  landing.current = { readOnly, placement };
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const refreshTasks = React.useCallback((): void => { void queryClient.invalidateQueries({ queryKey: spaceTasksQueryKey(projectId, spaceId) }); }, [queryClient, projectId, spaceId]);
  /**
   * Write an accepted action's receipt, with its placeholder when asked. A read-only or closed Space writes nothing;
   * reopening it lands the receipt then.
   * @param actionId - The dialog's action.
   * @param execution - The accepted execution.
   * @param addClip - Where the placeholder goes and how long it is.
   * @throws {never} Never.
   */
  const land = React.useCallback((actionId: string, execution: Pick<TimelineExecution, 'id' | 'inputHash'>, addClip?: { startFrame: number; acceptedDurationFrames: number }): void => {
    const { readOnly: locked, placement: switches } = landing.current;
    if (locked || !mounted.current) return;
    const receipt = { executionId: execution.id, inputHash: execution.inputHash, landedAt: new Date().toISOString() };
    session.edit({
      operation: 'land_execution',
      parameters: addClip === undefined ? { actionId, receipt } : {
        actionId, receipt,
        addClip: { clipId: newId(), startFrame: addClip.startFrame, newTrackId: newId(), extent: { acceptedDurationFrames: addClip.acceptedDurationFrames, fps: document.settings.fps } },
      },
      placement: switches,
    });
  }, [session, document.settings.fps]);
  // An action accepted while this Space could not write, or whose page closed before landing, lands when an Editor
  // opens it before its deadline.
  React.useEffect(() => {
    if (readOnly || rows === undefined) return;
    const now = Date.now();
    for (const row of rows) {
      if (row.status !== 'awaiting_landing' || document.operationReceipts[row.actionId] !== undefined || new Date(row.deadlineAt).getTime() <= now) continue;
      land(row.actionId, row);
    }
  }, [readOnly, rows, document.operationReceipts, land]);
  const openCreate = React.useCallback((input?: CreationDraftInput): void => {
    const aspect = webLimits === undefined ? null : nearestAspect(document.settings, webLimits.aspects);
    if (readOnly || webLimits === undefined || aspect === null) return;
    if (draft.status === 'closed') setRetryDialog(input !== undefined);
    dispatchDraft({ type: 'open', input: input ?? { prompt: '', engine: 'deepseek', aspect, durationSeconds: webLimits.durationSeconds.default, addAtPlayhead: true } });
  }, [readOnly, webLimits, draft.status, document.settings]);
  const openBlankCreate = React.useCallback((): void => openCreate(), [openCreate]);
  const editDraft = React.useCallback((patch: Partial<CreationDraftInput>): void => dispatchDraft({ type: 'edit', patch }), []);
  const closeDraft = React.useCallback((): void => dispatchDraft({ type: 'close' }), []);
  const execute = React.useCallback((): void => {
    if (draft.status !== 'drafting' || readOnly) return;
    // The run lands a receipt and a placeholder in this Space: a Space that
    // cannot take them starts no run (inner#1790).
    if (!checkAdd(name).ok) return;
    const { input } = draft;
    const actionId = newId();
    const fps = document.settings.fps;
    // The placeholder goes where the playhead is when Execute is pressed.
    const startFrame = frame;
    dispatchDraft({ type: 'execute', actionId });
    void runOnce(`timeline-execution:${spaceId}:${actionId}`, {
      scope: 'timeline-execution',
      prepare: () => ({ projectId, spaceId, actionId, prompt: input.prompt, engine: input.engine, aspect: input.aspect, durationSeconds: input.durationSeconds, fps }),
      send: (key, body) => timelineApi.acceptExecution(body, key),
    }).then((outcome) => {
      if (outcome.kind !== 'done') {
        dispatchDraft({ type: 'refused', error: serverMessage(outcome.kind === 'failed' ? outcome.error : null, t('common.runOnce.unknownResult')) });
        return;
      }
      const execution = outcome.result;
      land(actionId, execution, input.addAtPlayhead ? { startFrame, acceptedDurationFrames: webAnimationDurationFrames({ durationSeconds: input.durationSeconds, fps }) } : undefined);
      dispatchDraft({ type: 'accepted', executionId: execution.id });
      setListOpen(true);
      setListView('inProgress');
      setOpenRow(execution.id);
      refreshTasks();
    });
  }, [draft, readOnly, name, document.settings.fps, frame, spaceId, projectId, land, refreshTasks, t]);
  const toggleList = React.useCallback((): void => setListOpen((open) => !open), []);
  const closeList = React.useCallback((): void => setListOpen(false), []);
  const toggleRow = React.useCallback((id: string): void => setOpenRow((current) => current === id ? null : id), []);
  const cancelExecution = React.useCallback((row: TimelineExecutionRow): void => {
    if (readOnly) return;
    void runOnce(timelineCancelIntent(row.id), {
      scope: 'timeline-execution',
      prepare: () => row.id,
      send: (key, id) => timelineApi.cancelExecution(id, key),
      onDone: () => { refreshTasks(); return undefined; },
      onFailure: (err) => { toast.error(serverMessage(err, t('common.runOnce.unknownResult'))); },
    });
  }, [readOnly, refreshTasks, t]);
  // A result is added as a new copy each time; a running execution as a placeholder that turns into its result.
  const addExecution = React.useCallback((row: TimelineExecutionRow): void => {
    const input = timelineExecutionInput(row);
    if (input === null) return;
    const accepted = webAnimationDurationFrames(input);
    const parameters = row.status === 'succeeded' && row.resultSourceVersionId !== null
      ? { from: { sourceVersionId: row.resultSourceVersionId }, extent: { durationFrames: accepted, fps: input.fps } }
      : { from: { executionId: row.id }, extent: { acceptedDurationFrames: accepted, fps: input.fps } };
    if (commit({ operation: 'add_web_animation', parameters: { clipId: newId(), startFrame: frame, newTrackId: newId(), ...parameters }, placement })?.ok === true) refreshTasks();
  }, [commit, frame, placement, refreshTasks]);
  const retryExecution = React.useCallback((row: TimelineExecutionRow): void => {
    const input = timelineExecutionInput(row);
    if (input !== null) openCreate({ prompt: input.prompt, engine: input.engine, aspect: input.aspect, durationSeconds: input.durationSeconds, addAtPlayhead: true });
  }, [openCreate]);
  const inProgressCount = (rows ?? []).filter((row) => !timelineExecutionEnded(row.status)).length;

  const needSelection = React.useCallback((): TimelineClip | null => {
    if (selected === undefined) { toast.warning(t('timeline.edit.selectFirst')); return null; }
    return selected;
  }, [selected, t]);
  const split = React.useCallback((): void => {
    const clip = needSelection();
    if (clip === null) return;
    if (!(clip.startFrame < frame && frame < clip.startFrame + clip.durationFrames)) { toast.warning(t('timeline.edit.splitOutside')); return; }
    commit({ operation: 'split', parameters: { clipId: clip.id, frame, newClipId: newId() }, placement });
  }, [needSelection, frame, commit, placement, t]);
  const duplicate = React.useCallback((): void => {
    const clip = needSelection();
    if (clip === null) return;
    const copyId = newId();
    if (commit({ operation: 'duplicate', parameters: { clipId: clip.id, newClipId: copyId }, placement })?.ok === true) session.select(copyId);
  }, [needSelection, commit, placement, session]);
  const remove = React.useCallback((): void => {
    const clip = needSelection();
    if (clip !== null) commit({ operation: 'delete', parameters: { clipId: clip.id }, placement });
  }, [needSelection, commit, placement]);
  const undo = React.useCallback((): void => { if (!readOnly) session.historyStep('undo'); }, [readOnly, session]);
  const redo = React.useCallback((): void => { if (!readOnly) session.historyStep('redo'); }, [readOnly, session]);
  const toggleMagnet = React.useCallback((): void => prefs.set({ magnet: !prefs.magnet }), [prefs]);
  const toggleSnap = React.useCallback((): void => prefs.set({ snap: !prefs.snap }), [prefs]);
  const toggleLinkage = React.useCallback((): void => prefs.set({ linkage: !prefs.linkage }), [prefs]);
  const minZoom = timelineMinZoom(extent, trackWidth);
  const pixelsPerFrame = Math.min(TIMELINE_MAX_PIXELS_PER_FRAME, Math.max(minZoom, zoom));
  const zoomValue = React.useMemo(() => [Math.log2(pixelsPerFrame)], [pixelsPerFrame]);
  const changeZoom = React.useCallback((value: number[]): void => setZoom(2 ** (value[0] ?? Math.log2(DEFAULT_PIXELS_PER_FRAME))), []);
  const locateClip = React.useCallback((clipId: string): void => {
    session.select(clipId);
    const clip = document.clips[clipId];
    if (clip === undefined) return;
    seekTo(clip.startFrame);
    const viewport = trackViewport.current;
    const left = clip.startFrame * pixelsPerFrame;
    // The lanes visible right of the sticky track headers; the margin keeps the start off the headers' edge.
    if (viewport !== null && (left < viewport.scrollLeft || left >= viewport.scrollLeft + viewport.clientWidth - TIMELINE_TRACK_HEADER_PX)) viewport.scrollTo({ left: Math.max(0, left - LOCATE_MARGIN_PX) });
  }, [session, document.clips, seekTo, pixelsPerFrame]);

  const nudge = React.useCallback((frames: number): void => {
    if (readOnly || selected === undefined) { seekTo(frame + frames); return; }
    if (selected.trackId === TIMELINE_MAIN_TRACK_ID && placement.magnet) {
      const sequence = clips.filter((clip) => clip.trackId === TIMELINE_MAIN_TRACK_ID);
      const index = sequence.findIndex((clip) => clip.id === selected.id);
      const neighbour = sequence[index + (frames > 0 ? 1 : -1)];
      if (neighbour === undefined) return;
      commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: frames > 0 ? neighbour.startFrame + neighbour.durationFrames : neighbour.startFrame }, placement }, { hold: true });
      return;
    }
    commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: Math.max(0, selected.startFrame + frames) }, placement }, { hold: true });
  }, [readOnly, selected, seekTo, frame, placement, clips, commit]);
  const changeTrack = React.useCallback((direction: 1 | -1, repeat: boolean): void => {
    if (readOnly || selected === undefined) return;
    const index = labels.visual.findIndex((track) => track.id === selected.trackId);
    if (index < 0) { toast.warning(t('timeline.errors.track_missing')); return; }
    const target = labels.visual[index + direction];
    if (target !== undefined) { commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: selected.startFrame, trackId: target.id }, placement }, { hold: true }); return; }
    // A held key stops at the top track; only a fresh press creates a track above it.
    if (repeat) return;
    if (direction === 1) commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: selected.startFrame, newTrackId: newId() }, placement });
    else toast.warning(t('timeline.edit.lowestTrack'));
  }, [readOnly, selected, labels.visual, commit, placement, t]);

  // Held while a track clip or a preview layer is dragged: a drag writes once, on release.
  const layoutDragging = React.useRef(false);
  const draggingChange = React.useCallback((value: boolean): void => { layoutDragging.current = value; }, []);
  const onKeyDown = React.useCallback((event: KeyboardEvent): void => {
    // A fresh press, whatever it does, ends the key hold so a later repeat cannot join the old step.
    if (!event.repeat) session.endHold();
    // Text fields and Select triggers answer their own keys (a trigger's typeahead does not mark them handled).
    if (!regionOwnsKeyboard(event.target, 'space') || (event.target instanceof Element && (isEditableTarget(event.target) || event.target.closest('[role="combobox"]') !== null))) return;
    const action = timelineKeyAction(event, fps);
    if (action === null) return;
    const editing = action.kind !== 'nudge' && action.kind !== 'toggle_snap';
    if (editing && readOnly) return;
    event.preventDefault();
    // A drag writes once, on release; only the snap switch changes while it is held.
    if (layoutDragging.current && action.kind !== 'toggle_snap') return;
    switch (action.kind) {
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'duplicate': duplicate(); break;
      case 'split': split(); break;
      case 'delete': remove(); break;
      case 'toggle_snap': toggleSnap(); break;
      case 'nudge': nudge(action.frames); break;
      case 'change_track': changeTrack(action.direction, action.repeat); break;
    }
  }, [session, fps, readOnly, undo, redo, duplicate, split, remove, toggleSnap, nudge, changeTrack]);
  const root = React.useRef<HTMLDivElement>(null);
  const editorColumn = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = editorColumn.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setTrackWidth(Math.max(0, element.clientWidth - TIMELINE_TRACK_HEADER_PX)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The element of this Timeline holding keyboard focus. A clip moved to another track row remounts there, and a
  // deleted clip, track or list row is gone; either way the browser drops focus to <body>, so it is handed back to
  // the clip, or to the Timeline.
  const focused = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const element = root.current;
    if (element === null) return;
    /**
     * Remember the focused element.
     * @param event - The focus event.
     * @throws {never} Never.
     */
    const focusIn = (event: FocusEvent): void => {
      focused.current = event.target instanceof HTMLElement ? event.target : null;
    };
    /**
     * Forget the element when focus leaves it while it is still on the page: the user moved focus away.
     * @param event - The focus event.
     * @throws {never} Never.
     */
    const focusOut = (event: FocusEvent): void => {
      const target = event.target;
      if (target !== focused.current) return;
      queueMicrotask(() => { if (target instanceof HTMLElement && target.isConnected && focused.current === target) focused.current = null; });
    };
    element.addEventListener('focusin', focusIn);
    element.addEventListener('focusout', focusOut);
    return () => {
      element.removeEventListener('focusin', focusIn);
      element.removeEventListener('focusout', focusOut);
    };
  }, []);
  React.useLayoutEffect(() => {
    const element = focused.current;
    if (element === null) return;
    if (element.isConnected) {
      if (window.document.activeElement !== element) focused.current = null;
      return;
    }
    focused.current = null;
    if (window.document.activeElement !== window.document.body) return;
    const clipId = element.dataset.clipId;
    // The same kind of element: the preview's layers carry the clip id too.
    const clip = clipId === undefined ? null : root.current?.querySelector<HTMLElement>(`${element.localName}[data-clip-id="${CSS.escape(clipId)}"]`);
    (clip ?? root.current)?.focus();
  });
  const keyHandler = React.useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  React.useEffect(() => {
    // Listening on window runs after React's root listener, so a focused control (slider, select) has
    // already handled and marked the key. Keys reach the handler from inside this Space body, or from
    // <body> after the focused element was removed; hidden Spaces have no listener (Activity removes effects).
    /**
     * Forward a key press inside this Timeline to the current handler.
     * @param event - The key press.
     * @throws {never} Never.
     */
    const listener = (event: KeyboardEvent): void => {
      if (event.target === window.document.body || (event.target instanceof Node && root.current?.contains(event.target) === true)) keyHandler.current(event);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // Preview selection and handles (#1410 design §4.2, §4.3).
  const hitLayer = React.useRef<HTMLDivElement>(null);
  const pickAt = React.useCallback((clientX: number, clientY: number): void => {
    const rect = hitLayer.current?.getBoundingClientRect();
    if (rect === undefined || factor <= 0) return;
    const point = { x: (clientX - rect.left) / factor, y: (clientY - rect.top) / factor };
    const hit = [...pickable].reverse().find(({ clip, base }) => timelineLayerContains(timelineLayerCorners(canvas, base, transformOf(clip)), point));
    // A field left mid-entry commits on blur before the panel it belongs to unmounts.
    const focusedElement = window.document.activeElement;
    if (focusedElement instanceof HTMLElement && focusedElement !== window.document.body) focusedElement.blur();
    session.select(hit?.clip.id ?? null);
  }, [factor, canvas, pickable, transformOf, session]);
  const pickFromHitLayer = React.useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    pickAt(event.clientX, event.clientY);
  }, [pickAt]);
  const pickFromHandles = React.useCallback((event: MouseEvent): void => pickAt(event.clientX, event.clientY), [pickAt]);
  const selectedAtFrame = selected !== undefined && frame >= selected.startFrame && frame < selected.startFrame + selected.durationFrames;
  const handled = selected === undefined || readOnly || factor <= 0 ? undefined : pickable.find((item) => item.clip.id === selected.id);
  const handledId = handled?.clip.id ?? null;
  const playbackNow = React.useRef(playback);
  playbackNow.current = playback;
  const clipsNow = React.useRef(document.clips);
  clipsNow.current = document.clips;
  const draggedId = React.useRef<string | null>(null);
  const overrideLayer = React.useCallback((transform: TimelineLayerTransform | null): void => {
    setOverride(transform === null || handledId === null ? null : { clipId: handledId, transform });
  }, [handledId]);
  const commitLayer = React.useCallback((transform: TimelineLayerTransform): void => {
    if (handledId !== null) commit({ operation: 'set_transform', parameters: { clipId: handledId, transform }, placement });
  }, [handledId, commit, placement]);
  const layerDragging = React.useCallback((dragging: boolean): void => {
    layoutDragging.current = dragging;
    if (dragging) {
      draggedId.current = handledId;
      if (playbackNow.current.intent === 'play') playbackNow.current.toggle();
      return;
    }
    // The handles unmount mid-drag when a collaborator deletes the clip.
    if (draggedId.current !== null && clipsNow.current[draggedId.current] === undefined) toast.warning(t('timeline.errors.clip_removed'));
    draggedId.current = null;
  }, [handledId, t]);
  const [notesLayer, setNotesLayer] = React.useState<HTMLDivElement | null>(null);
  const videoNotes = visible.flatMap((clip, index) => {
    const state = clip.kind === 'video' ? videoStates.get(clip.id) : undefined;
    if (state !== 'loading' && state !== 'failed') return [];
    const track = labels.nameOf(clip.trackId) ?? clip.trackId;
    return [{ clipId: clip.id, z: index + 1, state, track }];
  });
  const retryVideoLayer = React.useCallback((clipId: string): void => {
    // The asset is read again first: a file address that stopped loading may have expired (#1410 design §6.2).
    const clip = document.clips[clipId];
    if (clip !== undefined) void assetOf(clip)?.refetch();
    retryVideo(clipId);
  }, [document.clips, assetOf, retryVideo]);

  const openMaterial = React.useCallback((): void => {
    if (readOnly) return;
    material.open(duration, selected !== undefined && labels.nameOf(selected.trackId) !== null ? selected.trackId : TIMELINE_MAIN_TRACK_ID);
    setMaterialOpen(true);
  }, [readOnly, duration, material, setMaterialOpen, selected, labels]);
  const closeMaterial = React.useCallback((): void => { material.close(); setMaterialOpen(false); }, [material, setMaterialOpen]);
  // The frame's border box: the fitted area inside the 1px border, plus the border.
  const previewStyle = React.useMemo(() => ({ width: `${fit.width + 2}px`, height: `${fit.height + 2}px` }), [fit.width, fit.height]);
  const chooseFrame = React.useCallback((preset: TimelineFramePreset): void => {
    commit({ operation: 'set_frame', parameters: { preset }, placement });
  }, [commit, placement]);
  const inConflict = clips.some((clip) => !readyIds.has(clip.id) && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames);
  const noSelection = selected === undefined;
  const hasConflicts = arrangement.hasConflicts || damagedClipIds.length > 0;
  // Click-focusable, not tab-reachable: where the keyboard goes when the focused element leaves the page.
  return <div ref={root} data-testid='timeline-space' data-project-id={projectId} data-space-id={spaceId} tabIndex={-1} data-space-focus-root='' className='flex h-full min-h-0 min-w-0 bg-background outline-none'>
    {/* The tracks take their content's height up to half the column; the preview takes the rest. */}
    <div ref={editorColumn} className='grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto_auto_fit-content(50%)]'>
      <div className='flex min-h-0 flex-1 items-center justify-center bg-muted/40 p-6'>
        {/* The frame clips the layers; the operation layer above it does not, so handles outside the frame stay reachable;
            the note layer is on top and lets clicks through except on its notes (#1410 design §4.1). */}
        <div ref={setPreviewArea} data-testid='timeline-preview-area' className='flex h-full w-full max-w-4xl items-center justify-center'>
          <div className='relative shrink-0' style={previewStyle}>
            <div data-testid='timeline-preview' className='absolute inset-0 isolate flex items-center justify-center overflow-hidden rounded-content-sm border border-border bg-background'>
              <div ref={videoHost} className='pointer-events-none absolute inset-0' />
              <TimelineWebPreview projectId={projectId} entries={webEntries} states={playback.webStates} sharing={sharing} onPlayer={registerPlayer} onRetry={retryWeb} onUnavailable={reportUnavailable} uploadNotes={uploadNotes} notes={notesLayer} />
              {clips.length === 0 && <div data-testid='timeline-space-empty' className='flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground'><Film className='size-8' /><p>{t('timeline.empty')}</p></div>}
              {inConflict && visible.length === 0 && <p className='p-6 text-center text-sm text-status-error-foreground'>{t('timeline.conflictHelp')}</p>}
            </div>
            {!readOnly && <div data-testid='timeline-layer-overlay' className='absolute inset-px' style={OPERATION_LAYER_STYLE}>
              <div ref={hitLayer} data-testid='timeline-layer-hit' className='absolute inset-0' onPointerDown={pickFromHitLayer} />
              {handled !== undefined && <React.Suspense fallback={null}>
                <TimelineLayerHandles key={handled.clip.id} canvas={canvas} base={handled.base} transform={handled.clip.transform} factor={factor} snap={prefs.snap}
                  onOverride={overrideLayer} onCommit={commitLayer} onDraggingChange={layerDragging} onPick={pickFromHandles} />
              </React.Suspense>}
            </div>}
            <div data-testid='timeline-preview-notes' className='pointer-events-none absolute inset-px' style={NOTE_LAYER_STYLE}>
              <div ref={setNotesLayer} className='absolute right-3 top-3 flex flex-col items-end gap-1.5 *:pointer-events-auto'>
                {videoNotes.map((note) => <PreviewNote key={note.clipId} clipId={note.clipId} z={note.z}
                  text={t(note.state === 'failed' ? 'timeline.preview.videoUnavailable' : 'timeline.preview.videoLoading', { track: note.track })}>
                  {note.state === 'failed' && <Button data-testid={`timeline-video-retry-${note.clipId}`} variant='outline' size='compact' onClick={() => retryVideoLayer(note.clipId)}>{t('timeline.retry')}</Button>}
                </PreviewNote>)}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div data-playback-state={playback.state} className='flex shrink-0 items-center gap-3 border-t border-border px-4 py-2'>
        <Button data-testid='timeline-play' variant='outline' size='sm' className='gap-1.5' disabled={duration === 0} onClick={playback.toggle} icon={playback.intent === 'play' ? <Pause className='size-4' /> : <Play className='size-4' />}>{playback.intent === 'play' ? t('timeline.pause') : t('timeline.play')}</Button>
        <span className='shrink-0 text-xs tabular-nums'>{`${formatTimelineTimecode(frame, fps)} / ${formatTimelineTimecode(duration, fps)}`}</span>
        <Slider aria-label={t('timeline.seek')} value={seekValue} onValueChange={onSeek} min={0} max={Math.max(1, duration - 1)} step={1} disabled={duration === 0} className='min-w-0 flex-1' />
        {playback.state === 'waiting' && <span className='shrink-0 text-xs text-muted-foreground'>{t('timeline.transport.waiting')}</span>}
        <TimelineFrameRatio width={canvas.width} height={canvas.height} readOnly={readOnly} onChoose={chooseFrame} />
      </div>
      <div role='toolbar' aria-label={t('timeline.tracks')} className='flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <Button data-testid='timeline-add-media' variant='outline' size='sm' className='gap-1.5' disabled={readOnly} onClick={openMaterial} icon={<Plus className='size-4' />}>{t('timeline.addMedia')}</Button>
          {!readOnly && webLimits !== undefined && <Button data-testid='timeline-create-web-animation' variant='outline' size='sm' className='gap-1.5' onClick={openBlankCreate} icon={<Sparkles className='size-4' />}>{t('timeline.webAnimation.create')}</Button>}
          <Button data-testid='timeline-open-executions' variant='outline' size='sm' className='gap-1.5 aria-pressed:border-active-border' aria-pressed={listOpen} onClick={toggleList} icon={<ListChecks className='size-4' />}>
            {t('timeline.webAnimation.executions')}{inProgressCount > 0 && <CountChip count={inProgressCount} />}
          </Button>
          <Button data-testid='timeline-undo' variant='outline' size='sm' className='gap-1.5' disabled={readOnly || !history.canUndo} onClick={undo} icon={<Undo2 className='size-4' />}>{t('timeline.edit.undo')}</Button>
          <Button data-testid='timeline-redo' variant='outline' size='sm' className='gap-1.5' disabled={readOnly || !history.canRedo} onClick={redo} icon={<Redo2 className='size-4' />}>{t('timeline.edit.redo')}</Button>
          <Separator orientation='vertical' className='h-5' />
          <Button data-testid='timeline-split' variant='outline' size='sm' disabled={readOnly} aria-disabled={noSelection} className={cn('gap-1.5', noSelection && 'opacity-50')} onClick={split} icon={<Scissors className='size-4' />}>{t('timeline.edit.split')}<ToolbarShortcut>{formatShortcut({ mod: true, key: 'B' })}</ToolbarShortcut></Button>
          <Button data-testid='timeline-duplicate' variant='outline' size='sm' disabled={readOnly} aria-disabled={noSelection} className={cn('gap-1.5', noSelection && 'opacity-50')} onClick={duplicate} icon={<Copy className='size-4' />}>{t('timeline.edit.duplicate')}<ToolbarShortcut>{formatShortcut({ mod: true, key: 'D' })}</ToolbarShortcut></Button>
          <Button data-testid='timeline-delete' variant='outline' size='sm' disabled={readOnly} aria-disabled={noSelection} className={cn('gap-1.5', noSelection && 'opacity-50')} onClick={remove} icon={<Trash2 className='size-4' />}>{t('timeline.edit.delete')}<ToolbarShortcut>{formatShortcut({ key: 'Delete' })}</ToolbarShortcut></Button>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <TimelineSwitch testId='timeline-toggle-magnet' label={t('timeline.edit.magnet')} pressed={prefs.magnet} icon={MAGNET_ICON} onToggle={toggleMagnet} />
          <TimelineSwitch testId='timeline-toggle-snap' label={t('timeline.edit.snap')} shortcut='N' pressed={prefs.snap} icon={SNAP_ICON} onToggle={toggleSnap} />
          <TimelineSwitch testId='timeline-toggle-linkage' label={t('timeline.edit.linkage')} pressed={prefs.linkage} icon={LINKAGE_ICON} onToggle={toggleLinkage} />
          <span className='flex items-center gap-2'>
            <span className='text-xs text-muted-foreground'>{t('timeline.edit.zoom')}</span>
            <Slider data-testid='timeline-zoom' aria-label={t('timeline.edit.zoom')} value={zoomValue} onValueChange={changeZoom} min={Math.log2(minZoom)} max={Math.log2(TIMELINE_MAX_PIXELS_PER_FRAME)} step={ZOOM_STEP} className='w-28' />
          </span>
        </div>
      </div>
      <TimelineTrackArea projectId={projectId} document={document} labels={labels} readyIds={readyIds} selectedId={selectedId} frame={frame} extent={extent} viewportRef={trackViewport}
        pixelsPerFrame={pixelsPerFrame} readOnly={readOnly} snap={prefs.snap} placement={placement} web={web} webClips={webClips} uploads={uploadViews} onSelect={selectClip} onSeek={seekTo} onCommit={commitCommand} onVanished={vanished} onDraggingChange={draggingChange} />
    </div>
    <aside data-testid='timeline-side-panel' className='flex w-72 shrink-0 flex-col border-l border-border'>
      <ScrollArea className='min-h-0 flex-1' viewportClassName='p-3'>
        {listOpen ? <TimelineExecutionList projectId={projectId} rows={rows} view={listView} openId={openRow} readOnly={readOnly} onView={setListView} onToggle={toggleRow} onClose={closeList}
          onCancel={cancelExecution} onAdd={addExecution} onRetry={retryExecution} /> : <div className='flex flex-col gap-3'>
          <section className={PANEL}>
            {selected === undefined ? <p className='text-muted-foreground'>{t('timeline.selectClip')}</p>
              : <TimelineClipProperties key={selected.id} spaceId={spaceId} document={document} web={web} clip={selected} atFrame={selectedAtFrame} conflict={!readyIds.has(selected.id)} reason={reasons.get(selected.id) ?? null}
                labels={labels} readOnly={readOnly} placement={placement} onCommit={commitCommand}
                name={selected.kind === 'web-animation' ? t('timeline.webAnimation.copy') : selected.kind === 'upload' ? selected.upload.name : selectedResource.data?.displayName || t(selectedResource.isError ? 'timeline.mediaUnavailable' : 'timeline.video')}
                request={selected.kind === 'web-animation' ? webClips.get(selected.id)?.prompt ?? null : null} upload={selectedUpload} />}
          </section>
          <section data-testid='timeline-conflicts' className={PANEL}>
            <h3 className='text-sm font-semibold'>{t('timeline.conflictList')}</h3>
            {hasConflicts ? <>
              <p className='text-muted-foreground'>{t('timeline.conflictHelp')}</p>
              {clips.filter((clip) => !readyIds.has(clip.id)).map((clip) => <TimelineConflictRow key={clip.id} projectId={projectId} clip={clip} assetId={timelineClipSource(document.sources, clip)?.assetId ?? ''}
                name={clip.kind === 'web-animation' ? webClips.get(clip.id)?.prompt || t('timeline.webAnimation.copy') : clip.kind === 'upload' ? clip.upload.name : null} track={labels.nameOf(clip.trackId) ?? t('timeline.edit.trackRemoved')} reason={reasons.get(clip.id) ?? null} selected={selectedId === clip.id} onLocate={locateClip} />)}
              {damagedClipIds.map((clipId) => <TimelineDamagedRow key={clipId} clipId={clipId} readOnly={readOnly} onDelete={removeDamaged} />)}
            </> : <p className='text-muted-foreground'>{t('timeline.noConflicts')}</p>}
          </section>
        </div>}
      </ScrollArea>
    </aside>
    {materialState.open && materialOpen && <TimelineMaterialDialog key={`${projectId}:${spaceId}`} projectId={projectId} spaceId={spaceId} draft={material} canWrite={!readOnly} document={document} placement={placement} onClose={closeMaterial} />}
    {draft.status !== 'closed' && draft.open && webLimits !== undefined && <TimelineWebAnimationDialog spaceId={spaceId} draft={draft} retry={retryDialog} limits={webLimits}
      onEdit={editDraft} onExecute={execute} onClose={closeDraft} />}
  </div>;
}

/**
 * Bind Timeline to the document and connection already held by its Space tab.
 * @param props - The current Project, Space and role.
 * @returns The existing content state or the supported Timeline editor.
 * @throws {never} Never.
 */
export function TimelineSpace(props: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const connection = useSpaceConnection();
  const doc = getDoc(docName.timelineSpace(props.projectId, props.spaceId));
  const state = useTimelineDocument(doc, connection.hasEverSynced);
  if (!connection.hasEverSynced) return <div data-testid={connection.status === 'authFailed' ? 'timeline-space-unavailable' : 'timeline-space-loading'} className='flex h-full items-center justify-center p-6 text-sm text-muted-foreground'>{t(connection.status === 'authFailed' ? 'timeline.unavailable' : 'timeline.loading')}</div>;
  if (state.document === null) return <div data-testid='timeline-space-error' className='flex h-full items-center justify-center p-6 text-sm text-muted-foreground'>{t('timeline.incompatible')}</div>;
  return <TimelineEditor {...props} doc={doc} document={state.document} damagedClipIds={state.damaged.clips} />;
}
