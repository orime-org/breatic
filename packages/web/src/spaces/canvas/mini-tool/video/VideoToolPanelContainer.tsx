// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { createPortal } from 'react-dom';
import { VideoToolNodeOverlay } from '@web/spaces/canvas/mini-tool/video/VideoToolNodeOverlay';
import type { PresentedMediaFrame, MediaSurfaceBinding, VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import type { VideoToolPanelState } from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import { useStore } from '@xyflow/react';
import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CANVAS_NODES_KEY, newId, type VideoPresentationSourceBinding } from '@breatic/shared';
import { canonicalMiniToolValue, fingerprintMiniToolAnalysisInput, lipsyncTimeline, lipsyncUsedSourceRange, planVideoFrames, presentationFrameAt, presentationVideoEnd, type LipsyncFailureReason, projectMiniToolAnalysisInput, videoToolAnalysisRefs, videoToolSourceRefSchema, selectMiniToolAnalyses, type MiniToolAnalysisKind, type MiniToolAnalysisRecord, type MiniToolAnalysisRequest, type VideoPresentationTable, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { miniToolAnalysesApi, miniToolAnalysisQuery, latestMiniToolAnalysis } from '@web/data/api/mini-tool-analyses';
import { docName, getDoc } from '@web/data/yjs/manager';
import { nodeDataMap, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoSceneAnalysis, commitVideoToolAnalysisRef, commitVideoToolDraft, clearVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { useVideoToolDraft } from '@web/data/yjs/use-video-tool-draft';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useMiniToolRunning } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { MiniToolPanel } from '@web/spaces/canvas/mini-tool/MiniToolPanel';
import { NodePanelMount } from '@web/spaces/canvas/_shared/NodePanelMount';
import { useCanvasContext, useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { expandDrop, isExpanded } from '@web/spaces/canvas/mini-tool/expand-frame';
import { createVideoToolDraft, resetDialoguePeople } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import { VideoToolControls, type LipSyncChoices } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import type { VideoTimelineDecoderRenderer } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';
import { VideoTimelineDialog } from '@web/spaces/canvas/mini-tool/video/VideoTimelineDialog';
import { useVideoToolModels } from '@web/spaces/canvas/mini-tool/video/use-video-tool-models';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { sourceLedgerQuery } from '@web/spaces/canvas/video-presentation/source-ledger-query';
import { useEscapeInSpace } from '@web/spaces/canvas/use-escape-in-space';
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
  /** The selected version's tool input, named by every analysis and run of this source (§7.11, §10.8). */
  presentationRef?: MiniToolAnalysisRequest['presentationRef'];
  retrying?: boolean;
  onRetry?: () => void;
  previewSource?: VideoPresentationSource | null;
  frameTable: VideoPresentationTable | null;
  presentedTime: number | null;
  /** Reads the owner's current frame at a press, independently of React preview cadence. */
  getPresentedFrame?: () => PresentedMediaFrame | null;
  status: 'loading' | 'ready' | 'failed';
  sourceURL: string;
  sourceEpoch: number;
  seekEpoch: number;
  onSeek?: (time: number) => void;
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
  onRunVideo?: (nodeId: string, toolId: VideoToolId, draft: VideoToolDraft, analyses: readonly MiniToolAnalysisRecord[]) => Promise<unknown>;
  /** The lip-sync models to choose from and the tracking range (config `executions.video.lip-sync`). */
  lipSync?: LipSyncChoices;
  /** Why this node's last lip-sync run failed. */
  lipSyncFailure?: LipsyncFailureReason | null;
  /** Retries that run's failed items. */
  onRetryFailed?: () => void;
}

/**
 * Why a complete lip-sync draft cannot run with the chosen model (canvas design §4 lip-sync row, execution design §9.3): its
 * result lasts outside the model's range, or the source range it uses lies outside the tracking model's, as admission judges.
 * @param draft - The draft, every row bound.
 * @param table - The source's presentation table.
 * @param lipSync - The configured models and tracking range.
 * @param t - The translator.
 * @returns The message naming the range, or undefined when the run fits or cannot be measured yet.
 * @throws {never} Never.
 */
function lipSyncRangeBlock(draft: VideoToolDraftById['video.lip-sync'], table: VideoPresentationTable, lipSync: LipSyncChoices, t: (key: string, params?: Record<string, string | number>) => string): string | undefined {
  const model = lipSync.models.find((entry) => entry.name === (draft.params.modelId ?? lipSync.models[0]?.name));
  if (model === undefined) return undefined;
  const dialogues = draft.params.dialogues.flatMap((row) => {
    const duration = draft.inputs.find((input) => input.inputId === row.audioInputId)?.mediaInfo?.duration;
    return row.personId === null || row.audioInputId === null || duration === undefined ? [] : [{ dialogueId: row.dialogueId, personId: row.personId, audioInputId: row.audioInputId, startTime: row.startTime, duration }];
  });
  if (dialogues.length !== draft.params.dialogues.length) return undefined;
  let timeline: ReturnType<typeof lipsyncTimeline>;
  let windowEnd: number;
  try {
    timeline = lipsyncTimeline({ videoDuration: presentationVideoEnd(table), dialogues, syncMode: draft.params.syncMode });
    windowEnd = presentationFrameAt(table, draft.params.anchor.frameIndex).displayEnd;
  } catch {
    // An unmeasurable draft is refused by admission with its own reason.
    return undefined;
  }
  if (timeline.duration < model.min_duration_seconds || timeline.duration > model.max_duration_seconds) {
    return t('canvas.miniTool.videoUI.lipSyncDurationRange', { min: model.min_duration_seconds, max: model.max_duration_seconds, duration: timeline.duration });
  }
  const used = lipsyncUsedSourceRange(timeline, [{ time: draft.params.anchor.pts, windowEnd }]);
  const length = used.end - used.start;
  if (length < lipSync.tracking.min_duration_seconds || length > lipSync.tracking.max_duration_seconds) {
    return t('canvas.miniTool.videoUI.lipSyncTrackingRange', { min: lipSync.tracking.min_duration_seconds, max: lipSync.tracking.max_duration_seconds, length });
  }
  return undefined;
}

const NO_INPUTS: readonly VideoToolDraft['inputs'][number][] = [];

/**
 * Each transition input's selected compact table (§97 D10-3, D13-1): every clip reads its frame rate off the table of the
 * version its own node presents, read the way the host's is.
 * @param projectId - The Project.
 * @param inputs - The transitions draft's inputs, or none for another tool.
 * @returns The tables read so far, by input id.
 * @throws {never} Never.
 */
function useInputTables(projectId: string, inputs: readonly VideoToolDraft['inputs'][number][]): ReadonlyMap<string, VideoPresentationTable> {
  const urls = React.useMemo(() => [...new Set(inputs.map((input) => input.url))], [inputs]);
  const responses = useQueries({ queries: urls.map((url) => videoPresentationQuery({ projectId, canonicalURL: url, active: true })), combine: dataOf });
  const read = React.useMemo(() => urls.flatMap((url, at) => (responses[at] === undefined ? [] : [{ url, response: responses[at] }])), [urls, responses]);
  const tables = useQueries({ queries: read.map(({ response }) => sourceLedgerQuery({ projectId, response, active: true })), combine: dataOf });
  return React.useMemo(() => {
    const byURL = new Map(read.flatMap(({ url }, at) => (tables[at] === undefined ? [] : [[url, tables[at]] as const])));
    return new Map(inputs.flatMap((input) => { const table = byURL.get(input.url); return table === undefined ? [] : [[input.inputId, table] as const]; }));
  }, [inputs, read, tables]);
}

/**
 * The data of each query, structurally shared by React Query so an unchanged read keeps its identity.
 * @param results - The query results.
 * @returns Their data.
 * @throws {never} Never.
 */
function dataOf<T>(results: readonly { data: T | undefined }[]): (T | undefined)[] {
  return results.map((result) => result.data);
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
  const { projectId, spaceId, readOnly } = useCanvasContext();
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
      width: registered?.width ?? binding?.original.width ?? data.width,
      height: registered?.height ?? binding?.original.height ?? data.height,
      duration: registered?.duration ?? binding?.original.duration ?? data.duration,
      mimeType: registered?.mimeType ?? data.mimeType,
    } });
    return parsed.success ? parsed.data : null;
  }, [data, nodeId, sourceBinding, binding]);
  const initial = React.useMemo(() => {
    if (source === null) return null;
    const draft = createVideoToolDraft(toolId, source);
    return toolId === 'video.transitions' && typeof data.coverUrl === 'string' ? { ...draft, inputs: draft.inputs.map((input) => ({ ...input, cover: data.coverUrl as string })) } : draft;
  }, [toolId, source, data.coverUrl]);
  const current = reading.state === 'supported' ? reading.draft : reading.state === 'absent' ? initial : null;
  // The configured models, the footer estimate and the last lip-sync failure; a caller's own values win (tests, stories).
  const models = useVideoToolModels({ projectId, spaceId, nodeId, toolId, draft: current, nodes });
  const lipSync = props.lipSync ?? models.lipSync;
  const lipSyncFailure = props.lipSyncFailure ?? models.lipSyncFailure;
  const onRetryFailed = props.onRetryFailed ?? models.onRetryFailed;
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  const inputTables = useInputTables(projectId, toolId === 'video.transitions' && current !== null ? current.inputs : NO_INPUTS);
  const [invalidFields, setInvalidFields] = React.useState<ReadonlySet<string>>(new Set());
  const refs = useAnalysisRefs(projectId, spaceId, nodeId);
  const queryClient = useQueryClient();
  const analysisReadings = useQueries({ queries: refs.filter((reference) => reference.toolId === toolId && reference.draftId === current?.draftId).map((reference) => ({ ...miniToolAnalysisQuery(reference.analysisRunId), refetchOnMount: 'always' as const })), combine: analysisRecords });
  const records = analysisReadings.records;
  const dependencyParams = current === null ? null : toolId === 'video.lip-sync' ? { anchor: (current as VideoToolDraftById['video.lip-sync']).params.anchor } : toolId === 'video.erase' ? { range: (current as VideoToolDraftById['video.erase']).params.range, anchor: (current as VideoToolDraftById['video.erase']).params.anchor, region: (current as VideoToolDraftById['video.erase']).params.region, trackingPrompt: (current as VideoToolDraftById['video.erase']).params.trackingPrompt } : { range: { start: 0, end: current.source.mediaInfo.duration } };
  const dependencyKey = current === null ? '' : canonicalMiniToolValue({ draftId: current.draftId, source: current.source, params: dependencyParams, profile: latestMiniToolAnalysis(records)?.analysisInput.profile ?? null });
  const [selection, setSelection] = React.useState<{ key: string; records: MiniToolAnalysisRecord[] }>({ key: '', records: [] });
  const matchingRecords = React.useMemo(() => selection.key === dependencyKey ? selection.records : [], [selection, dependencyKey]);
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
    const latest = latestMiniToolAnalysis(records);
    if (latest === null) { setSelection({ key: dependencyKey, records: [] }); return undefined; }
    const params = latest.kind === 'scene_cuts' ? { range: { start: 0, end: current.source.mediaInfo.duration } } : current.params;
    const input = projectMiniToolAnalysisInput({ kind: latest.kind, source: current.source, params, profile: latest.analysisInput.profile });
    void fingerprintMiniToolAnalysisInput(input).then((fingerprint) => {
      if (!active) return;
      const query = { draftId: current.draftId, kind: latest.kind, inputFingerprint: fingerprint, references: refs };
      setSelection({ key: dependencyKey, records: records.filter((record) => selectMiniToolAnalyses([record], query).latestAccepted !== null) });
    }, () => { if (active) setSelection({ key: dependencyKey, records: [] }); });

    return () => { active = false; };
  }, [records, current, dependencyKey, refs]);
  const locked = evaluateNodeGate({ locked: node.data.locked ?? false });
  const disabled = readOnly || locked !== null;
  const initialized = React.useRef(false);
  React.useEffect(() => {
    if (initialized.current) return;
    if (reading.state === 'absent' && initial !== null && !disabled) { initialized.current = true; commitVideoToolDraft(doc, nodeId, toolId, initial); }
  }, [reading.state, initial, disabled, doc, nodeId, toolId]);
  /**
   * Rechecks the current gate and publishes one complete atomic edit.
   * @throws {Error} When the changed snapshot fails its tool schema.
   * @param next - The complete next snapshot or sequence.
   * @returns Whether the current authoritative revision accepted the edit.
   */
  const change = React.useCallback((next: VideoToolDraft): boolean => {
    if (readOnly) return false;
    const gate = evaluateNodeGate({ locked: nodeDataMap(doc, nodeId)?.get('locked') === true });
    if (gate !== null) { toast.warning(t(gate.toastKey)); return false; }
    const latest = readVideoToolDraft(doc, nodeId, toolId);
    if (latest.state === 'supported') { if (next.draftId !== latest.draft.draftId || next.revision !== latest.draft.revision) return false; }
    else if (latest.state !== 'absent' || initial === null || next.draftId !== initial.draftId || next.revision !== initial.revision) return false;
    return commitVideoToolDraft(doc, nodeId, toolId, { ...next, revision: newId() });
  }, [readOnly, t, doc, nodeId, toolId, initial]);
  const expanded = current !== null && toolId === 'video.expand' ? current as VideoToolDraftById['video.expand'] : null;
  React.useEffect(() => {
    if (expanded === null) return;
    const active = store.getState().miniTool;
    if (active?.toolId !== 'video.expand') return;
    store.getState().setMiniToolSourceSize(expanded.source.mediaInfo);
    store.getState().setExpand({ frame: expanded.params.frame, ratio: expanded.params.ratio });
  }, [expanded, store]);
  const slots = session?.slots;
  React.useEffect(() => {
    if (current === null || slots === undefined || disabled) return;
    for (const [key, held] of Object.entries(slots)) {
      if (held === undefined || Array.isArray(held)) continue;
      const value = held as { url: string; cover?: string; duration?: number };
      const copiedNode = nodes.find((candidate) => 'content' in candidate.data && candidate.data.content === value.url);
      const inputId = newId();
      const copied = { inputId, url: value.url, ...(value.cover === undefined ? {} : { cover: value.cover }), ...(value.duration === undefined ? {} : { mediaInfo: { duration: value.duration } }), ...(copiedNode === undefined ? {} : { sourceNodeId: copiedNode.id }) };
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
        if (!change({ ...draft, inputs: [...draft.inputs, copied], params: { clips: value.duration === undefined ? draft.params.clips : [...draft.params.clips, { clipId: newId(), inputId, in: 0, out: value.duration, transition: { kind: 'cut', duration: 0 } }] } })) continue;
      }
      store.getState().clearMiniToolSlot(key);
    }
  }, [slots, current, disabled, nodes, toolId, change, store]);
  const intent = `video-analysis:${projectId}:${spaceId}:${nodeId}:${toolId}`;
  const analysisPressRunning = Boolean(useRunning(intent));
  const analysing = analysisPressRunning || analysisReadings.pending || matchingRecords.some((record) => record.status === 'pending' || record.status === 'running');
  const autoPeople = React.useRef<string | null>(null);
  const running = useMiniToolRunning(spaceId, nodeId, toolId);
  /**
   * Starts a frozen, idempotent server analysis using the presented source frame.
   * @throws {never} Failures are reported by the press.
   * @param kind - The requested source analysis.
   */
  const analyse = React.useCallback((kind: MiniToolAnalysisKind): void => {
    if (current === null || disabled || presentation?.status !== 'ready' || presentation.frameTable === null || presentation.sourceURL !== current.source.canonicalURL) return;
    const { presentationRef } = presentation;
    if (presentationRef === undefined) return;
    const actualTime = presentedTimeOf(presentation);
    if (kind !== 'scene_cuts' && actualTime === null) return;
    const frame = actualTime === null ? undefined : planVideoFrames(presentation.frameTable, { mode: 'current', currentTime: actualTime })[0];
    if (kind !== 'scene_cuts' && frame === undefined) return;
    const anchor = frame === undefined ? undefined : { frameIndex: frame.frameIndex, pts: frame.pts };
    const frozen = kind === 'people' && toolId === 'video.lip-sync' ? { ...current, params: { ...(current as VideoToolDraftById['video.lip-sync']).params, anchor: anchor!, dialogues: resetDialoguePeople((current as VideoToolDraftById['video.lip-sync']).params.dialogues) } } : kind === 'tracked_mask' ? { ...current, params: { ...(current as VideoToolDraftById['video.erase']).params, anchor: anchor! } } : current;
    if (!change(frozen)) return;
    const held = readVideoToolDraft(doc, nodeId, toolId);
    if (held.state !== 'supported') return;
    const base = { analysisRunId: newId(), projectId, spaceId, hostNodeId: nodeId, draftId: held.draft.draftId, revision: held.draft.revision, source: held.draft.source, presentationRef };
    const request: MiniToolAnalysisRequest = kind === 'people' ? { ...base, kind, params: { anchor: anchor! } } : kind === 'scene_cuts' ? { ...base, kind, params: { range: { start: 0, end: held.draft.source.mediaInfo.duration } } } : { ...base, kind, params: (held.draft as VideoToolDraftById['video.erase']).params };
    if (request.kind === 'tracked_mask') request.params = { range: request.params.range, anchor: request.params.anchor, region: request.params.region, trackingPrompt: request.params.trackingPrompt };
    void runOnce(intent, { scope: 'mini-tool', prepare: () => request, send: (key, body) => miniToolAnalysesApi.start(body, key), onDone: (record) => {
      queryClient.setQueryData(miniToolAnalysisQuery(record.analysisRunId).queryKey, record);
      const owner = record.kind === 'people' ? 'video.lip-sync' : record.kind === 'scene_cuts' ? 'video.split' : 'video.erase';
      commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: owner, kind: record.kind, draftId: record.draftId, analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint } as Parameters<typeof commitVideoToolAnalysisRef>[2]);
      return undefined;
    }, onFailure: () => { toast.error(t('canvas.miniTool.videoUI.analysisFailed')); } });
  }, [current, disabled, presentation, change, doc, nodeId, toolId, projectId, spaceId, intent, queryClient, t]);
  React.useEffect(() => {
    if (toolId !== 'video.lip-sync' || current === null || disabled || presentation?.status !== 'ready' || presentation.frameTable === null || autoPeople.current === current.draftId || refs.some((reference) => reference.toolId === toolId && reference.draftId === current.draftId)) return;
    autoPeople.current = current.draftId;
    analyse('people');
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
  const spec = miniToolById(toolId);
  if (spec === undefined) return null;
  if (current === null || source === null || current.source.canonicalURL !== source.canonicalURL) return <NodePanelMount nodeId={nodeId}><div className='nowheel nodrag rounded-overlay border border-border bg-popover p-3'><p className='text-xs'>{t(reading.state === 'unsupported' || reading.state === 'invalid' ? 'canvas.miniTool.videoUI.unsupportedDraft' : current !== null && source !== null ? 'canvas.miniTool.videoUI.sourceChanged' : 'canvas.miniTool.videoUI.sourceUnavailable')}</p>{source === null || disabled ? null : <Button variant='outline' size='sm' onClick={() => { store.getState().endPick(); store.getState().resetMiniToolSource(source.canonicalURL, {}); clearVideoToolDraft(doc, nodeId, toolId); commitVideoToolDraft(doc, nodeId, toolId, createVideoToolDraft(toolId, source)); }}>{t(current !== null && source !== null ? 'canvas.miniTool.videoUI.useCurrentSource' : 'canvas.miniTool.videoUI.rebuildDraft')}</Button>}</div></NodePanelMount>;
  const names = new Map(current.inputs.map((input) => [input.inputId, nodes.filter((candidate) => 'content' in candidate.data && candidate.data.content === input.url).map((candidate) => ({ id: candidate.id, name: 'name' in candidate.data ? candidate.data.name : undefined })).find((candidate) => candidate.id === input.sourceNodeId)?.name ?? input.url.split('/').at(-1) ?? '']));
  const validSource = presentation?.status === 'ready' && presentation.sourceURL === source.canonicalURL && (toolId === 'video.remove-bg' || presentation.frameTable !== null && (presentation.panelState === undefined || presentation.panelState === 'usable'));
  const visiblePeople = latestMiniToolAnalysis(matchingRecords.filter((record) => record.kind === 'people' && record.status === 'completed' && !record.artifactUnavailable))?.result;
  const hasDialogue = toolId !== 'video.lip-sync' || (current as VideoToolDraftById['video.lip-sync']).params.dialogues.length > 0 && (current as VideoToolDraftById['video.lip-sync']).params.dialogues.every((row) => row.audioInputId !== null && visiblePeople?.kind === 'people' && row.analysisRunId === visiblePeople.analysisRunId && visiblePeople.people.some((person) => person.personId === row.personId));
  const readyTool = toolId === 'video.expand' ? isExpanded((current as VideoToolDraftById['video.expand']).params.frame, current.source.mediaInfo) : toolId === 'video.erase' ? matchingRecords.some((record) => record.kind === 'tracked_mask' && record.status === 'completed' && !record.artifactUnavailable) : toolId === 'video.transitions' ? (current as VideoToolDraftById['video.transitions']).params.clips.length === 2 : true;
  const selectedTime = presentedTimeOf(presentation);
  const needsCurrent = toolId === 'video.extract-frames' && (current as VideoToolDraftById['video.extract-frames']).params.mode === 'current';
  const canRun = !readOnly && (!needsCurrent || selectedTime !== null) && validSource && invalidFields.size === 0 && hasDialogue && readyTool && onRunVideo !== undefined;
  // What Export says while Run cannot run (canvas design §10 editor × export): the condition the panel is waiting on.
  const exportBlockedReason = canRun || readOnly ? undefined : !validSource ? t('canvas.miniTool.panel.sourceMissing')
    : invalidFields.size > 0 ? t('canvas.miniTool.videoUI.invalidNumber') : !readyTool ? t('canvas.miniTool.videoUI.pickVideo') : t('canvas.miniTool.panel.sourceMissing');
  const runBlockedReason = canRun && toolId === 'video.lip-sync' && lipSync !== undefined && presentation.frameTable !== null
    ? lipSyncRangeBlock(current as VideoToolDraftById['video.lip-sync'], presentation.frameTable, lipSync, t) : undefined;
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
      if (actualTime === null) return undefined;
      const frames = current as VideoToolDraftById['video.extract-frames'];
      const next = { ...frames, params: { ...frames.params, currentTime: actualTime } };
      if (!change(next)) return undefined;
      const committed = readVideoToolDraft(doc, nodeId, toolId);
      if (committed.state !== 'supported') return undefined;
      frozen = committed.draft;
    }
    return onRunVideo(nodeId, toolId, frozen, matchingRecords);
  }
  const activeRow = toolId === 'video.lip-sync' ? (current as VideoToolDraftById['video.lip-sync']).params.dialogues.find((row) => row.dialogueId === session?.params.activeDialogueId) : undefined;
  const frame = binding?.getPresentedFrame() ?? null;
  const currentFrame = frame !== null && frame.sourceKey === binding?.sourceKey && frame.sourceEpoch === binding.sourceEpoch && frame.seekEpoch === binding.getSeekEpoch();
  const overlay = overlayTarget && binding && (toolId === 'video.erase' || toolId === 'video.lip-sync') ? createPortal(<VideoToolNodeOverlay
    region={toolId === 'video.erase' ? (current as VideoToolDraftById['video.erase']).params.region : undefined}
    selection={session?.params.videoRegionMode === 'point' ? 'point' : 'rectangle'}
    people={visiblePeople?.kind === 'people' ? visiblePeople : undefined}
    activePersonId={activeRow?.personId}
    onRegion={(region) => { if (toolId === 'video.erase') change({ ...current as VideoToolDraftById['video.erase'], params: { ...(current as VideoToolDraftById['video.erase']).params, region } }); }}
    onPerson={(personId) => {
      if (toolId !== 'video.lip-sync' || visiblePeople?.kind !== 'people') return;
      const draft = current as VideoToolDraftById['video.lip-sync'];
      const id = activeRow?.dialogueId ?? draft.params.dialogues[0]?.dialogueId;
      if (id !== undefined) change({ ...draft, params: { ...draft.params, dialogues: draft.params.dialogues.map((row) => row.dialogueId === id ? { ...row, personId, analysisRunId: visiblePeople.analysisRunId } : row) } });
    }}
    disabled={disabled || !currentFrame}
    revision={current.revision} sourceEpoch={binding.sourceEpoch} seekEpoch={binding.getSeekEpoch()}
  />, overlayTarget) : null;
  return <>{overlay}<NodePanelMount nodeId={nodeId} drop={drop}><MiniToolPanel customWide={toolId === 'video.lip-sync'} spec={spec} modelControls={undefined} modelEntry={undefined} params={{}} onParams={() => undefined} source={{ url: source.canonicalURL, ...source.mediaInfo }} sizeTiers={[]} slots={{}} slotCaps={{}} pickingSlot={null} onPickSlot={() => undefined} onClearSlot={() => undefined} prompt='' onPrompt={() => undefined} creditText={costs?.execution ?? (toolId === 'video.extract-frames' || toolId === 'video.transitions' || toolId === 'video.split' ? t('canvas.miniTool.panel.free') : models.estimate ?? '')} refusal={running ? 'exporting' : canRun ? null : 'slotMissing'} runBlockedReason={runBlockedReason} onRun={() => { void run(); }} onClose={close} customBody={<>{analysisReadings.failed ? <div className='flex items-center justify-between gap-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.analysisFailed')}</span><Button variant='outline' size='compact' loading={analysisReadings.fetching} onClick={() => { for (const reference of refs) void queryClient.invalidateQueries({ queryKey: miniToolAnalysisQuery(reference.analysisRunId).queryKey }); }}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : null}<VideoToolControls toolId={toolId} draft={current} onChange={change} analyses={matchingRecords} frameTable={validSource ? presentation.frameTable : null} previewSource={presentation?.previewSource} presentedTime={selectedTime} disabled={disabled || !validSource} pickingSlot={pick?.purpose === 'miniToolSlot' ? pick.slotKey ?? null : null} inputNames={names} onPick={(key) => { if (disabled) return; if (pick?.purpose === 'miniToolSlot' && pick.slotKey === key) store.getState().endPick(); else store.getState().startMiniToolSlotPick(nodeId, key); }} onAnalyse={analyse} analysing={analysing} analysisCreditText={costs?.analysis} analysisActualCreditText={costs?.analysisActual} onSeek={presentation?.onSeek} sourceEpoch={presentation?.sourceEpoch ?? 0} seekEpoch={presentation?.seekEpoch ?? 0} onEditTimeline={() => setTimelineOpen(true)} onInvalidChange={invalidChange} regionSelection={session?.params.videoRegionMode === 'point' ? 'point' : 'rectangle'} onRegionSelection={(mode) => store.getState().setMiniToolParam('videoRegionMode', mode)} onEndPick={() => store.getState().endPick()} onActiveDialogue={(id) => store.getState().setMiniToolParam('activeDialogueId', id)} lipSync={lipSync} lipSyncFailure={lipSyncFailure} onRetryFailed={onRetryFailed} />{invalidFields.size === 0 ? null : <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.invalidNumber')}</p>}{validSource ? null : presentation?.panelState === 'retryable' || presentation?.retrying ? <div className='flex items-center justify-between gap-3 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.mediaError')}</span><Button variant='outline' size='compact' loading={presentation.retrying} onClick={presentation.onRetry}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : <p className={presentation?.panelState === 'unsupported' ? 'text-xs text-status-error-foreground' : 'text-xs text-muted-foreground'}>{t(presentation?.panelState === 'unsupported' ? 'canvas.miniTool.videoUI.ledgerUnsupported' : presentation?.status === 'failed' ? 'canvas.miniTool.videoUI.mediaError' : 'canvas.miniTool.videoUI.loadingFrames')}</p>}</>} /></NodePanelMount>{toolId === 'video.transitions' ? <VideoTimelineDialog renderDecoder={renderTimelineDecoder} open={timelineOpen} onOpenChange={setTimelineOpen} draft={current as VideoToolDraftById['video.transitions']} onChange={change} inputNames={names} disabled={disabled} onRun={run} runBlockedReason={exportBlockedReason} inputTables={inputTables} /> : null}</>;
}
