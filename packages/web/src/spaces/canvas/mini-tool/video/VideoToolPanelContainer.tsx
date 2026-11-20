// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { createPortal } from 'react-dom';
import { VideoToolNodeOverlay } from '@web/spaces/canvas/mini-tool/video/VideoToolNodeOverlay';
import type { PresentedMediaFrame, MediaSurfaceBinding, VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import { deriveVideoToolPanelState, worstVideoToolPanelState, type VideoToolPanelState } from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import { useStore } from '@xyflow/react';
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CANVAS_NODES_KEY, newId, type VideoPresentationSourceBinding } from '@breatic/shared';
import { anchorInTrackingRange, canonicalMiniToolValue, eraseRangeCheck, fingerprintMiniToolAnalysisInput, videoExpandLayout, lipsyncTimeline, lipsyncUsedSourceRange, miniToolChargeTo, planVideoSplit, timelineClipLacksOutputFrame, fitTransitions, type LipsyncFailureReason, projectMiniToolAnalysisInput, videoToolAnalysisRefs, videoToolSourceRefSchema, selectMiniToolAnalyses, type MiniToolAnalysisKind, type MiniToolAnalysisRecord, type MiniToolAnalysisRequest, type MiniToolPresentationRef, type MiniToolSlotValue, type TrackingAnchor, type TrackingTimeRange, type VideoPlanGrid, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { miniToolAnalysesApi, miniToolAnalysisQuery, latestMiniToolAnalysis } from '@web/data/api/mini-tool-analyses';
import { docName, getDoc } from '@web/data/yjs/manager';
import { nodeDataMap, readEdges, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoSceneAnalysis, commitVideoToolAnalysisRef, commitVideoToolDraft, clearVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { useVideoToolDraft } from '@web/data/yjs/use-video-tool-draft';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useMiniToolRunning } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { MiniToolPanel } from '@web/spaces/canvas/mini-tool/MiniToolPanel';
import { NodePanelMount } from '@web/spaces/canvas/_shared/NodePanelMount';
import { useCanvasContext, useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { expandDrop, isExpanded, type PixelSize } from '@web/spaces/canvas/mini-tool/expand-frame';
import { createVideoToolDraft, currentPeopleResult, eraseTrackingStatus, overPeopleLimit, resetDialoguePeople, transitionHostInputId } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import { splitCuts, VideoToolControls, type LipSyncChoices } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import type { VideoTimelineDecoderRenderer } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';
import { VideoTimelineDialog } from '@web/spaces/canvas/mini-tool/video/VideoTimelineDialog';
import { VideoResultPreviewDialog } from '@web/spaces/canvas/mini-tool/video/VideoResultPreviewDialog';
import type { VideoTimelineFormat } from '@web/spaces/canvas/mini-tool/video/VideoTimelinePreview';
import { useVideoToolModels } from '@web/spaces/canvas/mini-tool/video/use-video-tool-models';
import type { CanvasEraseLimits, CanvasExpandLimits } from '@web/data/api/canvas';
import { useTrackedBox } from '@web/spaces/canvas/mini-tool/video/use-tracked-box';
import { usePlannedVideoQuote } from '@web/spaces/canvas/mini-tool/video/use-planned-video-quote';
import { useTrackingCost } from '@web/spaces/canvas/mini-tool/video/use-tracking-cost';
import type { PlannedVideoFacts, PlannedVideoPress } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { useVideoPresentationRepair } from '@web/spaces/canvas/video-presentation/video-presentation-recovery';
import { frameIndexOfMediaTime, gridDuration, gridFrameAt, gridSeconds } from '@web/spaces/canvas/video-presentation/frame-grid-time';
import type { SourceRangePlayback } from '@web/spaces/canvas/video-presentation/play-source-range';
import { useEscapeInSpace } from '@web/spaces/canvas/use-escape-in-space';
import { useConnectionLost } from '@web/data/yjs/space-connection';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';
import { miniToolById } from '@breatic/shared/mini-tools';


/**
 * Combines cache results without copying unchanged records on every render.
 * @param queries - Authorized analysis cache entries.
 * @returns All available validated analysis records.
 * @throws {never} Never.
 */
function analysisRecords(queries: readonly UseQueryResult<MiniToolAnalysisRecord>[]): { records: MiniToolAnalysisRecord[]; pending: boolean; failed: boolean; fetching: boolean } {
  return { records: queries.flatMap((query) => query.data === undefined ? [] : [query.data]), pending: queries.some((query) => query.isPending), failed: queries.some((query) => query.isError), fetching: queries.some((query) => query.isFetching) };
}

/** Authoritative presentation facts supplied by the video node owner. */
export interface VideoToolPresentation {
  panelState?: VideoToolPanelState;
  /** The target candidate's failure code while nothing is selected, which names why the panel cannot be used (§7.12 step 2). */
  failure?: string | null;
  /** The selected version's tool input, named by every analysis and run of this source (§7.11, §10.8). */
  presentationRef?: MiniToolAnalysisRequest['presentationRef'];
  retrying?: boolean;
  onRetry?: () => void;
  previewSource?: VideoPresentationSource | null;
  /** The selected version's grid (P.display fps and frame count) while the panel is usable, otherwise null (§7.12). */
  grid: VideoPlanGrid | null;
  presentedTime: number | null;
  /** Reads the owner's current frame at a press, independently of React preview cadence. */
  getPresentedFrame?: () => PresentedMediaFrame | null;
  status: 'loading' | 'ready' | 'failed';
  sourceURL: string;
  sourceEpoch: number;
  seekEpoch: number;
  onSeek?: (time: number) => void;
  /** Plays exactly one source range in the node's player (canvas design §4 split row preview). */
  onPlayRange?: (start: number, end: number) => SourceRangePlayback;
  /** Whether the selected version presents with transparency, which erase and expand do not take (execution design §10.4). */
  transparent?: boolean;
  /** The selected version's display size, the sample aspect ratio applied, and its duration in seconds, which admission lays out and limits an expansion by (§10.5). */
  display?: { width: number; height: number; duration: number };
}

/**
 * Reads only an actual frame from this source and seek lifetime.
 * @param presentation - Facts published by the current node owner.
 * @returns Actual presented media time, or explicit unknown.
 * @throws {never} Never.
 */
function presentedTimeOf(presentation: VideoToolPresentation | undefined): number | null {
  if (!presentation) return null;
  if (presentation.getPresentedFrame) {
    const frame = presentation.getPresentedFrame();
    return frame && frame.sourceEpoch === presentation.sourceEpoch && frame.seekEpoch === presentation.seekEpoch ? frame.mediaTime : null;
  }
  return presentation.presentedTime !== null && Number.isFinite(presentation.presentedTime) ? presentation.presentedTime : null;
}

/** The panel's cost texts: the run's estimate, an analysis's estimate and what a finished analysis actually used. */
export interface VideoToolCostText { execution: string; analysis?: string; analysisActual?: string }

export interface VideoToolPanelContainerProps {
  /** Actual canonical display box supplied by the node's presentation owner. */
  overlayTarget?: HTMLElement | null;
  /** Registry identity and nullable metadata from the authorized source query. */
  sourceBinding?: VideoPresentationSourceBinding;
  /** Actual transport identity and frame-clock epoch for overlay invalidation. */
  binding?: MediaSurfaceBinding | null;
  costs?: VideoToolCostText;
  renderTimelineDecoder?: VideoTimelineDecoderRenderer;
  nodeId: string;
  toolId: VideoToolId;
  node: CanvasNodeView;
  nodes: readonly CanvasNodeView[];
  presentation?: VideoToolPresentation;
  onRunVideo?: (nodeId: string, toolId: VideoToolId, draft: VideoToolDraft, analyses: readonly MiniToolAnalysisRecord[], plan?: PlannedVideoPress) => Promise<unknown>;
  /** The lip-sync models to choose from and the tracking range (config `executions.video.lip-sync`). */
  lipSync?: LipSyncChoices;
  /** Why this node's last lip-sync run failed. */
  lipSyncFailure?: LipsyncFailureReason | null;
  /** Retries that run's failed items. */
  onRetryFailed?: () => void;
  /** The erase model input's limits (config `executions."video.erase".model`). */
  erase?: CanvasEraseLimits;
  /** The expand limits (config `executions."video.expand"`). */
  expand?: CanvasExpandLimits;
  /** The most outputs one run of this tool creates (config `executions[tool].max_outputs`). */
  maxOutputs?: number;
}

/**
 * Why an erase selection cannot be tracked or erased now (execution design §10.2, §10.4), by the check admission runs
 * (`eraseRangeCheck`): a transparent source, an anchor outside the range, or a model input outside the eraser's seconds on
 * its grid.
 * @param range - The selected range.
 * @param anchor - The anchor the press is judged with.
 * @param grid - The selected version's grid, null while unknown.
 * @param erase - The erase limits, absent while unknown.
 * @param transparent - Whether the source is transparent.
 * @param t - The translator.
 * @returns The reason, or undefined.
 * @throws {never} Never.
 */
function eraseBlock(range: TrackingTimeRange, anchor: TrackingAnchor, grid: VideoPlanGrid | null, erase: CanvasEraseLimits | undefined, transparent: boolean,
  t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  if (transparent) return t('canvas.miniTool.videoUI.transparentSource');
  const refusal = grid === null || erase === undefined ? (anchorInTrackingRange(range, anchor) ? null : 'anchor') : eraseRangeCheck(grid, range, anchor, erase).refusal;
  if (refusal === 'anchor') return t('canvas.miniTool.videoUI.anchorOutsideRange');
  return refusal === 'range' ? t('canvas.miniTool.videoUI.eraseRange', { min: erase?.minSeconds ?? 0, max: erase?.maxSeconds ?? 0 }) : undefined;
}

/**
 * Why an expand cannot run now (execution design §10.5), as admission judges it: a transparent source, a source longer than
 * the limit, or a target whose long side passes it.
 * @param draft - The expand draft.
 * @param size - The source's display size.
 * @param duration - The presented duration in seconds, the stored one while the presentation is unknown.
 * @param expand - The expand limits, absent while unknown.
 * @param transparent - Whether the source is transparent.
 * @param t - The translator.
 * @returns The reason, or undefined.
 * @throws {never} Never.
 */
function expandBlock(draft: VideoToolDraftById['video.expand'], size: PixelSize, duration: number, expand: CanvasExpandLimits | undefined, transparent: boolean,
  t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  if (transparent) return t('canvas.miniTool.videoUI.transparentSource');
  if (expand === undefined) return undefined;
  if (duration > expand.maxDurationSeconds) return t('canvas.miniTool.videoUI.expandTooLong', { max: expand.maxDurationSeconds });
  return videoExpandLayout(draft.params.frame, size, expand.maxTargetSide).overSide ? t('canvas.miniTool.videoUI.expandTooLarge', { max: expand.maxTargetSide }) : undefined;
}

/**
 * Why a transitions timeline cannot export (frames-split §7.17): a trimmed clip snaps to no frame of the output grid, which
 * is the first clip's, as admission plans it.
 * @param draft - The transitions draft.
 * @param inputGrids - The picked inputs' grids.
 * @param hostInputId - The current video's input id.
 * @param hostGrid - The current video's grid.
 * @param t - The translator.
 * @returns The message, or undefined when every clip has a frame or the grid is not known yet.
 * @throws {never} Never.
 */
function transitionClipBlock(draft: VideoToolDraftById['video.transitions'], inputGrids: ReadonlyMap<string, VideoPlanGrid>, hostInputId: string | undefined,
  hostGrid: VideoPlanGrid | null, t: (key: string) => string): string | undefined {
  const [first] = draft.params.clips;
  const grid = first === undefined ? undefined : inputGrids.get(first.inputId) ?? (first.inputId === hostInputId ? hostGrid ?? undefined : undefined);
  if (grid === undefined) return undefined;
  const fps = grid.fps;
  return draft.params.clips.some((clip) => timelineClipLacksOutputFrame(clip, fps)) ? t('canvas.miniTool.videoUI.timelineClipTooShort') : undefined;
}

/**
 * Why a complete lip-sync draft cannot run with the chosen model (canvas design §4 lip-sync row, execution design §9.3): the
 * chosen model is no longer configured, its result lasts outside the model's range, or the source range it uses lies outside
 * the tracking model's, as admission judges.
 * @param draft - The draft, every row bound.
 * @param grid - The selected version's grid.
 * @param lipSync - The configured models and tracking range.
 * @param t - The translator.
 * @returns The message naming the range, or undefined when the run fits or cannot be measured yet.
 * @throws {never} Never.
 */
function lipSyncRangeBlock(draft: VideoToolDraftById['video.lip-sync'], grid: VideoPlanGrid, lipSync: LipSyncChoices, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  const model = lipSync.models.find((entry) => entry.name === (draft.params.modelId ?? lipSync.models[0]?.name));
  // A model the list dropped asks for another, as the generate panel does.
  if (model === undefined) return draft.params.modelId === undefined ? undefined : t('canvas.generatePanel.modelUnavailable');
  const dialogues = draft.params.dialogues.flatMap((row) => {
    const duration = draft.inputs.find((input) => input.inputId === row.audioInputId)?.mediaInfo?.duration;
    return row.personId === null || row.audioInputId === null || duration === undefined ? [] : [{ dialogueId: row.dialogueId, personId: row.personId, audioInputId: row.audioInputId, startTime: row.startTime, duration }];
  });
  if (dialogues.length !== draft.params.dialogues.length) return undefined;
  let timeline: ReturnType<typeof lipsyncTimeline>;
  let windowEnd: number;
  try {
    timeline = lipsyncTimeline({ videoDuration: gridDuration(grid), dialogues, syncMode: draft.params.syncMode });
    windowEnd = gridFrameAt(grid, draft.params.anchor.frameIndex).displayEnd;
  } catch {
    // An unmeasurable draft is refused by admission with its own reason.
    return undefined;
  }
  if (timeline.duration < model.minDurationSeconds || timeline.duration > model.maxDurationSeconds) {
    return t('canvas.miniTool.videoUI.lipSyncDurationRange', { min: model.minDurationSeconds, max: model.maxDurationSeconds, duration: timeline.duration });
  }
  const used = lipsyncUsedSourceRange(timeline, [{ time: gridSeconds(grid, draft.params.anchor.frameIndex), windowEnd }]);
  const length = used.end - used.start;
  if (length < lipSync.tracking.minDurationSeconds || length > lipSync.tracking.maxDurationSeconds) {
    return t('canvas.miniTool.videoUI.lipSyncTrackingRange', { min: lipSync.tracking.minDurationSeconds, max: lipSync.tracking.maxDurationSeconds, length });
  }
  return undefined;
}

const NO_INPUTS: readonly VideoToolDraft['inputs'][number][] = [];

type ToolInputRef = MiniToolPresentationRef['source'];

/**
 * Each transition input's selected version (§97 D10-3, D11-3, D13-1): every clip reads its frame rate off the grid of the
 * version its own source presents, and the request names that version as the clip input's ref. Each input's panel state is
 * derived from the same reads (frames-split §7.12 last paragraph); no surface shows a picked input, so the version it would
 * show is the selected one.
 * @param projectId - The Project.
 * @param inputs - The transitions draft's inputs, or none for another tool.
 * @param repairing - The input URLs whose Retry is still waiting.
 * @returns The grids, refs, panel states and display formats read so far, by input id.
 * @throws {never} Never.
 */
function useInputPresentations(projectId: string, inputs: readonly VideoToolDraft['inputs'][number][], repairing: ReadonlySet<string>): { grids: ReadonlyMap<string, VideoPlanGrid>; refs: ReadonlyMap<string, ToolInputRef>; states: ReadonlyMap<string, VideoToolPanelState>; formats: ReadonlyMap<string, VideoTimelineFormat> } {
  const urls = React.useMemo(() => [...new Set(inputs.map((input) => input.url))], [inputs]);
  const responses = useQueries({ queries: urls.map((url) => videoPresentationQuery({ projectId, canonicalURL: url, active: true })), combine: readsOf });
  return React.useMemo(() => {
    const read = urls.flatMap((url, at) => { const response = responses[at]?.data; return response === undefined ? [] : [{ url, response }]; });
    const gridByURL = new Map(read.flatMap(({ url, response }) => (response.presentation === null ? [] : [[url, { fps: response.presentation.display.fps, frameCount: response.presentation.display.frameCount }] as const])));
    const refByURL = new Map(read.flatMap(({ url, response }) => (response.presentation === null ? [] : [[url, { toolInputId: response.presentation.toolInputId, planSha256: response.presentation.planSha256 }] as const])));
    // The selected version's display size and transparency, which the timeline composition takes from the first clip (canvas design §4 transitions row).
    const formatByURL = new Map(read.flatMap(({ url, response }) => (response.presentation === null ? [] : [[url, { width: response.presentation.display.width, height: response.presentation.display.height, transparent: response.presentation.playback.kind === 'alpha-packed' }] as const])));
    const stateByURL = new Map(urls.map((url, at) => {
      const response = responses[at]?.data;
      return [url, deriveVideoToolPanelState({ sourceURL: url, presentationStatus: response !== undefined ? 'ready' : responses[at]?.status === 'error' ? 'failed' : 'loading', response,
        resourceVersionId: response?.presentation?.versionId ?? null, toolInputId: response?.presentation?.toolInputId ?? null, retrying: repairing.has(url) })] as const;
    }));
    return { grids: byInputId(inputs, gridByURL), refs: byInputId(inputs, refByURL), states: byInputId(inputs, stateByURL), formats: byInputId(inputs, formatByURL) };
  }, [inputs, urls, responses, repairing]);
}

/**
 * Re-key values read per source URL by the input ids that play that URL.
 * @param inputs - The draft's inputs.
 * @param byURL - The values by source URL.
 * @returns The values by input id, leaving out inputs with none.
 * @throws {never} Never.
 */
function byInputId<T>(inputs: readonly VideoToolDraft['inputs'][number][], byURL: ReadonlyMap<string, T>): Map<string, T> {
  return new Map(inputs.flatMap((input) => { const value = byURL.get(input.url); return value === undefined ? [] : [[input.inputId, value] as const]; }));
}

/**
 * The data and status of each query, structurally shared by React Query so an unchanged read keeps its identity.
 * @param results - The query results.
 * @returns Their data and status.
 * @throws {never} Never.
 */
function readsOf<T>(results: readonly { data: T | undefined; status: 'pending' | 'success' | 'error' }[]): { data: T | undefined; status: 'pending' | 'success' | 'error' }[] {
  return results.map((result) => ({ data: result.data, status: result.status }));
}

/**
 * Reads the persisted scalar references with replacement-aware subscription.
 * @throws {never} Never.
 * @param projectId - The Project that owns this canvas.
 * @param spaceId - The canvas Space.
 * @param nodeId - The host video node.
 * @returns The current value derived from these inputs.
 */
function useAnalysisRefs(projectId: string, spaceId: string, nodeId: string): ReturnType<typeof videoToolAnalysisRefs> {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  /**
   * The node's accepted analysis refs as the document holds them now.
   * @returns The refs.
   * @throws {never} Never.
   */
  const current = React.useCallback((): ReturnType<typeof videoToolAnalysisRefs> => {
    const data = nodeDataMap(doc, nodeId);
    return videoToolAnalysisRefs(data === null ? {} : Object.fromEntries(data.entries()));
  }, [doc, nodeId]);
  // Read at the first render: an effect that starts paid work in the same commit must see the refs already accepted.
  const [refs, setRefs] = React.useState(current);
  React.useEffect(() => {
    /**
     * Publishes accepted metadata independently of draft revisions.
     * @throws {never} Never.
     */
    function read(): void {
      const found = current();
      setRefs((before) => canonicalMiniToolValue(before) === canonicalMiniToolValue(found) ? before : found);
    }
    read();
    doc.getMap(CANVAS_NODES_KEY).observeDeep(read);
    return () => doc.getMap(CANVAS_NODES_KEY).unobserveDeep(read);
  }, [doc, current]);
  return refs;
}

/**
 * Edits the authoritative snapshot while panel and picker state remain transient.
 * @throws {Error} When a malformed supported draft is committed.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoToolPanelContainer(props: VideoToolPanelContainerProps): React.JSX.Element | null {
  const { nodeId, toolId, node, nodes, presentation, onRunVideo, costs, renderTimelineDecoder, overlayTarget, binding, sourceBinding } = props;
  const { projectId, spaceId, readOnly: viewer } = useCanvasContext();
  // Offline the panel takes no edit and starts no work, as in a read-only Space (canvas design §4).
  const offline = useConnectionLost();
  const readOnly = viewer || offline;
  const t = useTranslation();
  const store = useCanvasSessionStore();
  const session = useCanvasSession((state) => state.miniTool);
  const pick = useCanvasSession((state) => state.pickSession);
  const expandFrame = session?.expand;
  const drop = useStore((state) => toolId === 'video.expand' && expandFrame != null ? expandDrop(expandFrame, state.nodeLookup.get(nodeId)?.measured.height ?? 0, state.transform[2]) : 0);
  const close = useCanvasSession((state) => state.closeActivePanel);
  const reading = useVideoToolDraft(projectId, spaceId, nodeId, toolId);
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const data = node.data as Record<string, unknown>;
  const source = React.useMemo(() => {
    const registered = sourceBinding && sourceBinding.canonicalURL === data.content ? sourceBinding.mediaInfo : undefined;
    const parsed = videoToolSourceRefSchema.safeParse({ nodeId, canonicalURL: data.content, mediaInfo: {
      // With a selected P, geometry is P.display; the registered size takes no part (§7.8 geometry reads).
      width: presentation?.display?.width ?? binding?.original.width ?? registered?.width ?? data.width,
      height: presentation?.display?.height ?? binding?.original.height ?? registered?.height ?? data.height,
      duration: registered?.duration ?? binding?.original.duration ?? data.duration,
      mimeType: registered?.mimeType ?? data.mimeType,
    } });
    return parsed.success ? parsed.data : null;
  }, [data, nodeId, sourceBinding, binding, presentation?.display?.width, presentation?.display?.height]);
  const grid = presentation?.grid ?? null;
  const gridFrames = grid?.frameCount ?? null;
  const initial = React.useMemo(() => {
    // An erase range starts as the whole grid, so the draft waits for it (frames-split §10.12 video-tool-edit row).
    if (source === null || (toolId === 'video.erase' && gridFrames === null)) return null;
    const draft = createVideoToolDraft(toolId, source, gridFrames ?? undefined);
    return toolId === 'video.transitions' && typeof data.coverUrl === 'string' ? { ...draft, inputs: draft.inputs.map((input) => ({ ...input, cover: data.coverUrl as string })) } : draft;
  }, [toolId, source, data.coverUrl, gridFrames]);
  const current = reading.state === 'supported' ? reading.draft : reading.state === 'absent' ? initial : null;
  // The configured models, the footer estimate and the last lip-sync failure; a caller's own values win (tests, stories).
  const models = useVideoToolModels({ projectId, spaceId, nodeId, toolId, nodes });
  const lipSync = props.lipSync ?? models.lipSync;
  const eraseLimits = props.erase ?? models.erase;
  const expandLimits = props.expand ?? models.expand;
  const maxOutputs = props.maxOutputs ?? models.maxOutputs;
  const lipSyncFailure = props.lipSyncFailure ?? models.lipSyncFailure;
  const onRetryFailed = props.onRetryFailed ?? models.onRetryFailed;
  const retryIntent = props.onRetryFailed === undefined ? models.retryIntent : undefined;
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  // A picked input's Retry repairs that input's source, as the current video's does (frames-split §7.12 retry column).
  const { repair: repairInput, repairing } = useVideoPresentationRepair(projectId);
  const { grids: inputGrids, refs: inputRefs, states: inputStates, formats: inputFormats } = useInputPresentations(projectId, toolId === 'video.transitions' && current !== null ? current.inputs : NO_INPUTS, repairing);
  const [invalidFields, setInvalidFields] = React.useState<ReadonlySet<string>>(new Set());
  const refs = useAnalysisRefs(projectId, spaceId, nodeId);
  const queryClient = useQueryClient();
  const analysisReadings = useQueries({ queries: refs.filter((reference) => reference.toolId === toolId && reference.draftId === current?.draftId).map((reference) => ({ ...miniToolAnalysisQuery(reference.analysisRunId), refetchOnMount: 'always' as const })), combine: analysisRecords });
  const records = analysisReadings.records;
  const dependencyParams = current === null ? null : toolId === 'video.lip-sync' ? { anchor: (current as VideoToolDraftById['video.lip-sync']).params.anchor } : toolId === 'video.erase' ? { range: (current as VideoToolDraftById['video.erase']).params.range, anchor: (current as VideoToolDraftById['video.erase']).params.anchor, region: (current as VideoToolDraftById['video.erase']).params.region, trackingPrompt: (current as VideoToolDraftById['video.erase']).params.trackingPrompt } : { range: { start: 0, end: gridFrames ?? 0 } };
  const dependencyKey = current === null ? '' : canonicalMiniToolValue({ draftId: current.draftId, source: current.source, params: dependencyParams });
  const [selection, setSelection] = React.useState<{ key: string; records: MiniToolAnalysisRecord[] }>({ key: '', records: [] });
  const matchingRecords = React.useMemo(() => selection.key === dependencyKey ? selection.records : [], [selection, dependencyKey]);
  // An erase runs on the tracking made for the current selection, the one its Run waits for and its box follows (§10.3).
  const tracking = toolId === 'video.erase' ? latestMiniToolAnalysis(matchingRecords.filter((record) => record.kind === 'tracked_mask' && record.status === 'completed' && !record.artifactUnavailable)) ?? undefined : undefined;
  const trackingStatus = toolId === 'video.erase' ? eraseTrackingStatus({ selected: current !== null && ((current as VideoToolDraftById['video.erase']).params.region.box !== null || (current as VideoToolDraftById['video.erase']).params.region.points.length > 0), matched: tracking !== undefined, judged: selection.key === dependencyKey, records }) : undefined;
  // Every footer shows the server's quote of the planned request the Run sends (§97 D26-1, D27-1; frames-split §10.8, billing).
  const quoteFacts = React.useMemo((): PlannedVideoFacts | null => {
    if (current === null) return null;
    if (toolId === 'video.erase') {
      return presentation?.presentationRef === undefined || tracking === undefined ? null
        : { projectId, spaceId, presentationRef: presentation.presentationRef, analysisRefs: refs.filter((reference) => reference.analysisRunId === tracking.analysisRunId) };
    }
    // Frames and split plan their outputs on the selected version's grid, as their Run does.
    if (toolId === 'video.extract-frames' || toolId === 'video.split') {
      return presentation?.presentationRef === undefined || grid === null ? null : { projectId, spaceId, presentationRef: presentation.presentationRef, analysisRefs: refs, grid };
    }
    if (toolId !== 'video.transitions') return presentation?.presentationRef === undefined ? null : { projectId, spaceId, presentationRef: presentation.presentationRef, analysisRefs: refs };
    const byInput = current.inputs.map((input) => [input.inputId, inputRefs.get(input.inputId)] as const);
    return byInput.some(([, ref]) => ref === undefined) ? null : { projectId, spaceId, presentationRef: Object.fromEntries(byInput), analysisRefs: refs } as PlannedVideoFacts;
  }, [current, toolId, presentation?.presentationRef, grid, inputRefs, projectId, spaceId, refs, tracking]);
  const quote = usePlannedVideoQuote(toolId, current, quoteFacts, models.quoteDebounceMs);
  const trackingCost = useTrackingCost({ projectId, spaceId, nodeId, draft: toolId === 'video.erase' ? current as VideoToolDraftById['video.erase'] | null : null,
    grid, presentationRef: presentation?.presentationRef, presentedTime: presentedTimeOf(presentation), tracking, debounceMs: models.quoteDebounceMs });
  const counts = 'taskCounts' in node.data ? node.data.taskCounts : undefined;
  const settled = (counts?.done ?? 0) + (counts?.failed ?? 0) + (counts?.expired ?? 0);
  const seenSettled = React.useRef(settled);
  React.useEffect(() => {
    if (seenSettled.current !== settled) for (const reference of refs) void queryClient.invalidateQueries({ queryKey: miniToolAnalysisQuery(reference.analysisRunId).queryKey });
    seenSettled.current = settled;
  }, [settled, refs, queryClient]);
  React.useEffect(() => {
    let active = true;
    if (current === null) { setSelection({ key: dependencyKey, records: [] }); return undefined; }
    // Each record is judged under the profile it froze, as admission judges it (`eraseTracking`): the current draft
    // projected with that profile must fingerprint to the record's input. One fingerprint per kind and profile.
    const fingerprints = new Map<string, Promise<string | null>>();
    /**
     * The current draft's fingerprint for a record's kind under the record's profile.
     * @param record - The record.
     * @returns The fingerprint, or null when the draft cannot be projected.
     * @throws {never} A failed projection is null.
     */
    const fingerprintFor = (record: MiniToolAnalysisRecord): Promise<string | null> => {
      const key = canonicalMiniToolValue([record.kind, record.analysisInput.profile]);
      let found = fingerprints.get(key);
      if (found === undefined) {
        const params = record.kind === 'scene_cuts' ? { range: { start: 0, end: gridFrames ?? 0 } } : current.params;
        found = Promise.resolve().then(() => fingerprintMiniToolAnalysisInput(projectMiniToolAnalysisInput({ kind: record.kind, source: current.source, params, profile: record.analysisInput.profile }))).catch(() => null);
        fingerprints.set(key, found);
      }
      return found;
    };
    void Promise.all(records.map(async (record) => {
      const fingerprint = await fingerprintFor(record);
      return fingerprint !== null && selectMiniToolAnalyses([record], { draftId: current.draftId, kind: record.kind, inputFingerprint: fingerprint, references: refs }).latestAccepted !== null;
    })).then((kept) => { if (active) setSelection({ key: dependencyKey, records: records.filter((_record, at) => kept[at]) }); });

    return () => { active = false; };
  }, [records, current, dependencyKey, refs, gridFrames]);
  const locked = evaluateNodeGate({ locked: node.data.locked ?? false });
  const disabled = readOnly || locked !== null;
  // Why the panel cannot write, said in red under its controls (demo main.tsx guard-message).
  const guard = viewer ? t('canvas.miniTool.videoUI.viewerMode') : offline ? t('canvas.miniTool.videoUI.connectionUnavailable') : locked !== null ? t(locked.toastKey) : null;
  const initialized = React.useRef(false);
  React.useEffect(() => {
    if (initialized.current) return;
    // The draft a tool opens with is not the user's edit, so it is no undo step.
    if (reading.state === 'absent' && initial !== null && !disabled) { initialized.current = true; commitVideoToolDraft(doc, nodeId, toolId, initial, false); }
  }, [reading.state, initial, disabled, doc, nodeId, toolId]);
  /**
   * Rechecks the current gate and publishes one complete atomic edit.
   * @throws {Error} When the changed snapshot fails its tool schema.
   * @param next - The complete next snapshot or sequence.
   * @param undoable - Whether the edit is the user's own, an undo step; false for one the panel makes by itself.
   * @returns Whether the current authoritative revision accepted the edit.
   */
  const change = React.useCallback((next: VideoToolDraft, undoable = true): boolean => {
    if (readOnly) return false;
    const gate = evaluateNodeGate({ locked: nodeDataMap(doc, nodeId)?.get('locked') === true });
    if (gate !== null) { toast.warning(t(gate.toastKey)); return false; }
    const latest = readVideoToolDraft(doc, nodeId, toolId);
    if (latest.state === 'supported') { if (next.draftId !== latest.draft.draftId || next.revision !== latest.draft.revision) return false; }
    else if (latest.state !== 'absent' || initial === null || next.draftId !== initial.draftId || next.revision !== initial.revision) return false;
    return commitVideoToolDraft(doc, nodeId, toolId, { ...next, revision: newId() }, undoable);
  }, [readOnly, t, doc, nodeId, toolId, initial]);
  const expanded = current !== null && toolId === 'video.expand' ? current as VideoToolDraftById['video.expand'] : null;
  // An expansion is laid out on the display size admission uses (ledger plan.display), the stored size until it is known.
  const displayWidth = presentation?.display?.width ?? current?.source.mediaInfo.width;
  const displayHeight = presentation?.display?.height ?? current?.source.mediaInfo.height;
  const displaySize = React.useMemo(() => displayWidth === undefined || displayHeight === undefined ? null : { width: displayWidth, height: displayHeight }, [displayWidth, displayHeight]);
  React.useEffect(() => {
    if (expanded === null || displaySize === null) return;
    const active = store.getState().miniTool;
    if (active?.toolId !== 'video.expand') return;
    store.getState().setMiniToolSourceSize(displaySize);
    store.getState().setExpand({ frame: expanded.params.frame, ratio: expanded.params.ratio });
  }, [expanded, displaySize, store]);
  const slots = session?.slots;
  // A picked video whose node stores no length takes it from its source as the current video does: registered, then presented.
  // Only settled answers are kept: a length, or 'none' once the server says no later read can change it.
  const [pickedLengths, setPickedLengths] = React.useState<ReadonlyMap<string, number | 'none'>>(new Map());
  const timelineSlot = slots?.timeline;
  const unmeasured = toolId === 'video.transitions' && current !== null && !disabled && timelineSlot !== undefined && !Array.isArray(timelineSlot) && (timelineSlot as MiniToolSlotValue).duration === undefined ? (timelineSlot as MiniToolSlotValue).url : null;
  const measuring = unmeasured !== null && !pickedLengths.has(unmeasured) ? unmeasured : null;
  // The held source is observed rather than read once, so an answer still being prepared keeps polling until it settles.
  const lengthReading = useQuery(videoPresentationQuery({ projectId, canonicalURL: measuring ?? '', active: measuring !== null }));
  React.useEffect(() => {
    if (measuring === null) return;
    if (lengthReading.isError) {
      // A transport failure is not an answer about the video: nothing is kept, so the next pick reads again.
      toast.warning(t('canvas.miniTool.videoUI.mediaError'));
      store.getState().clearMiniToolSlot('timeline');
      return;
    }
    const answer = lengthReading.data;
    if (answer === undefined) return;
    const length = answer.sourceBinding.mediaInfo.duration ?? answer.presentation?.original.duration ?? (answer.pollAfterMs === null ? 'none' as const : null);
    if (length !== null) setPickedLengths((known) => new Map(known).set(measuring, length));
  }, [measuring, lengthReading.isError, lengthReading.data, store, t]);
  React.useEffect(() => {
    if (current === null || slots === undefined || disabled) return;
    let pickedTimeline = false;
    for (const [key, held] of Object.entries(slots)) {
      if (held === undefined || Array.isArray(held)) continue;
      let value = held as MiniToolSlotValue;
      if (toolId === 'video.transitions' && key === 'timeline' && value.duration === undefined) {
        const length = pickedLengths.get(value.url);
        // Still being read: the slot stays held until its source answers.
        if (length === undefined) continue;
        if (length === 'none') {
          toast.warning(t('canvas.miniTool.videoUI.ledgerUnsupported'));
          store.getState().clearMiniToolSlot(key);
          continue;
        }
        value = { ...value, duration: length };
      }
      const inputId = newId();
      // The clicked node, not the first holding its address: two nodes may hold the same video (edge and name follow it).
      const copied = { inputId, url: value.url, ...(value.cover === undefined ? {} : { cover: value.cover }), ...(value.duration === undefined ? {} : { mediaInfo: { duration: value.duration } }), ...(value.nodeId === undefined ? {} : { sourceNodeId: value.nodeId }) };
      if (toolId === 'video.lip-sync' && key.startsWith('dialogue:')) {
        const draft = current as VideoToolDraftById['video.lip-sync'];
        const id = key.slice('dialogue:'.length);
        if (draft.params.dialogues.some((row) => row.dialogueId === id)) {
          const dialogues = draft.params.dialogues.map((row) => row.dialogueId === id ? { ...row, audioInputId: inputId } : row);
          const used = new Set(dialogues.map((row) => row.audioInputId));
          if (!change({ ...draft, inputs: [...draft.inputs.filter((input) => used.has(input.inputId)), copied], params: { ...draft.params, dialogues } })) continue;
        }
      } else if (toolId === 'video.transitions' && key === 'timeline') {
        const draft = current as VideoToolDraftById['video.transitions'];
        // One input slot (canvas design §4 transitions row, §28): a pick replaces the input clip's video, in place, and resets
        // its in and out; the current video's clip stays as it is.
        const hostId = transitionHostInputId(draft);
        const reset = value.duration === undefined ? null : { inputId, in: 0, out: value.duration };
        let placed = false;
        const clips = draft.params.clips.flatMap((clip) => {
          if (clip.inputId === hostId) return [clip];
          if (placed || reset === null) return [];
          placed = true;
          return [{ ...clip, ...reset }];
        });
        if (!placed && reset !== null) clips.push({ clipId: newId(), ...reset, transition: { kind: 'cut', duration: 0 } });
        // A shorter input can leave the junction longer than the clips allow, which the timeline cannot lay out: it becomes a
        // Cut, judged on the first clip's output grid (frames-split §5.4, §7.17).
        const firstGrid = clips[0] === undefined ? undefined : inputGrids.get(clips[0].inputId) ?? (clips[0].inputId === hostId ? grid ?? undefined : undefined);
        if (!change({ ...draft, inputs: [...draft.inputs.filter((input) => input.inputId === hostId), copied], params: { clips: fitTransitions(clips, firstGrid === undefined ? null : firstGrid.fps) } })) continue;
        pickedTimeline = true;
      }
      store.getState().clearMiniToolSlot(key);
    }
    // A picked video opens the timeline (canvas design §4 transitions row).
    if (pickedTimeline) { store.getState().endPick(); setTimelineOpen(true); }
  }, [slots, current, disabled, toolId, change, store, inputGrids, grid, pickedLengths, t]);
  const intent = `video-analysis:${projectId}:${spaceId}:${nodeId}:${toolId}`;
  const analysisPressRunning = Boolean(useRunning(intent));
  const analysing = analysisPressRunning || analysisReadings.pending || matchingRecords.some((record) => record.status === 'pending' || record.status === 'running');
  const autoPeople = React.useRef<string | null>(null);
  const running = useMiniToolRunning(spaceId, nodeId, toolId);
  /**
   * Sends one analysis request once, records its answer and points the draft's owner tool at it.
   * @param request - The frozen request.
   * @throws {never} Failures are reported by the press.
   */
  const startAnalysis = React.useCallback((request: MiniToolAnalysisRequest): void => {
    void runOnce(intent, { scope: 'mini-tool', prepare: () => request, send: (key, body) => miniToolAnalysesApi.start(body, key), onDone: (record) => {
      queryClient.setQueryData(miniToolAnalysisQuery(record.analysisRunId).queryKey, record);
      const owner = record.kind === 'people' ? 'video.lip-sync' : record.kind === 'scene_cuts' ? 'video.split' : 'video.erase';
      commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: owner, kind: record.kind, draftId: record.draftId, analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint } as Parameters<typeof commitVideoToolAnalysisRef>[2]);
      return undefined;
    }, onFailure: () => { toast.error(t('canvas.miniTool.videoUI.analysisFailed')); } });
  }, [intent, queryClient, doc, nodeId, t]);
  /**
   * Starts a frozen, idempotent server analysis using the presented source frame.
   * @throws {never} Failures are reported by the press.
   * @param kind - The requested source analysis.
   * @param undoable - Whether the user pressed it, so the anchor it freezes is an undo step; false for an automatic one.
   */
  const analyse = React.useCallback((kind: MiniToolAnalysisKind, undoable = true): void => {
    const shownGrid = presentation?.grid ?? null;
    if (current === null || disabled || presentation?.status !== 'ready' || shownGrid === null || presentation.sourceURL !== current.source.canonicalURL) return;
    const { presentationRef } = presentation;
    if (presentationRef === undefined) return;
    const actualTime = presentedTimeOf(presentation);
    if (kind !== 'scene_cuts' && actualTime === null) return;
    // The anchor is the grid frame the player shows (frames-split §4.3).
    const anchor = actualTime === null ? undefined : { frameIndex: frameIndexOfMediaTime(actualTime, shownGrid) };
    const frozen = kind === 'people' && toolId === 'video.lip-sync' ? { ...current, params: { ...(current as VideoToolDraftById['video.lip-sync']).params, anchor: anchor!, dialogues: resetDialoguePeople((current as VideoToolDraftById['video.lip-sync']).params.dialogues) } } : kind === 'tracked_mask' ? { ...current, params: { ...(current as VideoToolDraftById['video.erase']).params, anchor: anchor! } } : current;
    if (!change(frozen, undoable)) return;
    const held = readVideoToolDraft(doc, nodeId, toolId);
    if (held.state !== 'supported') return;
    const base = { analysisRunId: newId(), projectId, spaceId, hostNodeId: nodeId, draftId: held.draft.draftId, revision: held.draft.revision, source: held.draft.source, presentationRef };
    const request: MiniToolAnalysisRequest = kind === 'people' ? { ...base, kind, params: { anchor: anchor! } } : kind === 'scene_cuts' ? { ...base, kind, params: { range: { start: 0, end: shownGrid.frameCount } } } : { ...base, kind, params: (held.draft as VideoToolDraftById['video.erase']).params };
    if (request.kind === 'tracked_mask') request.params = { range: request.params.range, anchor: request.params.anchor, region: request.params.region, trackingPrompt: request.params.trackingPrompt };
    startAnalysis(request);
  }, [current, disabled, presentation, change, doc, nodeId, toolId, projectId, spaceId, startAnalysis]);
  /**
   * Starts a new tracking run for the selection a failed run was made for (execution design §10.3), on the current tool
   * input, without touching the draft. Retry shows only for a failed run matching the draft, so the request carries the
   * draft's own range, anchor, region and prompt, as Track selection sends them, without re-anchoring on the presented frame.
   * @param failed - The failed tracking record.
   * @throws {never} Failures are reported by the press.
   */
  const retryTracking = React.useCallback((failed: MiniToolAnalysisRecord): void => {
    if (current === null || disabled || toolId !== 'video.erase' || failed.analysisInput.kind !== 'tracked_mask' || presentation?.status !== 'ready' || presentation.sourceURL !== current.source.canonicalURL) return;
    const { presentationRef } = presentation;
    if (presentationRef === undefined) return;
    const { range, anchor, region, trackingPrompt } = (current as VideoToolDraftById['video.erase']).params;
    startAnalysis({ analysisRunId: newId(), projectId, spaceId, hostNodeId: nodeId, draftId: current.draftId, revision: current.revision, source: current.source, presentationRef,
      kind: 'tracked_mask', params: { range, anchor, region, trackingPrompt } });
  }, [current, disabled, toolId, presentation, projectId, spaceId, nodeId, startAnalysis]);
  React.useEffect(() => {
    if (toolId !== 'video.lip-sync' || current === null || disabled || presentation?.status !== 'ready' || presentation.grid === null || autoPeople.current === current.draftId || refs.some((reference) => reference.toolId === toolId && reference.draftId === current.draftId)) return;
    autoPeople.current = current.draftId;
    analyse('people', false);
  }, [toolId, current, disabled, presentation, refs, analyse]);
  React.useEffect(() => {
    if (toolId !== 'video.split' || current === null || disabled) return;
    const success = latestMiniToolAnalysis(matchingRecords.filter((record) => record.kind === 'scene_cuts' && record.status === 'completed' && record.result?.kind === 'scene_cuts'));
    if (success?.result?.kind !== 'scene_cuts') return;
    commitVideoSceneAnalysis(doc, nodeId, success);
  }, [matchingRecords, current, disabled, toolId, doc, nodeId]);
  /**
   * Marks transient invalid text without putting it in the persisted schema.
   * @throws {never} Never.
   */
  const invalidChange = React.useCallback((key: string, invalid: boolean): void => {
    setInvalidFields((before) => { const next = new Set(before); if (invalid) next.add(key); else next.delete(key); return next.size === before.size && [...next].every((value) => before.has(value)) ? before : next; });
  }, []);
  useEscapeInSpace(pick === null && !timelineOpen, close);
  // The newest ready remove-background result of this source, by its edge (canvas design §4 remove-background row): a newer
  // run still pending or failed has no content yet and must not hide an older result that is ready.
  const removeBgResult = React.useMemo(() => {
    if (toolId !== 'video.remove-bg') return null;
    const newest = readEdges(doc).filter((edge) => edge.source === nodeId && edge.toolId === 'video.remove-bg')
      .map((edge) => ({ createdAt: edge.createdAt ?? 0, view: nodes.find((candidate) => candidate.id === edge.target) }))
      .map(({ createdAt, view }) => ({ createdAt, view, url: view !== undefined && 'content' in view.data && typeof view.data.content === 'string' ? view.data.content : '' }))
      .filter(({ url }) => url !== '')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return newest?.view === undefined ? null : { url: newest.url, name: 'name' in newest.view.data && typeof newest.view.data.name === 'string' ? newest.view.data.name : '' };
  }, [toolId, doc, nodeId, nodes]);
  const [resultOpen, setResultOpen] = React.useState(false);
  // A frame the source player's camera menu asked for (tools design §4 camera menu): applied to the draft once, then dropped.
  const frameRequest = toolId === 'video.extract-frames' ? session?.params.frameMode : undefined;
  React.useEffect(() => {
    if (frameRequest !== 'first' && frameRequest !== 'last' && frameRequest !== 'current') return;
    store.getState().setMiniToolParam('frameMode', undefined);
    if (current === null) return;
    const time = presentedTimeOf(presentation);
    // Current keeps its rule: it waits for a frame actually shown.
    if (frameRequest === 'current' && (time === null || grid === null)) return;
    const draft = current as VideoToolDraftById['video.extract-frames'];
    change({ ...draft, params: { ...draft.params, mode: frameRequest, ...(frameRequest === 'current' && time !== null && grid !== null ? { frameIndex: frameIndexOfMediaTime(time, grid) } : {}) } });
  }, [frameRequest, current, presentation, grid, change, store]);
  // The row a box press fills, the first until one is chosen (demo FaceOverlay); its person's box is drawn selected.
  const lipSyncRows = toolId === 'video.lip-sync' && current !== null ? (current as VideoToolDraftById['video.lip-sync']).params.dialogues : undefined;
  const activeRow = lipSyncRows?.find((row) => row.dialogueId === session?.params.activeDialogueId) ?? lipSyncRows?.[0];
  const maxPeople = lipSync?.maxPeople;
  // The boxes a press would take past the people limit, dimmed as the person dropdown's items are (canvas design §4 lip-sync row).
  const cappedPersonIds = React.useMemo(() => new Set(lipSyncRows === undefined || activeRow === undefined ? []
    : (currentPeopleResult(matchingRecords)?.people ?? []).filter((person) => overPeopleLimit(lipSyncRows, activeRow.dialogueId, person.personId, maxPeople)).map((person) => person.personId)),
  [lipSyncRows, activeRow, matchingRecords, maxPeople]);
  const spec = miniToolById(toolId);
  // The box following the tracked object on the presented frame, from the tracking made for this selection (§10.3).
  const trackedBox = useTrackedBox(tracking,
    grid, toolId === 'video.erase' && current !== null ? (current as VideoToolDraftById['video.erase']).params.range : null, presentedTimeOf(presentation));
  // The strip reads the actual presented frame itself while the source plays; the panel keeps its pause-and-seek cadence.
  const liveClock = React.useMemo(() => binding && presentation ? { element: binding.element, read: () => presentedTimeOf(presentation) } : undefined, [binding, presentation]);
  // A platform-funded tool costs the user nothing, so its footer says Free (frames-split §5.5).
  const platformFunded = miniToolChargeTo(toolId) === 'platform';
  const presentationFailure = presentation?.failure ?? null;
  if (spec === undefined) return null;
  // An erase draft starts on the whole grid, so until P is selected there is no draft: the panel shows only why it waits, or
  // the candidate's failure and its Retry, as every other tool's panel does (frames-split §7.12).
  if (current === null && source !== null && reading.state === 'absent') {
    const state = presentation?.panelState ?? 'waiting-presentation';
    return <NodePanelMount nodeId={nodeId}><div data-testid='video-tool-waiting' className='nowheel nodrag flex items-center justify-between gap-3 rounded-overlay border border-border bg-popover p-3'>
      <p className={state === 'waiting-presentation' ? 'text-xs text-muted-foreground' : 'text-xs text-status-error-foreground'}>{t(state === 'retryable' ? 'canvas.miniTool.videoUI.preparationFailed'
        : state === 'unsupported' ? (presentationFailure === 'too_long' ? 'canvas.miniTool.videoUI.tooLongToPrepare' : 'canvas.miniTool.videoUI.ledgerUnsupported') : 'canvas.miniTool.videoUI.preparingVideo')}</p>
      {state === 'retryable' && presentation?.onRetry !== undefined ? <Button variant='outline' size='compact' loading={presentation.retrying === true} onClick={presentation.onRetry}>{t('canvas.miniTool.videoUI.retryPreview')}</Button> : null}
    </div></NodePanelMount>;
  }
  if (current === null || source === null || current.source.canonicalURL !== source.canonicalURL) return <NodePanelMount nodeId={nodeId}><div className='nowheel nodrag rounded-overlay border border-border bg-popover p-3'><p className='text-xs'>{t(reading.state === 'unsupported' || reading.state === 'invalid' ? 'canvas.miniTool.videoUI.unsupportedDraft' : current !== null && source !== null ? 'canvas.miniTool.videoUI.sourceChanged' : 'canvas.miniTool.videoUI.sourceUnavailable')}</p>{source === null || disabled ? null : <Button variant='outline' size='sm' onClick={() => { store.getState().endPick(); store.getState().resetMiniToolSource(source.canonicalURL, {}); clearVideoToolDraft(doc, nodeId, toolId); commitVideoToolDraft(doc, nodeId, toolId, createVideoToolDraft(toolId, source)); }}>{t(current !== null && source !== null ? 'canvas.miniTool.videoUI.useCurrentSource' : 'canvas.miniTool.videoUI.rebuildDraft')}</Button>}</div></NodePanelMount>;
  const names = new Map(current.inputs.map((input) => [input.inputId, nodes.filter((candidate) => 'content' in candidate.data && candidate.data.content === input.url).map((candidate) => ({ id: candidate.id, name: 'name' in candidate.data ? candidate.data.name : undefined })).find((candidate) => candidate.id === input.sourceNodeId)?.name ?? input.url.split('/').at(-1) ?? '']));
  // The panel shows the worst of the current video and every picked input, the current video first among equals (frames-split
  // §7.12 last paragraph); a current video without source facts counts as usable, as it does alone.
  const hostInputId = toolId === 'video.transitions' ? transitionHostInputId(current as VideoToolDraftById['video.transitions']) : undefined;
  const shown = worstVideoToolPanelState([{ state: presentation?.panelState ?? 'usable', retrying: presentation?.retrying === true, onRetry: presentation?.onRetry },
    ...(toolId === 'video.transitions' ? current.inputs.filter((input) => input.inputId !== hostInputId).map((input) => ({ state: inputStates.get(input.inputId) ?? 'waiting-presentation',
      retrying: repairing.has(input.url), onRetry: (): void => repairInput(input.url) })) : [])]);
  const validSource = presentation?.status === 'ready' && presentation.sourceURL === source.canonicalURL && grid !== null && shown.state === 'usable';
  // Only the newest identification's people count; a running or failed re-detect has none (demo redetectPatch).
  const visiblePeople = currentPeopleResult(matchingRecords);
  const hasDialogue = toolId !== 'video.lip-sync' || (current as VideoToolDraftById['video.lip-sync']).params.dialogues.length > 0 && (current as VideoToolDraftById['video.lip-sync']).params.dialogues.every((row) => row.audioInputId !== null && visiblePeople?.kind === 'people' && row.analysisRunId === visiblePeople.analysisRunId && visiblePeople.people.some((person) => person.personId === row.personId));
  const readyTool = toolId === 'video.expand' ? isExpanded((current as VideoToolDraftById['video.expand']).params.frame, displaySize ?? current.source.mediaInfo) : toolId === 'video.erase' ? tracking !== undefined : toolId === 'video.transitions' ? (current as VideoToolDraftById['video.transitions']).params.clips.length === 2 : true;
  const selectedTime = presentedTimeOf(presentation);
  const needsCurrent = toolId === 'video.extract-frames' && (current as VideoToolDraftById['video.extract-frames']).params.mode === 'current';
  const runnable = !readOnly && (!needsCurrent || selectedTime !== null) && validSource && invalidFields.size === 0 && hasDialogue && onRunVideo !== undefined;
  const canRun = runnable && readyTool;
  // Transitions without a picked video keeps Run pressable to say so (canvas design §4 transitions row).
  const awaitingInput = runnable && !readyTool && toolId === 'video.transitions';
  // What Export says while Run cannot run (canvas design §10 editor × export): the condition the panel is waiting on.
  const exportBlockedReason = canRun || readOnly ? undefined : !validSource ? t('canvas.miniTool.panel.sourceMissing')
    : invalidFields.size > 0 ? t('canvas.miniTool.videoUI.invalidNumber') : !readyTool ? t('canvas.miniTool.videoUI.pickVideo') : t('canvas.miniTool.panel.sourceMissing');
  const transparent = presentation?.transparent === true;
  const eraseDraft = toolId === 'video.erase' ? current as VideoToolDraftById['video.erase'] : null;
  // Track selection anchors on the presented frame, as its press does (analyse); Run is judged on the anchor it sends.
  const pressFrame = eraseDraft === null || selectedTime === null || grid === null ? undefined : frameIndexOfMediaTime(selectedTime, grid);
  const trackBlockedReason = eraseDraft === null ? undefined : eraseBlock(eraseDraft.params.range, pressFrame === undefined ? eraseDraft.params.anchor : { frameIndex: pressFrame },
    grid, eraseLimits, transparent, t);
  // The planned split outputs while the frame table is usable, which the panel also states when over the cap (frames-split §10.7).
  const splitCount = toolId === 'video.split' && validSource && grid !== null ? planVideoSplit(grid, (current as VideoToolDraftById['video.split']).params.cuts).length : null;
  const splitOverCap = splitCount !== null && maxOutputs !== undefined && splitCount > maxOutputs;
  // The header counts the outputs a run plans (demo main.tsx): one per split segment, one for every other tool; the
  // expand panel keeps the image Expand panel's header (demo outpaint-controls.tsx).
  const outputCount = toolId === 'video.split' ? splitCount ?? splitCuts(gridFrames ?? Infinity, (current as VideoToolDraftById['video.split']).params.cuts).length + 1 : 1;
  const header = toolId === 'video.expand' ? undefined : <span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.outputCount', { count: outputCount })}</span>;
  const runBlockedReason = awaitingInput ? t('canvas.generatePanel.errorNoSourceVideo') : !canRun ? undefined
    : toolId === 'video.lip-sync' ? (lipSync !== undefined && grid !== null ? lipSyncRangeBlock(current as VideoToolDraftById['video.lip-sync'], grid, lipSync, t) : undefined)
      : eraseDraft !== null ? eraseBlock(eraseDraft.params.range, eraseDraft.params.anchor, grid, eraseLimits, transparent, t)
        : toolId === 'video.expand' ? expandBlock(current as VideoToolDraftById['video.expand'], displaySize ?? current.source.mediaInfo,
          presentation.display?.duration ?? current.source.mediaInfo.duration, expandLimits, transparent, t)
          : toolId === 'video.transitions' ? transitionClipBlock(current as VideoToolDraftById['video.transitions'], inputGrids, hostInputId, grid, t)
          // More planned outputs than one run creates are refused here, before any node is made (frames-split §10.7).
            : splitOverCap ? t('canvas.miniTool.videoUI.tooManyOutputs', { max: maxOutputs }) : undefined;
  /**
   * Freezes exactly the visible source frame at the press before execution.
   * @returns The press outcome, or undefined when nothing was sent.
   * @throws {never} The execution callback owns request failures.
   */
  function run(): Promise<unknown> | undefined {
    if (!canRun || onRunVideo === undefined) return undefined;
    const gate = evaluateNodeGate({ locked: nodeDataMap(doc, nodeId)?.get('locked') === true });
    if (gate !== null) { toast.warning(t(gate.toastKey)); return undefined; }
    store.getState().endPick();
    if (current === null) return undefined;
    let frozen: VideoToolDraft = current;
    if (toolId === 'video.extract-frames' && presentation !== undefined && (current as VideoToolDraftById['video.extract-frames']).params.mode === 'current') {
      const actualTime = presentedTimeOf(presentation);
      if (actualTime === null || grid === null) return undefined;
      const frames = current as VideoToolDraftById['video.extract-frames'];
      const next = { ...frames, params: { ...frames.params, frameIndex: frameIndexOfMediaTime(actualTime, grid) } };
      // The run's nodes and edges are its one undo batch; the time frozen at the press is no step of its own (canvas design §3.3).
      if (!change(next, false)) return undefined;
      const committed = readVideoToolDraft(doc, nodeId, toolId);
      if (committed.state !== 'supported') return undefined;
      frozen = committed.draft;
    }
    // A quoted run sends the quoted request: the same facts and the output node the quote named (§97 D27-1).
    // ponytail: remove-bg runs on its own press facts (its Run lays out its output from the tool's descriptor), so its Run
    // names a new node rather than the quoted one; the body is otherwise the same request.
    return quoteFacts === null || toolId === 'video.remove-bg' ? onRunVideo(nodeId, toolId, frozen, matchingRecords)
      : onRunVideo(nodeId, toolId, frozen, matchingRecords, { ...quoteFacts, outputNodeIds: quote.outputNodeIds });
  }
  const frame = binding?.getPresentedFrame() ?? null;
  const currentFrame = frame !== null && frame.sourceKey === binding?.sourceKey && frame.sourceEpoch === binding.sourceEpoch && frame.seekEpoch === binding.getSeekEpoch();
  const overlay = overlayTarget && binding && (toolId === 'video.erase' || toolId === 'video.lip-sync') ? createPortal(<VideoToolNodeOverlay
    region={toolId === 'video.erase' ? (current as VideoToolDraftById['video.erase']).params.region : undefined}
    selection={session?.params.videoRegionMode === 'point' ? 'point' : 'rectangle'}
    people={analysing ? undefined : visiblePeople}
    activePersonId={activeRow?.personId}
    cappedPersonIds={cappedPersonIds}
    onRegion={(region) => { if (toolId === 'video.erase') change({ ...current as VideoToolDraftById['video.erase'], params: { ...(current as VideoToolDraftById['video.erase']).params, region } }); }}
    onPerson={(personId) => {
      if (toolId !== 'video.lip-sync' || visiblePeople?.kind !== 'people') return;
      const draft = current as VideoToolDraftById['video.lip-sync'];
      const id = activeRow?.dialogueId;
      if (id === undefined) return;
      if (overPeopleLimit(draft.params.dialogues, id, personId, maxPeople)) { toast.warning(t('server.mini_tool.lipSyncTooManyPeople', { max: maxPeople ?? 0 })); return; }
      change({ ...draft, params: { ...draft.params, dialogues: draft.params.dialogues.map((row) => row.dialogueId === id ? { ...row, personId, analysisRunId: visiblePeople.analysisRunId } : row) } });
    }}
    trackedBox={toolId === 'video.erase' ? trackedBox : undefined}
    tracked={trackingStatus === 'tracked'}
    disabled={disabled || !currentFrame}
    revision={current.revision} sourceEpoch={binding.sourceEpoch} seekEpoch={binding.getSeekEpoch()}
  />, overlayTarget) : null;
  return <>{overlay}<NodePanelMount nodeId={nodeId} drop={drop}><MiniToolPanel customWide={toolId === 'video.lip-sync'} titleIcon={toolId !== 'video.expand'} aside={header} spec={spec} modelControls={undefined} modelEntry={undefined} params={{}} onParams={() => undefined} source={{ url: source.canonicalURL, ...source.mediaInfo }} sizeTiers={[]} slots={{}} slotCaps={{}} pickingSlot={null} onPickSlot={() => undefined} onClearSlot={() => undefined} prompt='' onPrompt={() => undefined} creditText={platformFunded ? t('canvas.miniTool.panel.free') : costs?.execution ?? quote.text ?? ''} refusal={running ? 'exporting' : canRun || awaitingInput ? null : 'slotMissing'} runBlockedReason={runBlockedReason} onRun={() => { void run(); }} onClose={close} customBody={<>{analysisReadings.failed ? <div className='flex items-center justify-between gap-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.analysisFailed')}</span><Button variant='outline' size='compact' loading={analysisReadings.fetching} onClick={() => { for (const reference of refs) void queryClient.invalidateQueries({ queryKey: miniToolAnalysisQuery(reference.analysisRunId).queryKey }); }}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : null}<VideoToolControls toolId={toolId} draft={current} onChange={change} analyses={matchingRecords} grid={validSource ? grid : null} previewSource={presentation?.previewSource} presentedTime={selectedTime} liveClock={liveClock} disabled={disabled || !validSource && toolId !== 'video.extract-frames'} onOpenResult={removeBgResult === null ? undefined : () => setResultOpen(true)} pickingSlot={pick?.purpose === 'miniToolSlot' ? pick.slotKey ?? null : null} inputNames={names} onPick={(key) => { if (disabled) return; if (pick?.purpose === 'miniToolSlot' && pick.slotKey === key) store.getState().endPick(); else store.getState().startMiniToolSlotPick(nodeId, key); }} onAnalyse={analyse} onRetryTracking={retryTracking} analysing={analysing} analysisCreditText={costs?.analysis ?? trackingCost.estimate} analysisActualCreditText={costs?.analysisActual ?? trackingCost.actual} onSeek={presentation?.onSeek} onPlayRange={presentation?.onPlayRange} sourceEpoch={presentation?.sourceEpoch ?? 0} seekEpoch={presentation?.seekEpoch ?? 0} onEditTimeline={() => setTimelineOpen(true)} onInvalidChange={invalidChange} regionSelection={session?.params.videoRegionMode === 'point' ? 'point' : 'rectangle'} onRegionSelection={(mode) => store.getState().setMiniToolParam('videoRegionMode', mode)} onEndPick={() => store.getState().endPick()} onActiveDialogue={(id) => store.getState().setMiniToolParam('activeDialogueId', id)} lipSync={lipSync} lipSyncFailure={lipSyncFailure} onRetryFailed={onRetryFailed} retryIntent={retryIntent} trackBlockedReason={trackBlockedReason} trackingStatus={trackingStatus} expandSize={displaySize ?? undefined} />{invalidFields.size === 0 || toolId === 'video.lip-sync' ? null : <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.invalidNumber')}</p>}{guard === null ? null : <p data-testid='video-tool-guard' className='text-xs text-status-error-foreground'>{guard}</p>}{splitOverCap ? <p data-testid='video-output-cap' className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.outputCapExceeded', { cap: maxOutputs, count: splitCount })}</p> : null}{validSource ? null : shown.state === 'retryable' || shown.retrying ? <div className='flex items-center justify-between gap-3 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground'><span>{t(presentation?.status === 'failed' ? 'canvas.miniTool.videoUI.mediaError' : 'canvas.miniTool.videoUI.preparationFailed')}</span><Button variant='outline' size='compact' loading={shown.retrying} onClick={shown.onRetry}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : <p className={shown.state === 'unsupported' ? 'text-xs text-status-error-foreground' : 'text-xs text-muted-foreground'}>{t(shown.state === 'unsupported' ? (presentationFailure === 'too_long' ? 'canvas.miniTool.videoUI.tooLongToPrepare' : 'canvas.miniTool.videoUI.ledgerUnsupported') : presentation?.status === 'failed' ? 'canvas.miniTool.videoUI.mediaError' : 'canvas.miniTool.videoUI.preparingVideo')}</p>}</>} /></NodePanelMount>{toolId === 'video.transitions' ? <VideoTimelineDialog renderDecoder={renderTimelineDecoder} open={timelineOpen} onOpenChange={setTimelineOpen} draft={current as VideoToolDraftById['video.transitions']} onChange={change} inputNames={names} disabled={disabled} onRun={run} runBlockedReason={exportBlockedReason ?? runBlockedReason} inputGrids={inputGrids} inputFormats={inputFormats} /> : null}{removeBgResult === null ? null : <VideoResultPreviewDialog open={resultOpen} onOpenChange={setResultOpen} projectId={projectId} url={removeBgResult.url} name={removeBgResult.name} />}</>;
}
