// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import type * as Y from 'yjs';
import { ArrowRightToLine, Code, Copy, Film, Link2, Magnet, Plus, Redo2, Scissors, Trash2, Type, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  durationToFrames, getLocale, newId, TIMELINE_MAIN_TRACK_ID, timelineLayerBase, type TimelineFramePreset, timelineLayerContains, timelineLayerCorners, timelineLayerStyle,
  type TimelineClip, type TimelineDocumentV1, type TimelineLayerBox, type TimelineLayerTransform, type TimelineWebAnimationClip,
} from '@breatic/shared';
import { webAnimationDurationFrames, webAnimationExecutionFailed } from '@breatic/shared/space-content';
import { arrangeTimelineClips, timelineClipSource, timelineWebSourceOf } from '@web/data/yjs/timeline-arrangement';
import { isTimelineSizeRefusal } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand, TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { audibleTimelineClipsAt, timelineStackOrder, visibleTimelineClipsAt } from '@web/data/yjs/timeline-layers';
import { orderedTimelineClips, timelineTrackRank } from '@web/data/yjs/timeline-order';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Slider } from '@web/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useDocProvider } from '@web/data/yjs/collab-socket';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useProjectSpaceList } from '@web/data/yjs/project-meta';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';
import { TIMELINE_MAX_PIXELS_PER_FRAME, TIMELINE_TRACK_HEADER_PX, timelineMinZoom } from '@web/spaces/timeline/timeline-zoom';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useTranslation } from '@web/i18n/use-translation';
import { isEditableTarget } from '@web/lib/is-editable-target';
import { toast } from '@web/lib/toast';
import { stopFollowing } from '@web/stores/follow';
import type { SpaceBodyProps } from '@web/spaces';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';
import { TimelineClipProperties } from '@web/spaces/timeline/TimelineClipProperties';
import { TimelineTransport } from '@web/spaces/timeline/TimelineTransport';
import { TimelineToolbar, toolbarButton, type TimelineToolbarEntry } from '@web/spaces/timeline/TimelineToolbar';
import { timelinePreviewFit } from '@web/spaces/timeline/timeline-preview-fit';
import { TimelineMaterialDialog } from '@web/spaces/timeline/TimelineMaterialDialog';
import { TimelineTrackArea } from '@web/spaces/timeline/TimelineTrackArea';
import { getTimelineEditSession, type TimelineEditOptions } from '@web/data/yjs/timeline-edit-session';
import { timelineKeyAction } from '@web/spaces/timeline/timeline-keyboard';
import { getTimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { getTimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { timelineUploadText, useTimelineUploadViews } from '@web/spaces/timeline/use-timeline-upload-views';
import { useTimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';
import { useTimelineDocument } from '@web/spaces/timeline/use-timeline-document';
import { timelineClipKind, timelineClipName } from '@web/spaces/timeline/timeline-clip-name';
import { TimelineImageLayer, TimelineTextLayer, type TimelineImageState } from '@web/spaces/timeline/TimelineStillLayers';
import { retryTimelineFonts, useTimelineTextFonts } from '@web/spaces/timeline/timeline-text-fonts';
import { useTimelineEditPrefs } from '@web/spaces/timeline/use-timeline-edit-prefs';
import { useTimelinePlayback } from '@web/spaces/timeline/use-timeline-playback';
import { usePublishTimelineView } from '@web/spaces/timeline/use-publish-timeline-view';
import { userMovedScroll, type TrackScroll } from '@web/spaces/timeline/timeline-follow-scroll';
import type { TimelineWebClipView } from '@web/spaces/timeline/TimelineTrackArea';
import { TimelineWebAnimationPicker } from '@web/spaces/timeline/TimelineWebAnimationPicker';
import type { PlayableRow } from '@web/spaces/web-animation/motion-parts';
import { TimelineWebPreview, PreviewNote, type TimelineUploadNote, type TimelineWebEntry } from '@web/spaces/timeline/TimelineWebPreview';
import { useTimelineLimitsQuery, useTimelinePreviewLimits } from '@web/spaces/timeline/use-timeline-limits';
import { timelineApi } from '@web/data/api/timeline';
import { useTimelineWebResolution } from '@web/spaces/timeline/use-timeline-web-resolution';
import { endedSentenceKey } from '@web/spaces/web-animation/execution-text';
import { requestTitle, type TitleTranslator } from '@web/spaces/web-animation/web-animation-title';
import { useSpaceOpenRequestStore } from '@web/stores/space-open-request';
import type { TimelineWebLayer, WebAnimationPlayerElement } from '@web/spaces/timeline/web-animation-host';
import { EMPTY_WEB_INSTANCE_POOL, allocateWebInstances } from '@web/spaces/timeline/web-instance-pool';


/** The existing content document and its supported native projection. */
interface TimelineEditorProps extends SpaceBodyProps { doc: Y.Doc; stored: TimelineDocumentV1 }

const DEFAULT_PIXELS_PER_FRAME = 2;
// The zoom slider moves in powers of two so every zoom level is equally reachable.
const ZOOM_STEP = 0.1;

const PANEL = 'flex flex-col gap-2 rounded-chrome border border-border p-3 text-xs';
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_IMAGE_STATES: ReadonlyMap<string, { state: TimelineImageState; size: { width: number; height: number } | null }> = new Map();

/**
 * What a web copy on a track shows, named by the one title rule from what made it (#1490 design §8.1).
 * @param clip - The copy.
 * @param web - The resolution of its references.
 * @param t - The translator.
 * @returns Its view.
 * @throws {never} Never.
 */
function webClipView(clip: TimelineWebAnimationClip, web: Parameters<typeof timelineWebSourceOf>[0], t: TitleTranslator): TimelineWebClipView {
  const { operationId } = clip.contentBinding;
  const sourceId = timelineWebSourceOf(web, clip);
  const source = sourceId === null ? undefined : web.sources[sourceId];
  const execution = operationId === null ? undefined : web.executions[operationId];
  const origin = source ?? execution;
  const named = origin === undefined ? { title: null, request: null, baseRequest: null, originExecutionId: null }
    : { title: requestTitle(origin, t),
      request: origin.request, baseRequest: origin.base?.request ?? null, originExecutionId: origin.executionId };
  if (source !== undefined) return { state: 'ready', ...named, status: null, phase: null, failureReason: null };
  if (execution === undefined) return { state: 'unresolved', ...named, status: null, phase: null, failureReason: null };
  return {
    state: webAnimationExecutionFailed(execution.status) ? 'failed' : 'pending', ...named,
    status: execution.status, phase: execution.status === 'running' ? execution.phase : null, failureReason: execution.failureReason,
  };
}
/** The selected clip's properties with whether its file could be read (inner#1709). */
type TimelineSelectedPropertiesProps = Omit<React.ComponentProps<typeof TimelineClipProperties>, 'name' | 'media'> & {
  /** Whether its element or picture failed to load. */
  elementFailed: boolean;
  /** Loads its layer again. */
  onRetry: (clipId: string) => void;
};

/**
 * The selected clip's properties: named by kind (a text is named "Text") or by its source's name, with whether its file
 * could be read.
 * @param props - The properties and the media facts.
 * @param props.elementFailed - Whether its element or picture failed to load.
 * @param props.onRetry - Loads its layer again.
 * @returns The properties.
 * @throws {never} Never.
 */
function TimelineSelectedProperties({ elementFailed, onRetry, ...props }: TimelineSelectedPropertiesProps): React.JSX.Element {
  const t = useTranslation();
  const locale = getLocale();
  const { clip } = props;
  const kind = timelineClipKind(clip);
  const retry = React.useCallback((): void => onRetry(clip.id), [onRetry, clip.id]);
  const media = React.useMemo(() => elementFailed ? { text: t('timeline.media.readFailed', { kind }), onRetry: retry } : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the text follows the locale, which `t` itself does not.
    [elementFailed, kind, retry, t, locale]);
  const name = clip.kind === 'text' ? t('timeline.video', { kind: 'text' }) : clip.kind === 'web-animation' ? t('timeline.webAnimation.copy')
    : timelineClipName(clip, { assetName: timelineClipSource(props.document.sources, clip)?.name ?? null, webTitle: null }, t);
  return <TimelineClipProperties {...props} name={name} media={media} />;
}

const MAGNET_ICON = <Magnet className='size-4' />;
// The preview handles carry react-moveable, loaded the first time an editable layer is selected (#1410 design §4.3).
const TimelineLayerHandles = React.lazy(() => import('@web/spaces/timeline/TimelineLayerHandles').then((module) => ({ default: module.TimelineLayerHandles })));
const NOTE_LAYER_STYLE = { zIndex: 20 } as const;
const OPERATION_LAYER_STYLE = { zIndex: 10 } as const;
const SNAP_ICON = <ArrowRightToLine className='size-4' />;
const LINKAGE_ICON = <Link2 className='size-4' />;
const ADD_MEDIA_ICON = <Plus className='size-4' />;
const ADD_WEB_ICON = <Code className='size-4' />;
const ADD_TEXT_ICON = <Type className='size-4' />;
const UNDO_ICON = <Undo2 className='size-4' />;
const REDO_ICON = <Redo2 className='size-4' />;
const SPLIT_ICON = <Scissors className='size-4' />;
const DUPLICATE_ICON = <Copy className='size-4' />;
const DELETE_ICON = <Trash2 className='size-4' />;
const SPLIT_KEY = formatShortcut({ mod: true, key: 'B' });
const DUPLICATE_KEY = formatShortcut({ mod: true, key: 'D' });
const DELETE_KEY = formatShortcut({ key: 'Delete' });
const UNDO_KEY = formatShortcut({ mod: true, key: 'Z' });
const REDO_KEY = formatShortcut({ mod: true, shift: true, key: 'Z' });

/**
 * Whether a clip plays between a frame and the premount lead after it.
 * @param clip - The clip.
 * @param frame - The current frame.
 * @param lead - The premount lead in frames.
 * @returns Whether it is visible now or starts within the lead.
 * @throws {never} Never.
 */
function nearFrame(clip: TimelineClip, frame: number, lead: number): boolean {
  return frame < clip.startFrame + clip.durationFrames && frame >= clip.startFrame - lead;
}

/**
 * Arrange videos, pictures, sounds, texts and web animations on tracks, edit them and preview the shared
 * integer-frame sequence (inner#1709).
 * @param props - The open Timeline's supported content and current role.
 * @param props.projectId - The owning Project.
 * @param props.spaceId - The open Space tab's identity.
 * @param props.readOnly - The existing Project role's editing restriction.
 * @param props.doc - The content document held by the existing Space connection.
 * @param props.stored - Its validated native Timeline projection, as stored.
 * @returns The preview, toolbar, tracks and properties.
 * @throws {never} Never.
 */
function TimelineEditor({ projectId, spaceId, readOnly = false, doc, stored }: TimelineEditorProps): React.JSX.Element {
  const t = useTranslation();
  // The stored document reaches only the web resolution; every reader below sees the view document, whose clips are
  // the ones that can be shown, each at the length it plays (inner#1709).
  const web = useTimelineWebResolution(projectId, spaceId, stored);
  const document = React.useMemo((): TimelineDocumentV1 => ({ ...stored, clips: arrangeTimelineClips(stored, web) }), [stored, web]);
  // `t` stays the same function across a language switch; memos that build text depend on the locale it reads.
  const locale = getLocale();
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
    projectId, spaceId, onLanded: (kind) => { void queryClient.invalidateQueries({ queryKey: ['timeline-media', projectId, kind] }); },
  }), [doc, name, projectId, spaceId, queryClient]);
  const material = React.useMemo(() => getTimelineMediaDraft(doc, name, { projectId, spaceId, edit: editWithNotice, startUpload: uploads.start }), [doc, name, projectId, spaceId, editWithNotice, uploads]);
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
  const limitsQuery = useTimelineLimitsQuery(projectId);
  const limits = limitsQuery.data;
  const webLimits = limits?.webAnimation;
  // Edits of web copies plan against the extents this resolution gives.
  session.setWebResolution(web);
  const selectedId = history.selectedClipId;
  const selected = selectedId === null ? undefined : document.clips[selectedId];
  const visible = React.useMemo(() => visibleTimelineClipsAt(document, frame), [document, frame]);
  const audible = React.useMemo(() => audibleTimelineClipsAt(document, frame), [document, frame]);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the text follows the locale, which `t` itself does not.
  const webClips = React.useMemo(() => new Map(clips.flatMap((clip) => clip.kind === 'web-animation' ? [[clip.id, webClipView(clip, web, t)] as const] : [])), [clips, web, t, locale]);
  const uploadViews = useTimelineUploadViews(name, uploads, clips);
  // A visible placeholder draws no picture and hides nothing below it; the preview notes it by track.
  const uploadNotes = React.useMemo(() => visible.flatMap((clip, index): TimelineUploadNote[] => {
    const view = clip.kind === 'upload' ? uploadViews.get(clip.id) : undefined;
    return view === undefined || clip.kind !== 'upload' ? [] : [{ clipId: clip.id, z: index + 1, text: t('timeline.upload.preview', { track: labels.nameOf(clip.trackId) ?? clip.trackId, state: view.state, kind: clip.upload.kind }) }];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the text follows the locale, which `t` itself does not.
  }), [visible, uploadViews, labels, t, locale]);
  const selectedUploadView = selected?.kind === 'upload' ? uploadViews.get(selected.id) : undefined;
  const selectedUploadId = selected?.kind === 'upload' ? selected.upload.uploadId : null;
  const selectedUploadName = selected?.kind === 'upload' ? selected.upload.name : '';
  const retryUpload = React.useCallback((): void => { if (selectedUploadId !== null) uploads.retry(selectedUploadId); }, [uploads, selectedUploadId]);
  // A placeholder nobody can finish or retry from here is deleted and added again (design §4.5).
  const selectedUpload = React.useMemo(() => {
    if (selectedUploadView === undefined) return null;
    const { state, retryable, progress } = selectedUploadView;
    const text = timelineUploadText(t, selectedUploadView, selectedUploadName);
    const readd = state === 'unfinished' || (state === 'failed' && !retryable);
    return { text: readd ? `${text} ${t('timeline.upload.removeAndReadd')}` : text, failed: state === 'failed', progress, onRetry: retryable && !readOnly ? retryUpload : null };
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the text follows the locale, which `t` itself does not.
  [selectedUploadView, selectedUploadName, readOnly, retryUpload, t, locale]);
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
  const pool = React.useMemo(() => allocateWebInstances(heldPool, { document, frame, premountFrames, idleInstancesMax, sourceOf, failedKeys: unloadKeys }),
    [heldPool, document, frame, premountFrames, idleInstancesMax, sourceOf, unloadKeys]);
  // Allocation is idempotent, so holding its result settles in one extra render.
  if (pool !== heldPool) setHeldPool(pool);
  const webEntries = React.useMemo(() => {
    const assigned = new Map(pool.assignments.flatMap((assignment) => assignment.clipId === null ? [] : [[assignment.clipId, assignment] as const]));
    const shown = visible.flatMap((clip, index): TimelineWebEntry[] => {
      // A copy whose reference is not resolved yet has nothing to draw or say until it is.
      if (clip.kind !== 'web-animation' || webClips.get(clip.id)?.state === 'unresolved') return [];
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
  }, [visible, web, webClips, labels, pool, factor, canvas, transformOf]);
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
  // The media lanes: the video or sound clip heard on each track now and every one starting within the premount lead,
  // bottom-up; each has its own element (#1410 design §6.2, inner#1709), read from the address its source holds
  // (inner#2171). Pictures are drawn on the same terms.
  const rank = React.useMemo(() => timelineTrackRank(document.tracks), [document.tracks]);
  const laneClips = React.useMemo(() => {
    const heard = new Set(audible.map((clip) => clip.id));
    return clips.flatMap((clip) => (clip.kind === 'video' || clip.kind === 'audio') && rank.has(clip.trackId)
      && (heard.has(clip.id) || (clip.startFrame > frame && nearFrame(clip, frame, premountFrames))) ? [clip] : [])
      .sort(timelineStackOrder(rank));
  }, [clips, audible, rank, frame, premountFrames]);
  const imageClips = React.useMemo(() => clips.flatMap((clip) => clip.kind === 'image' && rank.has(clip.trackId)
    && (visible.includes(clip) || (clip.startFrame > frame && nearFrame(clip, frame, premountFrames))) ? [clip] : []), [clips, visible, rank, frame, premountFrames]);
  const videoSpecs = laneClips.flatMap((clip) => {
    const source = timelineClipSource(document.sources, clip);
    if (source === undefined || source.kind === 'image') return [];
    return [{ clipId: clip.id, kind: source.kind, fileUrl: source.url, coverUrl: source.kind === 'video' ? source.coverUrl : null }];
  });
  const videoSignature = JSON.stringify(videoSpecs);
  // The layer set keeps its identity while its content is unchanged, so playing on does not resync the elements.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the specs change only when their signature does.
  const videoLayers = React.useMemo(() => videoSpecs, [videoSignature]);
  // Pictures: each reports its decode and decoded size; a retry mounts it again (design §5.1, §6.6).
  const [imageStates, setImageStates] = React.useState(NO_IMAGE_STATES);
  const [imageAttempts, setImageAttempts] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const reportImage = React.useCallback((clipId: string, state: TimelineImageState, size: { width: number; height: number } | null): void => setImageStates((current) => {
    const before = current.get(clipId);
    if (before?.state === state && (size === null || (before.size?.width === size.width && before.size.height === size.height))) return current;
    return new Map(current).set(clipId, { state, size: size ?? before?.size ?? null });
  }), []);
  const imageStateOf = React.useCallback((clip: TimelineClip): TimelineImageState => imageStates.get(clip.id)?.state ?? 'loading', [imageStates]);
  // Each text's rendered size, in display pixels: its layer's base box (design §5.1).
  const [textSizes, setTextSizes] = React.useState<ReadonlyMap<string, { width: number; height: number }>>(() => new Map());
  const reportTextSize = React.useCallback((clipId: string, size: { width: number; height: number }): void => setTextSizes((current) => {
    const before = current.get(clipId);
    return before?.width === size.width && before.height === size.height ? current : new Map(current).set(clipId, size);
  }), []);
  // Texts: the visible ones and those within the premount lead load their font slices (design §5.3).
  const textBodies = React.useMemo(() => new Map(clips.flatMap((clip) => clip.kind === 'text' && rank.has(clip.trackId) && nearFrame(clip, frame, premountFrames) ? [[clip.id, clip.text.body] as const] : [])),
    [clips, rank, frame, premountFrames]);
  const textSignature = JSON.stringify([...textBodies]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the bodies change only when their signature does.
  const stableTextBodies = React.useMemo(() => textBodies, [textSignature]);
  // Undefined while the limits are read.
  const fontBase = limitsQuery.isError ? null : limits?.text.fontBaseUrl;
  const textFonts = useTimelineTextFonts(fontBase, stableTextBodies);
  const retryFonts = React.useCallback((): void => { if (typeof fontBase === 'string') retryTimelineFonts(fontBase); else void limitsQuery.refetch(); }, [fontBase, limitsQuery]);
  // A visible picture still decoding, or a visible text whose slices are loading, holds play (design §5.4).
  const stillPending = visible.some((clip) => (clip.kind === 'image' && imageStateOf(clip) === 'loading') || (clip.kind === 'text' && (textFonts.get(clip.id) ?? 'loading') === 'loading'));
  const preview = useTimelinePreviewLimits(projectId);
  const playback = useTimelinePlayback({
    document, frame, onFrame: setFrame, videoLayers, enabled: true, preview,
    webLayers, webPending, stillPending, webLoadTimeoutMs: webLimits?.playerLoadTimeoutMs,
  });
  const { seek, retryVideo, retryWeb, videoElement, videoStates } = playback;
  // Clips whose element or picture failed, so their file reads as unreadable on the track and in the properties.
  const failedIds = React.useMemo(() => new Set([
    ...[...videoStates].flatMap(([clipId, state]) => state === 'failed' ? [clipId] : []),
    ...[...imageStates].flatMap(([clipId, { state }]) => state === 'failed' ? [clipId] : []),
  ]), [videoStates, imageStates]);
  /**
   * A layer's base box in canvas pixels: its registered size contained in the canvas (#1410 design §2).
   * @param clip - The layer's clip.
   * @returns The box, or null for a clip that draws no layer.
   * @throws {never} Never.
   */
  const baseOf = React.useCallback((clip: TimelineClip): TimelineLayerBox | null => {
    if (clip.kind === 'video') {
      const source = document.sources[clip.sourceId];
      return timelineLayerBase(canvas, { width: source?.width ?? null, height: source?.height ?? null });
    }
    if (clip.kind === 'image') {
      // The registered size, else the decoded one (design §2.2); unknown until one of them is.
      const source = timelineClipSource(document.sources, clip);
      const size = source?.kind === 'image' && source.width !== null && source.height !== null ? source : imageStates.get(clip.id)?.size ?? null;
      return size === null ? null : timelineLayerBase(canvas, size);
    }
    if (clip.kind === 'text') {
      const size = textSizes.get(clip.id);
      if (size === undefined || factor <= 0 || size.width <= 0 || size.height <= 0) return null;
      const width = size.width / factor;
      const height = size.height / factor;
      return { left: (canvas.width - width) / 2, top: (canvas.height - height) / 2, width, height };
    }
    if (clip.kind === 'web-animation') {
      const sourceId = sourceOf(clip);
      const viewport = sourceId === null ? undefined : web.sources[sourceId]?.viewport;
      return viewport === undefined ? null : timelineLayerBase(canvas, viewport);
    }
    return null;
  }, [canvas, sourceOf, web.sources, document.sources, imageStates, textSizes, factor]);
  // The layers a click can pick and a selection can handle: visible ready videos and web copies with a source (#1410
  // design §4.2). A video's element error arrives through `videoStates`.
  const pickable = React.useMemo(() => visible.flatMap((clip) => {
    const unready = (clip.kind === 'video' && videoStates.get(clip.id) === 'failed') || (clip.kind === 'image' && imageStateOf(clip) === 'failed');
    const base = unready ? null : baseOf(clip);
    return base === null ? [] : [{ clip, base }];
  }), [visible, baseOf, videoStates, imageStateOf]);
  // Each video element sits in the frame on its base box with its transform, stacked by track; a premounted one waits
  // there hidden.
  const videoHost = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const host = videoHost.current;
    if (host === null) return;
    for (const clip of laneClips) {
      if (clip.kind !== 'video') continue;
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
  // Every seek the user makes goes through these two (ruler, arrow keys, locating a clip, the seek slider); a follow
  // that moves the playhead calls playback.seek itself.
  const onSeek = React.useCallback((value: number[]): void => { stopFollowing(); seek(value[0] ?? 0); }, [seek]);
  const seekTo = React.useCallback((target: number): void => {
    stopFollowing();
    seek(Math.max(0, Math.min(target, Math.max(0, duration - 1))));
  }, [seek, duration]);
  const { toggle } = playback;
  const togglePlay = React.useCallback((): void => { stopFollowing(); toggle(); }, [toggle]);
  const selectClip = React.useCallback((clipId: string | null): void => session.select(clipId), [session]);
  const [trackScroller, setTrackScroller] = React.useState<HTMLDivElement | null>(null);
  // A scroll the user makes stops following; the clamp after the tracks got shorter does not (#920).
  React.useEffect(() => {
    if (trackScroller === null) return undefined;
    let accepted: TrackScroll = { left: trackScroller.scrollLeft, top: trackScroller.scrollTop };
    /**
     * Judge one scroll of the track viewport against the last accepted position.
     * @throws {never} Never.
     */
    const onScroll = (): void => {
      const next = { left: trackScroller.scrollLeft, top: trackScroller.scrollTop };
      const max = { left: trackScroller.scrollWidth - trackScroller.clientWidth, top: trackScroller.scrollHeight - trackScroller.clientHeight };
      if (userMovedScroll(accepted, next, max)) stopFollowing();
      accepted = next;
    };
    trackScroller.addEventListener('scroll', onScroll, { passive: true });
    return () => trackScroller.removeEventListener('scroll', onScroll);
  }, [trackScroller]);

  const commit = React.useCallback((command: TimelineEditCommand, options?: TimelineEditOptions): TimelineEditPlan | null => {
    if (readOnly) return null;
    const plan = editWithNotice(command, options);
    // A size refusal was told by its own toast; a refusal names the kind of the clip it is about.
    const clipId = 'clipId' in command.parameters ? command.parameters.clipId : undefined;
    const subject = clipId === undefined ? undefined : document.clips[clipId];
    if (!plan.ok && !isTimelineSizeRefusal(plan)) toast.warning(t(`timeline.errors.${plan.reason}`, { kind: subject === undefined ? 'other' : timelineClipKind(subject) }));
    return plan;
  }, [readOnly, editWithNotice, t, document.clips]);
  const commitCommand = React.useCallback((command: TimelineEditCommand): void => { commit(command); }, [commit]);
  const vanished = React.useCallback((): void => { toast.warning(t('timeline.errors.clip_removed')); }, [t]);

  // Web animation (#1490 design §8): copies of the Project's results are placed here; they are made in Motion Spaces.
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const spaces = useProjectSpaceList(projectId);
  const hasMotionSpace = React.useMemo(() => spaces.some((space) => space.type === 'web_animation'), [spaces]);
  const openPicker = React.useCallback((): void => setPickerOpen(true), []);
  const closePicker = React.useCallback((): void => setPickerOpen(false), []);
  // Each pick places a copy of its own, bound to the result's source.
  const placeResult = React.useCallback((row: PlayableRow): void => {
    const { input } = row;
    const parameters = { from: { sourceVersionId: row.resultSourceVersionId }, extent: { durationFrames: webAnimationDurationFrames(input), fps: input.fps } };
    if (commit({ operation: 'add_web_animation', parameters: { clipId: newId(), startFrame: frame, newTrackId: newId(), ...parameters }, placement })?.ok === true) setPickerOpen(false);
  }, [commit, frame, placement]);
  // The picker stays open, its button waiting, while a Motion Space is being made for it.
  const requestStatus = useSpaceOpenRequestStore((state) => state.state.status);
  const [goMakeAsked, setGoMakeAsked] = React.useState(false);
  const stopWatchingGoMake = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stopWatchingGoMake.current?.(), []);
  const goMake = React.useCallback((): void => {
    stopWatchingGoMake.current?.();
    setGoMakeAsked(true);
    // Every transition is watched: the Motion Space it opens says it handled the request at once, so a render may never see `opened`.
    stopWatchingGoMake.current = useSpaceOpenRequestStore.subscribe(({ state }) => {
      if (state.status === 'requesting' || state.status === 'creating') return;
      stopWatchingGoMake.current?.();
      stopWatchingGoMake.current = null;
      setGoMakeAsked(false);
      if (state.status === 'opened') setPickerOpen(false);
    });
    useSpaceOpenRequestStore.getState().dispatch({ type: 'request', request: { type: 'web_animation' } });
  }, []);
  const selectedWeb = selected?.kind === 'web-animation' ? webClips.get(selected.id) : undefined;
  // A Viewer can open a Motion Space but cannot make one.
  const canOpenInMotion = !readOnly || hasMotionSpace;
  const selectedOrigin = selectedWeb?.originExecutionId ?? null;
  /**
   * Open the newest Motion Space with the selected copy's execution selected. Only a copy placed before Motion can fail,
   * so its execution was made in a Timeline and sits in that Space's group of those.
   * @throws {never} Never.
   */
  const openSelectedInMotion = React.useCallback((): void => {
    if (selectedOrigin === null) return;
    useSpaceOpenRequestStore.getState().dispatch({ type: 'request', request: { type: 'web_animation', select: selectedOrigin } });
  }, [selectedOrigin]);
  const selectedWebCopy = React.useMemo(() => selectedWeb === undefined ? null : {
    request: selectedWeb.request,
    baseRequest: selectedWeb.baseRequest,
    failure: selectedWeb.state === 'failed' && selectedWeb.status !== null ? t(endedSentenceKey(selectedWeb.status, selectedWeb.failureReason)) : null,
    onOpenInMotion: selectedWeb.state === 'failed' && selectedOrigin !== null && canOpenInMotion ? openSelectedInMotion : null,
    opening: requestStatus === 'creating',
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the text follows the locale, which `t` itself does not.
  }, [selectedWeb, selectedOrigin, canOpenInMotion, openSelectedInMotion, requestStatus, t, locale]);

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
  const changeZoom = React.useCallback((value: number[]): void => {
    stopFollowing();
    setZoom(2 ** (value[0] ?? Math.log2(DEFAULT_PIXELS_PER_FRAME)));
  }, []);
  const awareness = useDocProvider(name)?.awareness ?? null;
  // Effects run only while the Space body is shown, so the view is out only then.
  usePublishTimelineView({ awareness, viewport: trackScroller, pixelsPerFrame, headerPx: TIMELINE_TRACK_HEADER_PX,
    frame, intent: playback.intent, anchor: playback.anchor });

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
  // The preview notes of drawn and heard layers that cannot be read, and of texts whose fonts failed (design §6.6),
  // each by its track.
  const mediaNotes = [...visible, ...audible.filter((clip) => clip.kind === 'audio')].flatMap((clip, index) => {
    const track = labels.nameOf(clip.trackId) ?? clip.trackId;
    if (clip.kind === 'text') return textFonts.get(clip.id) === 'failed' ? [{ clipId: clip.id, z: index + 1, text: t('timeline.preview.fontFailed', { track }), retry: true }] : [];
    if (clip.kind !== 'video' && clip.kind !== 'audio' && clip.kind !== 'image') return [];
    const failed = (clip.kind === 'image' ? imageStateOf(clip) : videoStates.get(clip.id)) === 'failed';
    if (!failed) return [];
    const text = t('timeline.media.readFailed', { kind: timelineClipKind(clip) });
    return [{ clipId: clip.id, z: index + 1, text: t('timeline.preview.media', { track, text }), retry: true }];
  });
  const retryLayer = React.useCallback((clipId: string): void => {
    const clip = document.clips[clipId];
    if (clip === undefined) return;
    if (clip.kind === 'text') { retryFonts(); return; }
    // The layer's element loads its stored address again, as a canvas node's retry does (inner#2171 design §6.1).
    if (clip.kind === 'image') setImageAttempts((current) => new Map(current).set(clipId, (current.get(clipId) ?? 0) + 1));
    else retryVideo(clipId);
  }, [document.clips, retryVideo, retryFonts]);

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
  // Add text (design §6.3): a default text at the playhead for the configured length and size, selected, its body
  // focused for typing.
  const [focusTextId, setFocusTextId] = React.useState<string | null>(null);
  const addText = React.useCallback(async (): Promise<void> => {
    if (readOnly) return;
    const at = frame;
    let media: NonNullable<typeof limits>['media'];
    try {
      media = (await queryClient.fetchQuery({ queryKey: ['timeline-limits', projectId], queryFn: ({ signal }) => timelineApi.limits(projectId, signal), staleTime: Infinity })).media;
    } catch {
      toast.error(t('timeline.unavailable'));
      return;
    }
    const clipId = newId();
    const plan = commit({ operation: 'add_text', parameters: {
      clipId, startFrame: at, newTrackId: newId(), text: { body: t('timeline.text.default'), size: media.textSize },
      durationFrames: durationToFrames(media.textDurationSeconds, document.settings.fps),
    }, placement });
    if (plan?.ok !== true) return;
    setFocusTextId(clipId);
    session.select(clipId);
  }, [readOnly, frame, queryClient, projectId, commit, t, document.settings.fps, placement, session]);
  const pressAddText = React.useCallback((): void => { void addText(); }, [addText]);
  const noSelection = selected === undefined;
  const toolbarEntries = React.useMemo((): TimelineToolbarEntry[] => {
    const zoomLabel = t('timeline.edit.zoom');
    const zoom = <Slider data-testid='timeline-zoom' aria-label={zoomLabel} value={zoomValue} onValueChange={changeZoom} min={Math.log2(minZoom)} max={Math.log2(TIMELINE_MAX_PIXELS_PER_FRAME)} step={ZOOM_STEP} className='w-28' />;
    return [
      toolbarButton({ testId: 'timeline-add-media', group: 'add', label: t('timeline.addMedia'), icon: ADD_MEDIA_ICON, disabled: readOnly, onClick: openMaterial }),
      ...(readOnly ? [] : [
        toolbarButton({ testId: 'timeline-add-web-animation', group: 'add', label: t('timeline.webAnimation.add'), icon: ADD_WEB_ICON, onClick: openPicker }),
        toolbarButton({ testId: 'timeline-add-text', group: 'add', label: t('timeline.edit.addText'), icon: ADD_TEXT_ICON, onClick: pressAddText }),
      ]),
      toolbarButton({ testId: 'timeline-undo', group: 'history', label: t('timeline.edit.undo'), shortcut: UNDO_KEY, icon: UNDO_ICON, disabled: readOnly || !history.canUndo, onClick: undo }),
      toolbarButton({ testId: 'timeline-redo', group: 'history', label: t('timeline.edit.redo'), shortcut: REDO_KEY, icon: REDO_ICON, disabled: readOnly || !history.canRedo, onClick: redo }),
      toolbarButton({ testId: 'timeline-split', group: 'clip', label: t('timeline.edit.split'), shortcut: SPLIT_KEY, icon: SPLIT_ICON, disabled: readOnly, unavailable: noSelection, onClick: split }),
      toolbarButton({ testId: 'timeline-duplicate', group: 'clip', label: t('timeline.edit.duplicate'), shortcut: DUPLICATE_KEY, icon: DUPLICATE_ICON, disabled: readOnly, unavailable: noSelection, onClick: duplicate }),
      toolbarButton({ testId: 'timeline-delete', group: 'clip', label: t('timeline.edit.delete'), shortcut: DELETE_KEY, icon: DELETE_ICON, disabled: readOnly, unavailable: noSelection, onClick: remove }),
      toolbarButton({ testId: 'timeline-toggle-magnet', group: 'switch', label: t('timeline.edit.magnet'), pressed: prefs.magnet, icon: MAGNET_ICON, onClick: toggleMagnet }),
      toolbarButton({ testId: 'timeline-toggle-snap', group: 'switch', label: t('timeline.edit.snap'), shortcut: 'N', pressed: prefs.snap, icon: SNAP_ICON, onClick: toggleSnap }),
      toolbarButton({ testId: 'timeline-toggle-linkage', group: 'switch', label: t('timeline.edit.linkage'), pressed: prefs.linkage, icon: LINKAGE_ICON, onClick: toggleLinkage }),
      {
        id: 'timeline-zoom',
        group: 'zoom',
        bar: <Tooltip><TooltipTrigger asChild><span className='flex items-center'>{zoom}</span></TooltipTrigger><TooltipContent>{zoomLabel}</TooltipContent></Tooltip>,
        row: <div className='flex items-center gap-2 py-1.5 pl-8 pr-2 text-sm'><span className='whitespace-nowrap'>{zoomLabel}</span>{zoom}</div>,
      },
    ];
  }, [t, readOnly, openMaterial, openPicker, pressAddText, history.canUndo, history.canRedo, undo, redo, noSelection, split, duplicate, remove,
    prefs.magnet, prefs.snap, prefs.linkage, toggleMagnet, toggleSnap, toggleLinkage, zoomValue, changeZoom, minZoom]);
  // Click-focusable, not tab-reachable: where the keyboard goes when the focused element leaves the page.
  return <div ref={root} data-testid='timeline-space' data-project-id={projectId} data-space-id={spaceId} tabIndex={-1} data-space-focus-root='' className='flex h-full min-h-0 min-w-0 bg-background outline-none'>
    {/* The tracks take their content's height up to half the column; the preview takes the rest. */}
    <div ref={editorColumn} className='grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto_auto_fit-content(50%)]'>
      <div className='flex min-h-0 flex-1 items-center justify-center bg-muted/40 p-6'>
        {/* The frame clips the layers; the operation layer above it does not, so handles outside the frame stay reachable;
            the note layer is on top and lets clicks through except on its notes (#1410 design §4.1). */}
        <div ref={setPreviewArea} data-testid='timeline-preview-area' className='flex h-full w-full items-center justify-center'>
          <div className='relative shrink-0' style={previewStyle}>
            <div data-testid='timeline-preview' className='absolute inset-0 isolate flex items-center justify-center overflow-hidden rounded-content-sm border border-border bg-black'>
              <div ref={videoHost} className='pointer-events-none absolute inset-0' />
              {imageClips.map((clip) => {
                const source = timelineClipSource(document.sources, clip);
                if (source?.kind !== 'image') return null;
                const index = visible.indexOf(clip);
                const base = baseOf(clip);
                return <TimelineImageLayer key={`${clip.id}:${imageAttempts.get(clip.id) ?? 0}`} clipId={clip.id} src={source.url} z={index + 1} shown={index >= 0} onState={reportImage}
                  box={base === null ? null : timelineLayerStyle(canvas, base, transformOf(clip), factor)} />;
              })}
              {visible.map((clip, index) => clip.kind === 'text' && <TimelineTextLayer key={clip.id} clipId={clip.id} body={clip.text.body} fontSize={clip.text.size * fit.height}
                maxWidth={fit.width} canvas={canvas} transform={transformOf(clip)} factor={factor} z={index + 1} onSize={reportTextSize} />)}
              <TimelineWebPreview projectId={projectId} entries={webEntries} states={playback.webStates} sharing={sharing} onPlayer={registerPlayer} onRetry={retryWeb} onUnavailable={reportUnavailable} uploadNotes={uploadNotes} notes={notesLayer} />
              {clips.length === 0 && <div data-testid='timeline-space-empty' className='flex flex-col items-center gap-3 p-6 text-center text-sm text-white/60'><Film className='size-8' /><p>{t('timeline.empty')}</p></div>}
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
                {mediaNotes.map((note) => <PreviewNote key={note.clipId} clipId={note.clipId} z={note.z} text={note.text}>
                  {note.retry && <Button data-testid={`timeline-video-retry-${note.clipId}`} variant='outline' size='compact' onClick={() => retryLayer(note.clipId)}>{t('timeline.retry')}</Button>}
                </PreviewNote>)}
              </div>
            </div>
          </div>
        </div>
      </div>
      <TimelineTransport state={playback.state} playing={playback.intent === 'play'} waiting={playback.state === 'waiting'} frame={frame} duration={duration} fps={fps}
        seekValue={seekValue} onSeek={onSeek} onToggle={togglePlay} width={canvas.width} height={canvas.height} readOnly={readOnly} onChoose={chooseFrame} />
      <TimelineToolbar label={t('timeline.tracks')} moreLabel={t('timeline.edit.more')} entries={toolbarEntries} />
      <TimelineTrackArea document={document} labels={labels} failedIds={failedIds} selectedId={selectedId} frame={frame} extent={extent} viewportRef={setTrackScroller}
        pixelsPerFrame={pixelsPerFrame} readOnly={readOnly} snap={prefs.snap} placement={placement} web={web} webClips={webClips} uploads={uploadViews} onSelect={selectClip} onSeek={seekTo} onCommit={commitCommand} onVanished={vanished} onDraggingChange={draggingChange} />
    </div>
    <aside data-testid='timeline-side-panel' className='flex w-72 shrink-0 flex-col border-l border-border'>
      <ScrollArea className='min-h-0 flex-1' viewportClassName='p-3'>
        <div className='flex flex-col gap-3'>
          <section className={PANEL}>
            {selected === undefined ? <p className='text-muted-foreground'>{t('timeline.selectClip')}</p>
              : <TimelineSelectedProperties key={selected.id} spaceId={spaceId} document={document} web={web} clip={selected} atFrame={selectedAtFrame}
                labels={labels} readOnly={readOnly} placement={placement} onCommit={commitCommand} focusBody={focusTextId === selected.id}
                elementFailed={failedIds.has(selected.id)} onRetry={retryLayer} webCopy={selectedWebCopy} upload={selectedUpload} />}
          </section>
        </div>
      </ScrollArea>
    </aside>
    {materialState.open && materialOpen && <TimelineMaterialDialog key={`${projectId}:${spaceId}`} projectId={projectId} spaceId={spaceId} draft={material} canWrite={!readOnly} document={document} placement={placement} onClose={closeMaterial} />}
    {pickerOpen && <TimelineWebAnimationPicker projectId={projectId} making={goMakeAsked && requestStatus === 'creating'} onPick={placeResult} onGoMake={goMake} onClose={closePicker} />}
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
  return <TimelineEditor {...props} doc={doc} stored={state.document} />;
}
