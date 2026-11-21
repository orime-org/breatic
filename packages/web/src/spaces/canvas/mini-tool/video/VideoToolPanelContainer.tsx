// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { PresentedMediaFrame, MediaSurfaceBinding, VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import type { VideoToolPanelState } from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CANVAS_NODES_KEY, newId, type VideoPresentationSourceBinding } from '@breatic/shared';
import { canonicalMiniToolValue, fingerprintMiniToolAnalysisInput, miniToolChargeTo, planVideoSplit, projectMiniToolAnalysisInput, videoToolAnalysisRefs, videoToolSourceRefSchema, selectMiniToolAnalyses, type MiniToolAnalysisRecord, type MiniToolAnalysisRequest, type MiniToolPresentationRef, type VideoPlanGrid, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { miniToolAnalysesApi, miniToolAnalysisQuery, latestMiniToolAnalysis } from '@web/data/api/mini-tool-analyses';
import { docName, getDoc } from '@web/data/yjs/manager';
import { nodeDataMap, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoSceneAnalysis, commitVideoToolAnalysisRef, commitVideoToolDraft, clearVideoToolDraft, readVideoToolDraft, rebindVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { useVideoToolDraft } from '@web/data/yjs/use-video-tool-draft';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useMiniToolRunning } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { MiniToolPanel } from '@web/spaces/canvas/mini-tool/MiniToolPanel';
import { NodePanelMount } from '@web/spaces/canvas/_shared/NodePanelMount';
import { useCanvasContext, useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { createVideoToolDraft } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import { cutsOutsideGrid, splitCuts, VideoToolControls } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import { useVideoToolModels } from '@web/spaces/canvas/mini-tool/video/use-video-tool-models';
import { usePlannedVideoQuote } from '@web/spaces/canvas/mini-tool/video/use-planned-video-quote';
import type { PlannedVideoFacts, PlannedVideoPress } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { frameIndexOfMediaTime } from '@web/spaces/canvas/video-presentation/frame-grid-time';
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

/**
 * Scene detections this page saw unfinished. A detection superseded by an edit is said once, when it finishes; one that had
 * already finished when the page opened says nothing, since its Detect again button already shows it was not used.
 */
const watchedSceneRuns = new Set<string>();

/** Authoritative presentation facts supplied by the video node owner. */
export interface VideoToolPresentation {
  panelState?: VideoToolPanelState;
  /** The target candidate's failure code while nothing is selected, which names why the panel cannot be used (§7.12 step 2). */
  failure?: string | null;
  /** Whether the source's presentation read failed with no response held; Retry rereads it (§7.12 step 1). */
  readFailed?: boolean;
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
  /** The selected version's display size, the sample aspect ratio applied, and its duration in seconds. */
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

/** The panel's cost texts: the run's estimate and an analysis's estimate. */
export interface VideoToolCostText { execution: string; analysis?: string }

export interface VideoToolPanelContainerProps {
  /** Registry identity and nullable metadata from the authorized source query. */
  sourceBinding?: VideoPresentationSourceBinding;
  /** Actual transport identity and frame-clock epoch for overlay invalidation. */
  binding?: MediaSurfaceBinding | null;
  costs?: VideoToolCostText;
  nodeId: string;
  toolId: VideoToolId;
  node: CanvasNodeView;
  presentation?: VideoToolPresentation;
  onRunVideo?: (nodeId: string, toolId: VideoToolId, draft: VideoToolDraft, analyses: readonly MiniToolAnalysisRecord[], plan?: PlannedVideoPress) => Promise<unknown>;
  /** The most outputs one run of this tool creates (config `executions[tool].max_outputs`). */
  maxOutputs?: number;
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
  const { nodeId, toolId, node, presentation, onRunVideo, costs, binding, sourceBinding } = props;
  const { projectId, spaceId, readOnly: viewer } = useCanvasContext();
  // Offline the panel takes no edit and starts no work, as in a read-only Space (canvas design §4).
  const offline = useConnectionLost();
  const readOnly = viewer || offline;
  const t = useTranslation();
  const store = useCanvasSessionStore();
  const session = useCanvasSession((state) => state.miniTool);
  const pick = useCanvasSession((state) => state.pickSession);
  const close = useCanvasSession((state) => state.closeActivePanel);
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const data = node.data as Record<string, unknown>;
  // The selected version of this node's content, the one its frame numbers belong to (frames-split §7.13); one value for as
  // long as it names the same version.
  const refKey = presentation?.presentationRef !== undefined && presentation.sourceURL === data.content ? `${presentation.presentationRef.source.toolInputId}:${presentation.presentationRef.source.planSha256}` : null;
  const selectedRef = React.useMemo((): MiniToolPresentationRef | undefined => {
    if (refKey === null) return undefined;
    const [toolInputId = '', planSha256 = ''] = refKey.split(':');
    return { source: { toolInputId, planSha256 } };
  }, [refKey]);
  const reading = useVideoToolDraft(projectId, spaceId, nodeId, toolId, selectedRef);
  // A draft set on another version keeps its values but neither plans nor runs until the user rebinds it.
  const stale = reading.state === 'stale';
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
  // The draft the panel shows until one is stored; it is stored only on a selected version (frames-split §7.13 absent × Open).
  const initial = React.useMemo(() => {
    return source === null ? null : createVideoToolDraft(toolId, source, selectedRef);
  }, [toolId, source, selectedRef]);
  const current = reading.state === 'supported' || reading.state === 'stale' ? reading.draft : reading.state === 'absent' ? initial : null;
  // The footer quote debounce and the output cap; a caller's own value wins (tests, stories).
  const models = useVideoToolModels({ toolId });
  const maxOutputs = props.maxOutputs ?? models.maxOutputs;
  const [invalidFields, setInvalidFields] = React.useState<ReadonlySet<string>>(new Set());
  // The draft revision whose cuts outside the grid Apply to this video found; any edit writes a new revision and clears it.
  const [outsideFound, setOutsideFound] = React.useState<string | null>(null);
  const refs = useAnalysisRefs(projectId, spaceId, nodeId);
  const queryClient = useQueryClient();
  const analysisReadings = useQueries({ queries: refs.filter((reference) => reference.toolId === toolId && reference.draftId === current?.draftId).map((reference) => ({ ...miniToolAnalysisQuery(reference.analysisRunId), refetchOnMount: 'always' as const })), combine: analysisRecords });
  const records = analysisReadings.records;
  const dependencyParams = current === null ? null : { range: { start: 0, end: gridFrames ?? 0 } };
  const dependencyKey = current === null ? '' : canonicalMiniToolValue({ draftId: current.draftId, source: current.source, params: dependencyParams });
  const [selection, setSelection] = React.useState<{ key: string; records: MiniToolAnalysisRecord[] }>({ key: '', records: [] });
  const matchingRecords = React.useMemo(() => selection.key === dependencyKey ? selection.records : [], [selection, dependencyKey]);
  // Every footer shows the server's quote of the planned request the Run sends (§97 D26-1, D27-1; frames-split §10.8, billing).
  const quoteFacts = React.useMemo((): PlannedVideoFacts | null => {
    // Frames and split plan their outputs on the selected version's grid, as their Run does.
    if (current === null || stale || presentation?.presentationRef === undefined || grid === null) return null;
    return { projectId, spaceId, presentationRef: presentation.presentationRef, analysisRefs: refs, grid };
  }, [current, stale, presentation?.presentationRef, grid, projectId, spaceId, refs]);
  const quote = usePlannedVideoQuote(toolId, current, quoteFacts, models.quoteDebounceMs);
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
    // Each record is judged under the profile it froze, as admission judges it: the current draft projected with that
    // profile must fingerprint to the record's input. One fingerprint per kind and profile.
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
        const params = { range: { start: 0, end: gridFrames ?? 0 } };
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
    if (reading.state === 'absent' && initial?.presentationRef !== undefined && !disabled) { initialized.current = true; commitVideoToolDraft(doc, nodeId, toolId, initial, false); }
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
    else if (latest.state !== 'absent' || initial?.presentationRef === undefined || next.draftId !== initial.draftId || next.revision !== initial.revision) return false;
    return commitVideoToolDraft(doc, nodeId, toolId, { ...next, revision: newId() }, undoable);
  }, [readOnly, t, doc, nodeId, toolId, initial]);
  const intent = `video-analysis:${projectId}:${spaceId}:${nodeId}:${toolId}`;
  const analysisPressRunning = Boolean(useRunning(intent));
  const analysing = analysisPressRunning || analysisReadings.pending || matchingRecords.some((record) => record.status === 'pending' || record.status === 'running');
  const running = useMiniToolRunning(spaceId, nodeId, toolId);
  /**
   * Sends one analysis request once, records its answer and points the draft's owner tool at it.
   * @param request - The frozen request.
   * @throws {never} Failures are reported by the press.
   */
  const startAnalysis = React.useCallback((request: MiniToolAnalysisRequest): void => {
    void runOnce(intent, { scope: 'mini-tool', prepare: () => request, send: (key, body) => miniToolAnalysesApi.start(body, key), onDone: (record) => {
      queryClient.setQueryData(miniToolAnalysisQuery(record.analysisRunId).queryKey, record);
      commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.split', kind: record.kind, draftId: record.draftId, analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint } as Parameters<typeof commitVideoToolAnalysisRef>[2]);
      return undefined;
    }, onFailure: () => { toast.error(t('canvas.miniTool.videoUI.analysisFailed')); } });
  }, [intent, queryClient, doc, nodeId, t]);
  /**
   * Starts a frozen, idempotent scene analysis of the whole grid.
   * @throws {never} Failures are reported by the press.
   */
  const analyse = React.useCallback((): void => {
    const shownGrid = presentation?.grid ?? null;
    if (current === null || stale || disabled || presentation?.status !== 'ready' || shownGrid === null || presentation.sourceURL !== current.source.canonicalURL) return;
    const { presentationRef } = presentation;
    if (presentationRef === undefined) return;
    if (!change(current)) return;
    const held = readVideoToolDraft(doc, nodeId, toolId);
    if (held.state !== 'supported') return;
    startAnalysis({ analysisRunId: newId(), projectId, spaceId, hostNodeId: nodeId, draftId: held.draft.draftId, revision: held.draft.revision, source: held.draft.source, presentationRef,
      kind: 'scene_cuts', params: { range: { start: 0, end: shownGrid.frameCount } } });
  }, [current, stale, disabled, presentation, change, doc, nodeId, toolId, projectId, spaceId, startAnalysis]);
  React.useEffect(() => {
    if (toolId !== 'video.split' || current === null || disabled) return;
    for (const record of matchingRecords) if (record.kind === 'scene_cuts' && (record.status === 'pending' || record.status === 'running')) watchedSceneRuns.add(record.analysisRunId);
    const success = latestMiniToolAnalysis(matchingRecords.filter((record) => record.kind === 'scene_cuts' && record.status === 'completed' && record.result?.kind === 'scene_cuts'));
    if (success?.result?.kind !== 'scene_cuts') return;
    // The user's edit made while it ran wins; the result is said once, for a run this page saw running.
    if (commitVideoSceneAnalysis(doc, nodeId, success) === 'superseded' && watchedSceneRuns.delete(success.analysisRunId)) toast.info(t('canvas.miniTool.videoUI.detectionSuperseded'));
  }, [matchingRecords, current, disabled, toolId, doc, nodeId, t]);
  /**
   * Marks transient invalid text without putting it in the persisted schema.
   * @throws {never} Never.
   */
  const invalidChange = React.useCallback((key: string, invalid: boolean): void => {
    setInvalidFields((before) => { const next = new Set(before); if (invalid) next.add(key); else next.delete(key); return next.size === before.size && [...next].every((value) => before.has(value)) ? before : next; });
  }, []);
  useEscapeInSpace(pick === null, close);
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
  const spec = miniToolById(toolId);
  // The strip reads the actual presented frame itself while the source plays; the panel keeps its pause-and-seek cadence.
  const liveClock = React.useMemo(() => binding && presentation ? { element: binding.element, read: () => presentedTimeOf(presentation) } : undefined, [binding, presentation]);
  // A platform-funded tool costs the user nothing, so its footer says Free (frames-split §5.5).
  const platformFunded = miniToolChargeTo(toolId) === 'platform';
  const presentationFailure = presentation?.failure ?? null;
  if (spec === undefined) return null;
  // Until there is a draft the panel shows only why it waits, or the candidate's failure and its Retry (frames-split §7.12).
  if (current === null && source !== null && reading.state === 'absent') {
    const state = presentation?.panelState ?? 'waiting-presentation';
    return <NodePanelMount nodeId={nodeId}><div data-testid='video-tool-waiting' className='nowheel nodrag flex items-center justify-between gap-3 rounded-overlay border border-border bg-popover p-3'>
      <p className={state === 'waiting-presentation' ? 'text-xs text-muted-foreground' : 'text-xs text-status-error-foreground'}>{t(state === 'retryable' ? (presentation?.readFailed === true ? 'canvas.miniTool.videoUI.sourceUnavailable' : 'canvas.miniTool.videoUI.preparationFailed')
        : state === 'unsupported' ? (presentationFailure === 'too_long' ? 'canvas.miniTool.videoUI.tooLongToPrepare' : 'canvas.miniTool.videoUI.ledgerUnsupported') : 'canvas.miniTool.videoUI.preparingVideo')}</p>
      {state === 'retryable' && presentation?.onRetry !== undefined ? <Button variant='outline' size='compact' loading={presentation.retrying === true} onClick={presentation.onRetry}>{t('canvas.miniTool.videoUI.retryPreview')}</Button> : null}
    </div></NodePanelMount>;
  }
  if (current === null || source === null || current.source.canonicalURL !== source.canonicalURL) return <NodePanelMount nodeId={nodeId}><div className='nowheel nodrag rounded-overlay border border-border bg-popover p-3'><p className='text-xs'>{t(reading.state === 'unsupported' || reading.state === 'invalid' ? 'canvas.miniTool.videoUI.unsupportedDraft' : current !== null && source !== null ? 'canvas.miniTool.videoUI.sourceChanged' : 'canvas.miniTool.videoUI.sourceUnavailable')}</p>{source === null || disabled ? null : <Button variant='outline' size='sm' onClick={() => { store.getState().endPick(); store.getState().resetMiniToolSource(source.canonicalURL, {}); clearVideoToolDraft(doc, nodeId, toolId);
    // Without a selected version yet, the draft starts once one is (frames-split §7.13 absent × Open).
    if (selectedRef === undefined) initialized.current = false; else commitVideoToolDraft(doc, nodeId, toolId, createVideoToolDraft(toolId, source, selectedRef)); }}>{t(current !== null && source !== null ? 'canvas.miniTool.videoUI.useCurrentSource' : 'canvas.miniTool.videoUI.rebuildDraft')}</Button>}</div></NodePanelMount>;
  const shown = { state: presentation?.panelState ?? 'usable', retrying: presentation?.retrying === true, onRetry: presentation?.onRetry };
  const validSource = presentation?.status === 'ready' && presentation.sourceURL === source.canonicalURL && grid !== null && shown.state === 'usable';
  const selectedTime = presentedTimeOf(presentation);
  const needsCurrent = toolId === 'video.extract-frames' && (current as VideoToolDraftById['video.extract-frames']).params.mode === 'current';
  // Cuts at or past the grid's end belong to another version's grid; they are shown to adjust and never planned.
  const outsideCuts = toolId === 'video.split' && grid !== null ? cutsOutsideGrid(grid.frameCount, (current as VideoToolDraftById['video.split']).params.cuts) : [];
  // The planned split outputs while the frame table is usable, which the panel also states when over the cap (frames-split §10.7).
  const splitCount = toolId === 'video.split' && validSource && grid !== null && !stale && outsideCuts.length === 0 ? planVideoSplit(grid, (current as VideoToolDraftById['video.split']).params.cuts).length : null;
  const canRun = !readOnly && !stale && (!needsCurrent || selectedTime !== null) && validSource && invalidFields.size === 0 && onRunVideo !== undefined && (toolId !== 'video.split' || splitCount !== null);
  const splitOverCap = splitCount !== null && maxOutputs !== undefined && splitCount > maxOutputs;
  // The header counts the outputs a run plans (demo main.tsx): one per split segment, one for every other tool.
  const outputCount = toolId === 'video.split' ? splitCount ?? splitCuts(gridFrames ?? Infinity, (current as VideoToolDraftById['video.split']).params.cuts).length + 1 : 1;
  const header = <span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.outputCount', { count: outputCount })}</span>;
  // More planned outputs than one run creates are refused here, before any node is made (frames-split §10.7).
  const runBlockedReason = canRun && splitOverCap ? t('canvas.miniTool.videoUI.tooManyOutputs', { max: maxOutputs }) : undefined;
  /**
   * Binds the stale draft, values unchanged, to the selected version (frames-split §7.13 Rebind); a cut outside its grid
   * keeps the draft stale and says to adjust it first (demo decision D9).
   * @throws {never} Never.
   */
  function rebind(): void {
    if (current === null || !stale || selectedRef === undefined || readOnly) return;
    const gate = evaluateNodeGate({ locked: nodeDataMap(doc, nodeId)?.get('locked') === true });
    if (gate !== null) { toast.warning(t(gate.toastKey)); return; }
    if (outsideCuts.length > 0) { setOutsideFound(current.revision); toast.warning(t('canvas.miniTool.videoUI.settingsOutOfRange')); return; }
    rebindVideoToolDraft(doc, nodeId, toolId, selectedRef, current.revision);
  }
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
    return quoteFacts === null ? onRunVideo(nodeId, toolId, frozen, matchingRecords)
      : onRunVideo(nodeId, toolId, frozen, matchingRecords, { ...quoteFacts, outputNodeIds: quote.outputNodeIds });
  }
  return <NodePanelMount nodeId={nodeId}><MiniToolPanel titleIcon aside={header} spec={spec} modelControls={undefined} modelEntry={undefined} params={{}} onParams={() => undefined} source={{ url: source.canonicalURL, ...source.mediaInfo }} sizeTiers={[]} slots={{}} slotCaps={{}} pickingSlot={null} onPickSlot={() => undefined} onClearSlot={() => undefined} prompt='' onPrompt={() => undefined} creditText={platformFunded ? t('canvas.miniTool.panel.free') : costs?.execution ?? quote.text ?? ''} refusal={running ? 'exporting' : canRun ? null : 'slotMissing'} runBlockedReason={runBlockedReason} onRun={() => { void run(); }} onClose={close} customBody={<>{stale ? <div data-testid='video-tool-stale' className='flex items-center justify-between gap-3 rounded-chrome border border-border p-2 text-xs'><span>{t('canvas.miniTool.videoUI.videoUpdated')}</span><Button variant='outline' size='compact' disabled={readOnly || !validSource} onClick={rebind}>{t('canvas.miniTool.videoUI.applyToVideo')}</Button></div> : null}{analysisReadings.failed ? <div className='flex items-center justify-between gap-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.analysisFailed')}</span><Button variant='outline' size='compact' loading={analysisReadings.fetching} onClick={() => { for (const reference of refs) void queryClient.invalidateQueries({ queryKey: miniToolAnalysisQuery(reference.analysisRunId).queryKey }); }}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : null}<VideoToolControls toolId={toolId} draft={current} onChange={change} analyses={matchingRecords} grid={validSource ? grid : null} previewSource={presentation?.previewSource} presentedTime={selectedTime} liveClock={liveClock} disabled={disabled || !validSource && (toolId !== 'video.extract-frames' || reading.state === 'absent')} onAnalyse={analyse} analysing={analysing} analysisDisabled={stale} outsideMarked={outsideFound !== null && outsideFound === current.revision} analysisCreditText={costs?.analysis} onSeek={presentation?.onSeek} onPlayRange={presentation?.onPlayRange} sourceEpoch={presentation?.sourceEpoch ?? 0} seekEpoch={presentation?.seekEpoch ?? 0} onInvalidChange={invalidChange} />{invalidFields.size === 0 ? null : <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.invalidNumber')}</p>}{guard === null ? null : <p data-testid='video-tool-guard' className='text-xs text-status-error-foreground'>{guard}</p>}{splitOverCap ? <p data-testid='video-output-cap' className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.outputCapExceeded', { cap: maxOutputs, count: splitCount })}</p> : null}{validSource ? null : shown.state === 'retryable' || shown.retrying ? <div className='flex items-center justify-between gap-3 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground'><span>{t(presentation?.readFailed === true ? 'canvas.miniTool.videoUI.sourceUnavailable' : presentation?.status === 'failed' ? 'canvas.miniTool.videoUI.mediaError' : 'canvas.miniTool.videoUI.preparationFailed')}</span><Button variant='outline' size='compact' loading={shown.retrying} onClick={shown.onRetry}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : <p className={shown.state === 'unsupported' ? 'text-xs text-status-error-foreground' : 'text-xs text-muted-foreground'}>{t(shown.state === 'unsupported' ? (presentationFailure === 'too_long' ? 'canvas.miniTool.videoUI.tooLongToPrepare' : 'canvas.miniTool.videoUI.ledgerUnsupported') : presentation?.status === 'failed' ? 'canvas.miniTool.videoUI.mediaError' : 'canvas.miniTool.videoUI.preparingVideo')}</p>}</>} /></NodePanelMount>;
}
