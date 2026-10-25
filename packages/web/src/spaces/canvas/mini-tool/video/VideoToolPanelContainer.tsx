// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { MediaSurfaceBinding } from '@web/spaces/canvas/video-presentation/types';
import { useStore } from '@xyflow/react';
import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CANVAS_NODES_KEY, newId } from '@breatic/shared';
import { canonicalMiniToolValue, fingerprintMiniToolAnalysisInput, planVideoFrames, projectMiniToolAnalysisInput, videoToolAnalysisRefs, videoToolSourceRefSchema, selectMiniToolAnalyses, type MiniToolAnalysisKind, type MiniToolAnalysisRecord, type MiniToolAnalysisRequest, type VideoFrameTable, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
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
import { VideoToolControls } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import type { VideoTimelineDecoderRenderer } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';
import { VideoTimelineDialog } from '@web/spaces/canvas/mini-tool/video/VideoTimelineDialog';
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
  frameTable: VideoFrameTable | null;
  presentedTime: number;
  status: 'loading' | 'ready' | 'failed';
  sourceURL: string;
  sourceEpoch: number;
  seekEpoch: number;
  onSeek?: (time: number) => void;
}

export interface VideoToolCostText { execution: string; analysis?: string }

export interface VideoToolPanelContainerProps {
  /** Actual canonical display box supplied by the node's presentation owner. */
  overlayTarget?: HTMLElement | null;
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
  const [refs, setRefs] = React.useState<ReturnType<typeof videoToolAnalysisRefs>>([]);
  React.useEffect(() => {
    /**
     * Publishes accepted metadata independently of draft revisions.
     * @throws {never} Never.
     */
    function read(): void {
      const data = nodeDataMap(doc, nodeId);
      const found = videoToolAnalysisRefs(data === null ? {} : Object.fromEntries(data.entries()));
      setRefs((before) => canonicalMiniToolValue(before) === canonicalMiniToolValue(found) ? before : found);
    }
    read();
    doc.getMap(CANVAS_NODES_KEY).observeDeep(read);
    return () => doc.getMap(CANVAS_NODES_KEY).unobserveDeep(read);
  }, [doc, nodeId]);
  return refs;
}

