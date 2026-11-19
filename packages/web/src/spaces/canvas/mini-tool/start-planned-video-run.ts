// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { newId, t } from '@breatic/shared';
import { miniToolById, miniToolPlannedRequestSchema, planVideoFrames, planVideoSplit, videoExpandLayout, videoToolDraftSchema, type MiniToolAnalysisRecord, type MiniToolExecutionRetryRequest, type MiniToolPlannedRequest, type VideoPresentationTable, type VideoToolAnalysisRef, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { miniToolsApi, type MiniToolPlannedRunAnswer } from '@web/data/api/mini-tools';
import { ApiException } from '@web/data/api/types';
import { addEdge, addNode, nodeDataMap, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { toast } from '@web/lib/toast';
import { createEmptyNode } from '@web/spaces/canvas/node-factory';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { plannedOutputPlacementOf } from '@web/spaces/canvas/mini-tool/planned-output-placement';
import { miniToolIntent } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import type { MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { runOnce, type RunOnceOutcome } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore, type UploadMarkMessage } from '@web/stores/upload-marks';

/** One press's existing Canvas capabilities and complete typed video snapshot. */
export interface PlannedVideoRun extends Pick<MiniToolRun, 'projectId' | 'spaceId' | 'userId' | 'source' | 'sourceExists' | 'stillOpen' | 'onBuilt'> {
  toolId: VideoToolId;
  draft: VideoToolDraft;
  analyses: readonly MiniToolAnalysisRecord[];
  /** The selected version of each input, frozen at the press (§10.8 request row). */
  presentationRef: MiniToolPlannedRequest['presentation_ref'];
  canWrite: () => boolean;
  /** The quoted press's analysis refs and output node ids (§97 D27-1); a run without a quote names new nodes. */
  plan?: Pick<PlannedVideoPress, 'analysisRefs' | 'outputNodeIds'>;
  /** The source's compact presentation table, which frames and split plan their outputs from; null while not read. */
  frameTable?: VideoPresentationTable | null;
  /** The selected version's display size, which an expansion's node is sized on as admission sizes it (§10.5). */
  display?: { width: number; height: number };
}

/**
 * The one press intent of retrying a planned run's failed output, shared by the output node's task panel and the host's tool
 * panel, so a retry waiting in either shows on both and is never sent twice.
 * @param runId - The failed run.
 * @param outputIndex - The output retried.
 * @returns The intent id.
 * @throws {never} Never.
 */
export function plannedRetryIntent(runId: string, outputIndex = 0): string {
  return `planned-retry:${runId}:${outputIndex}`;
}

/** One retry of a planned run's failed output. */
export interface PlannedVideoRetry {
  projectId: string;
  spaceId: string;
  tool: MiniToolExecutionRetryRequest['tool'];
  runId: string;
  /** The output retried; the first when omitted. */
  outputIndex?: number;
  /** Rereads what shows the failure once the retry is admitted. */
  onDone: () => void;
}

/**
 * Retries a planned run's failed output once, under {@link plannedRetryIntent}, so the output node's task row and the host's
 * tool panel send one request between them; a refusal is told with the server's reason.
 * @param retry - The output to retry and what to reread once admitted.
 * @returns The press outcome.
 * @throws {never} Request failures settle the press and are reported by toast.
 */
export function retryPlannedVideoRun(retry: PlannedVideoRetry): Promise<RunOnceOutcome<MiniToolPlannedRunAnswer>> {
  const outputIndex = retry.outputIndex ?? 0;
  return runOnce(plannedRetryIntent(retry.runId, outputIndex), {
    scope: 'mini-tool',
    prepare: (): MiniToolExecutionRetryRequest => ({ tool: retry.tool, project_id: retry.projectId, space_id: retry.spaceId, run_id: newId(), retry: { runId: retry.runId, outputIndexes: [outputIndex] } }),
    send: (key, body) => miniToolsApi.retryPlannedVideoRun(body, key),
    onDone: () => { retry.onDone(); return undefined; },
    onFailure: (error) => { toast.error(plannedRunRefusalText(error, t)); },
  });
}

/** What the panel knows besides the draft that a planned request names (§97 D27-1). */
export interface PlannedVideoFacts {
  projectId: string;
  spaceId: string;
  /** The selected version of each input: `{ source }` for one input, input id → ref for transitions. */
  presentationRef: MiniToolPlannedRequest['presentation_ref'];
  /** The analysis refs the node holds; the draft's own are the ones the request names. */
  analysisRefs: readonly VideoToolAnalysisRef[];
  /** The source's compact presentation table, which frames and split plan their outputs from. */
  frameTable?: VideoPresentationTable | null;
}

/** A quoted press: the request facts and the output node ids its quote named. */
export interface PlannedVideoPress extends PlannedVideoFacts { outputNodeIds: readonly string[] }

type PlannedRecipe = MiniToolPlannedRequest['outputs'][number]['recipe'];
/** The one output recipe each single-output planned video tool's request names. */
const SINGLE_RECIPES: Partial<Record<VideoToolId, PlannedRecipe>> = {
  'video.remove-bg': { kind: 'remove-bg' }, 'video.lip-sync': { kind: 'lip-sync' }, 'video.transitions': { kind: 'transitions' },
  'video.erase': { kind: 'erase' }, 'video.expand': { kind: 'expand' },
};

/**
 * Each output's recipe, in output order: frames and split plan theirs from the source table with the shared planner the
 * admission runs on the same table, so the request's outputs equal what the server plans.
 * @param tool - The tool.
 * @param draft - The draft.
 * @param frameTable - The source's compact presentation table.
 * @returns The recipes.
 * @throws {Error} When the tool has no planned request, or frames and split have no table.
 * @throws {z.ZodError} When the table or the draft's selection is invalid.
 */
export function plannedVideoRecipes(tool: VideoToolId, draft: VideoToolDraft, frameTable: VideoPresentationTable | null | undefined): PlannedRecipe[] {
  if (tool === 'video.extract-frames' || tool === 'video.split') {
    if (frameTable == null) throw new Error('Frames and split plan their outputs from the source table');
    return tool === 'video.extract-frames'
      ? planVideoFrames(frameTable, (draft as VideoToolDraftById['video.extract-frames']).params).map(({ frameIndex, pts }) => ({ kind: 'frame' as const, frameIndex, pts }))
      : planVideoSplit(frameTable, (draft as VideoToolDraftById['video.split']).params.cuts).map(({ start, end }) => ({ kind: 'segment' as const, range: { start, end } }));
  }
  const recipe = SINGLE_RECIPES[tool];
  if (recipe === undefined) throw new Error(`${tool} has no planned request`);
  return [recipe];
}

/**
 * The planned request the quote and the Run both send (§97 D27-1): the draft as it is, the draft's own analysis refs, the
 * selected inputs and the given output nodes in order. It writes nothing.
 * @param tool - The tool.
 * @param draft - The draft.
 * @param facts - The panel's project, space, input refs and analysis refs.
 * @param outputNodeIds - The output nodes, in output order.
 * @returns The request.
 * @throws {z.ZodError} When the request is not a complete planned request.
 * @throws {Error} When the tool has no single-recipe planned request.
 */
export function buildPlannedVideoRequest(tool: VideoToolId, draft: VideoToolDraft, facts: PlannedVideoFacts, outputNodeIds: readonly string[]): MiniToolPlannedRequest {
  const recipes = plannedVideoRecipes(tool, draft, facts.frameTable);
  if (recipes.length !== outputNodeIds.length) throw new Error('Each planned output needs its own node');
  return miniToolPlannedRequestSchema.parse({ tool, project_id: facts.projectId, space_id: facts.spaceId, run_id: newId(), draft: structuredClone(draft),
    analysis_refs: facts.analysisRefs.filter((reference) => reference.toolId === tool && reference.draftId === draft.draftId).map((reference) => structuredClone(reference)),
    presentation_ref: structuredClone(facts.presentationRef), outputs: outputNodeIds.map((nodeId, outputIndex) => ({ outputIndex, nodeId, recipe: recipes[outputIndex]! })) });
}

/**
 * Prepares the frozen public request and creates its frontend-owned graph.
 * @param run - The press snapshot and current write capability.
 * @returns Its body, or no request when preparation cannot proceed.
 * @throws {Error} When the complete draft or its execution contract is invalid.
 */
export async function preparePlannedVideoRun(run: PlannedVideoRun): Promise<MiniToolPlannedRequest | null> {
  const draft = structuredClone(run.draft);
  const source = structuredClone(run.source);
  if (!run.canWrite() || !run.sourceExists()) return null;
  const held = videoToolDraftSchema(run.toolId).parse(draft) as VideoToolDraft;
  if (held.source.nodeId !== source.id) throw new Error('Planned source differs from its canvas host');
  const recipes = plannedVideoRecipes(run.toolId, held, run.frameTable);
  const spec = miniToolById(run.toolId);
  if (spec === undefined || spec.run.kind !== 'planned' || spec.outputs?.length !== 1) throw new Error('Planned video execution has no output descriptor');
  // An expansion's node takes the widened frame the quote and the admission size it to (execution design §10.5 geometry row).
  const layout = run.toolId === 'video.expand' ? videoExpandLayout((held as VideoToolDraftById['video.expand']).params.frame, run.display ?? held.source.mediaInfo, Infinity) : held.source.mediaInfo;
  const size = { width: layout.width, height: layout.height };
  const placements = plannedOutputPlacementOf(recipes.map(() => spec.outputs![0]!), recipes.map(() => size), source.name);
  const nodes = placements.map((placed, index) => {
    const node = createEmptyNode(placed.output.modality, {
      x: source.position.x + (source.groupOrigin?.x ?? 0) + NODE_STEP.x + placed.x,
      y: source.position.y + (source.groupOrigin?.y ?? 0) + placed.y,
    }, run.userId);
    const id = run.plan?.outputNodeIds[index] ?? node.id;
    return { ...node, id, data: { ...node.data, name: placed.name,
      ...(placed.size === undefined ? {} : { mediaWidth: placed.size.width, mediaHeight: placed.size.height }) } };
  });
  const body = buildPlannedVideoRequest(run.toolId, held, { projectId: run.projectId, spaceId: run.spaceId, presentationRef: run.presentationRef, analysisRefs: run.plan?.analysisRefs ?? [], frameTable: run.frameTable },
    nodes.map((node) => node.id));
  // A transitions or lip-sync result is also linked from each input node it uses (the picked video, each dialogue audio)
  // while that node is still on the canvas (canvas design §3 inputs row: sourceNodeId gives the edge relation, §4).
  const doc = getDoc(docName.canvasSpace(run.projectId, run.spaceId));
  const linksInputs = run.toolId === 'video.transitions' || run.toolId === 'video.lip-sync';
  const linked = [source.id, ...new Set(held.inputs.flatMap((input) =>
    linksInputs && input.sourceNodeId !== undefined && input.sourceNodeId !== source.id && nodeDataMap(doc, input.sourceNodeId) !== null ? [input.sourceNodeId] : []))];
  runCanvasUndoBatch(run.projectId, run.spaceId, () => {
    for (const node of nodes) {
      addNode(run.projectId, run.spaceId, node);
      for (const from of linked) addEdge(run.projectId, run.spaceId, { id: `${from}->${node.id}`, source: from, target: node.id, toolId: run.toolId });
    }
  });
  if (run.stillOpen()) run.onBuilt(nodes.map((node, index) => ({ id: node.id, position: node.position, width: placements[index]!.width, height: placements[index]!.height })));
  return body;
}

/**
 * What a refused planned run tells the user: the server's own reason when it gave one (frames-split §7.11), otherwise that the
 * run could not start.
 * @param error - The failure.
 * @param translate - The translator.
 * @returns The text.
 * @throws {never} Never.
 */
export function plannedRunRefusalText(error: unknown, translate: (key: string) => string): string {
  return error instanceof ApiException && error.fromServer && error.message ? error.message : translate('canvas.miniTool.panel.couldNotStart');
}

/**
 * Drives a planned press through the existing run-once lifecycle.
 * @param run - The press snapshot and existing Canvas capabilities.
 * @returns The existing press outcome.
 * @throws {never} Request failures settle the existing press and its marks.
 */
export function startPlannedVideoRun(run: PlannedVideoRun): Promise<RunOnceOutcome<MiniToolPlannedRunAnswer>> {
  let operations: { nodeId: string; op: string }[] = [];
  /**
   * Settle the marks owned by this press after the admission answer.
   * @param message - The original refusal, when admission failed.
   * @throws {never} Never.
   */
  function settle(message?: UploadMarkMessage): void {
    const marks = useUploadMarksStore.getState();
    for (const { nodeId, op } of operations) {
      if (message === undefined) marks.answer(run.spaceId, nodeId, op);
      else marks.fail(run.spaceId, nodeId, op, message);
    }
  }
  return runOnce(miniToolIntent(run.spaceId, run.source.id, run.toolId), {
    scope: 'mini-tool',
    prepare: async () => {
      const body = await preparePlannedVideoRun(run);
      if (body !== null) operations = body.outputs.map(({ nodeId }) => ({ nodeId, op: useUploadMarksStore.getState().begin(run.spaceId, nodeId, run.toolId) }));
      return body;
    },
    send: (key, body) => miniToolsApi.runPlanned(body, key),
    onDone: () => { settle(); return undefined; },
    onFailure: (error) => {
      if (operations.length === 0) toast.error(plannedRunRefusalText(error, t));
      else settle(error instanceof ApiException && error.fromServer && error.message ? { text: error.message } : { key: 'canvas.miniTool.panel.couldNotStart' });
    },
  }).then((outcome) => { if (outcome.kind === 'released') settle(); return outcome; });
}