/**
 * Edits the authoritative snapshot while panel and picker state remain transient.
 * @throws {Error} When a malformed supported draft is committed.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoToolPanelContainer(props: VideoToolPanelContainerProps): React.JSX.Element | null {
  const { nodeId, toolId, node, nodes, presentation, onRunVideo, costs, renderTimelineDecoder } = props;
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
    const parsed = videoToolSourceRefSchema.safeParse({ nodeId, canonicalURL: data.content, mediaInfo: { width: data.width, height: data.height, duration: data.duration, mimeType: data.mimeType } });
    return parsed.success ? parsed.data : null;
  }, [data, nodeId]);
  const initial = React.useMemo(() => {
    if (source === null) return null;
    const draft = createVideoToolDraft(toolId, source);
    return toolId === 'video.transitions' && typeof data.coverUrl === 'string' ? { ...draft, inputs: draft.inputs.map((input) => ({ ...input, cover: data.coverUrl as string })) } : draft;
  }, [toolId, source, data.coverUrl]);
  const current = reading.state === 'supported' ? reading.draft : reading.state === 'absent' ? initial : null;
  const [timelineOpen, setTimelineOpen] = React.useState(false);
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
    const frame = planVideoFrames(presentation.frameTable, { mode: 'current', currentTime: presentation.presentedTime })[0];
    if (frame === undefined) return;
    const anchor = { frameIndex: frame.frameIndex, pts: frame.pts };
    const frozen = kind === 'people' && toolId === 'video.lip-sync' ? { ...current, params: { ...(current as VideoToolDraftById['video.lip-sync']).params, anchor, dialogues: resetDialoguePeople((current as VideoToolDraftById['video.lip-sync']).params.dialogues) } } : kind === 'tracked_mask' ? { ...current, params: { ...(current as VideoToolDraftById['video.erase']).params, anchor } } : current;
    if (!change(frozen)) return;
    const held = readVideoToolDraft(doc, nodeId, toolId);
    if (held.state !== 'supported') return;
    const base = { analysisRunId: newId(), projectId, spaceId, hostNodeId: nodeId, draftId: held.draft.draftId, revision: held.draft.revision, source: held.draft.source };
    const request: MiniToolAnalysisRequest = kind === 'people' ? { ...base, kind, params: { anchor } } : kind === 'scene_cuts' ? { ...base, kind, params: { range: { start: 0, end: held.draft.source.mediaInfo.duration } } } : { ...base, kind, params: (held.draft as VideoToolDraftById['video.erase']).params };
    if (request.kind === 'tracked_mask') request.params = { range: request.params.range, anchor: request.params.anchor, region: request.params.region, trackingPrompt: request.params.trackingPrompt };
    void runOnce(intent, { scope: 'mini-tool', prepare: () => request, send: (key, body) => miniToolAnalysesApi.start(body, key), onDone: (record) => {
      queryClient.setQueryData(miniToolAnalysisQuery(record.analysisRunId).queryKey, record);
      const owner = record.kind === 'people' ? 'video.lip-sync' : record.kind === 'scene_cuts' ? 'video.split' : 'video.erase';
      commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: owner, kind: record.kind, draftId: record.draftId, analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint } as Parameters<typeof commitVideoToolAnalysisRef>[2]);
      return undefined;
    }, onFailure: () => toast.error(t('canvas.miniTool.videoUI.analysisFailed')) });
  }, [current, disabled, presentation, change, doc, nodeId, toolId, projectId, spaceId, intent, queryClient, t]);
  React.useEffect(() => {
    if (toolId !== 'video.lip-sync' || current === null || disabled || presentation?.status !== 'ready' || autoPeople.current === current.draftId || refs.some((reference) => reference.toolId === toolId && reference.draftId === current.draftId)) return;
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
  const validSource = presentation?.status === 'ready' && presentation.frameTable !== null && presentation.sourceURL === source.canonicalURL;
  const visiblePeople = latestMiniToolAnalysis(matchingRecords.filter((record) => record.kind === 'people' && record.status === 'completed' && !record.artifactUnavailable))?.result;
  const hasDialogue = toolId !== 'video.lip-sync' || (current as VideoToolDraftById['video.lip-sync']).params.dialogues.length > 0 && (current as VideoToolDraftById['video.lip-sync']).params.dialogues.every((row) => row.audioInputId !== null && visiblePeople?.kind === 'people' && row.analysisRunId === visiblePeople.analysisRunId && visiblePeople.people.some((person) => person.personId === row.personId));
  const readyTool = toolId === 'video.expand' ? isExpanded((current as VideoToolDraftById['video.expand']).params.frame, current.source.mediaInfo) : toolId === 'video.erase' ? matchingRecords.some((record) => record.kind === 'tracked_mask' && record.status === 'completed' && !record.artifactUnavailable) : toolId === 'video.transitions' ? (current as VideoToolDraftById['video.transitions']).params.clips.length > 0 : true;
  const canRun = !readOnly && validSource && invalidFields.size === 0 && hasDialogue && readyTool && onRunVideo !== undefined;
  /**
   * Freezes exactly the visible source frame at the press before execution.
   * @throws {never} The execution callback owns request failures.
   */
  function run(): void {
    if (!canRun || onRunVideo === undefined) return;
    const gate = evaluateNodeGate({ locked: nodeDataMap(doc, nodeId)?.get('locked') === true });
    if (gate !== null) { toast.warning(t(gate.toastKey)); return; }
    store.getState().endPick();
    if (current === null) return;
    let frozen: VideoToolDraft = current;
    if (toolId === 'video.extract-frames' && presentation !== undefined) {
      const frames = current as VideoToolDraftById['video.extract-frames'];
      const next = { ...frames, params: { ...frames.params, currentTime: presentation.presentedTime } };
      if (!change(next)) return;
      const committed = readVideoToolDraft(doc, nodeId, toolId);
      if (committed.state !== 'supported') return;
      frozen = committed.draft;
    }
    void onRunVideo(nodeId, toolId, frozen, matchingRecords);
  }
  return <><NodePanelMount nodeId={nodeId} drop={drop}><MiniToolPanel customWide={toolId === 'video.lip-sync'} spec={spec} modelControls={undefined} modelEntry={undefined} params={{}} onParams={() => undefined} source={{ url: source.canonicalURL, ...source.mediaInfo }} sizeTiers={[]} slots={{}} slotCaps={{}} pickingSlot={null} onPickSlot={() => undefined} onClearSlot={() => undefined} prompt='' onPrompt={() => undefined} creditText={costs?.execution ?? t(toolId === 'video.extract-frames' || toolId === 'video.transitions' || toolId === 'video.split' ? 'canvas.miniTool.panel.free' : 'canvas.miniTool.panel.usage')} refusal={running ? 'exporting' : canRun ? null : 'slotMissing'} onRun={run} onClose={close} customBody={<>{analysisReadings.failed ? <div className='flex items-center justify-between gap-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.analysisFailed')}</span><Button variant='outline' size='compact' loading={analysisReadings.fetching} onClick={() => { for (const reference of refs) void queryClient.invalidateQueries({ queryKey: miniToolAnalysisQuery(reference.analysisRunId).queryKey }); }}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : null}<VideoToolControls toolId={toolId} draft={current} onChange={change} analyses={matchingRecords} frameTable={validSource ? presentation.frameTable : null} presentedTime={presentation?.presentedTime ?? 0} disabled={disabled} pickingSlot={pick?.purpose === 'miniToolSlot' ? pick.slotKey ?? null : null} inputNames={names} onPick={(key) => { if (disabled) return; if (pick?.purpose === 'miniToolSlot' && pick.slotKey === key) store.getState().endPick(); else store.getState().startMiniToolSlotPick(nodeId, key); }} onAnalyse={analyse} analysing={analysing} analysisCreditText={costs?.analysis} onSeek={presentation?.onSeek} sourceEpoch={presentation?.sourceEpoch ?? 0} seekEpoch={presentation?.seekEpoch ?? 0} onEditTimeline={() => setTimelineOpen(true)} onInvalidChange={invalidChange} regionSelection={session?.params.videoRegionMode === 'point' ? 'point' : 'rectangle'} onRegionSelection={(mode) => store.getState().setMiniToolParam('videoRegionMode', mode)} onEndPick={() => store.getState().endPick()} onActiveDialogue={(id) => store.getState().setMiniToolParam('activeDialogueId', id)} />{invalidFields.size === 0 ? null : <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.invalidNumber')}</p>}{validSource ? null : <p className='text-xs text-muted-foreground'>{t(presentation?.status === 'failed' ? 'canvas.miniTool.videoUI.mediaError' : 'canvas.miniTool.videoUI.loadingFrames')}</p>}</>} /></NodePanelMount>{toolId === 'video.transitions' ? <VideoTimelineDialog renderDecoder={renderTimelineDecoder} open={timelineOpen} onOpenChange={setTimelineOpen} draft={current as VideoToolDraftById['video.transitions']} onChange={change} inputNames={names} disabled={disabled} onRun={run} /> : null}</>;
}
