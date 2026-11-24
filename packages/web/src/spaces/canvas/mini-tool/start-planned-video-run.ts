// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { newId, t } from '@breatic/shared';
import { miniToolById, miniToolPlannedRequestSchema, planVideoFrames, planVideoSplit, videoToolDraftSchema, type MiniToolAnalysisRecord, type MiniToolPlannedRequest, type VideoPlanGrid, type VideoToolAnalysisRef, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { miniToolsApi, type MiniToolPlannedRunAnswer } from '@web/data/api/mini-tools';
import { ourSentence } from '@web/data/api/server-message';
import { addEdge, addNode, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
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
  grid?: VideoPlanGrid | null;
}

/** What the panel knows besides the draft that a planned request names (§97 D27-1). */
export interface PlannedVideoFacts {
  projectId: string;
  spaceId: string;
  /** The selected version of the source, `{ source }`. */
  presentationRef: MiniToolPlannedRequest['presentation_ref'];
  /** The analysis refs the node holds; the draft's own are the ones the request names. */
  analysisRefs: readonly VideoToolAnalysisRef[];
  /** The selected version's grid, which frames and split plan their outputs on. */
  grid?: VideoPlanGrid | null;
}

/** A quoted press: the request facts and the output node ids its quote named. */
export interface PlannedVideoPress extends PlannedVideoFacts { outputNodeIds: readonly string[] }

type PlannedRecipe = MiniToolPlannedRequest['outputs'][number]['recipe'];

/**
 * Each output's recipe, in output order: frames and split plan theirs on the selected version's grid with the shared planner
 * the admission runs on the same grid, so the request's outputs equal what the server plans.
 * @param tool - The tool.
 * @param draft - The draft.
 * @param grid - The selected version's grid.
 * @returns The recipes.
 * @throws {Error} When frames and split have no grid.
 * @throws {z.ZodError} When the grid or the draft's selection is invalid.
 */
export function plannedVideoRecipes(tool: VideoToolId, draft: VideoToolDraft, grid: VideoPlanGrid | null | undefined): PlannedRecipe[] {
  if (grid == null) throw new Error('Frames and split plan their outputs on the selected version grid');
  return tool === 'video.extract-frames'
    ? planVideoFrames(grid, (draft as VideoToolDraftById['video.extract-frames']).params).map(({ frameIndex }) => ({ kind: 'frame' as const, frameIndex }))
    : planVideoSplit(grid, (draft as VideoToolDraftById['video.split']).params.cuts).map(({ start, end }) => ({ kind: 'segment' as const, range: { start, end } }));
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
 * @throws {Error} When frames and split have no grid.
 */
export function buildPlannedVideoRequest(tool: VideoToolId, draft: VideoToolDraft, facts: PlannedVideoFacts, outputNodeIds: readonly string[]): MiniToolPlannedRequest {
  const recipes = plannedVideoRecipes(tool, draft, facts.grid);
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
  const recipes = plannedVideoRecipes(run.toolId, held, run.grid);
  const spec = miniToolById(run.toolId);
  if (spec === undefined || spec.run.kind !== 'planned' || spec.outputs?.length !== 1) throw new Error('Planned video execution has no output descriptor');
  const size = { width: held.source.mediaInfo.width, height: held.source.mediaInfo.height };
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
  const body = buildPlannedVideoRequest(run.toolId, held, { projectId: run.projectId, spaceId: run.spaceId, presentationRef: run.presentationRef, analysisRefs: run.plan?.analysisRefs ?? [], grid: run.grid },
    nodes.map((node) => node.id));
  // The nodes and their edges are one add for the size cap, judged before the request: no room means no run.
  const placed = runCanvasUndoBatch(run.projectId, run.spaceId, { kind: 'add' }, () => {
    for (const node of nodes) {
      addNode(run.projectId, run.spaceId, node);
      addEdge(run.projectId, run.spaceId, { id: `${source.id}->${node.id}`, source: source.id, target: node.id, toolId: run.toolId });
    }
  });
  if (!placed.ok) return null;
  if (run.stillOpen()) run.onBuilt(nodes.map((node, index) => ({ id: node.id, position: node.position, width: placements[index]!.width, height: placements[index]!.height })));
  return body;
}

/**
 * What a refused planned run tells the user: a spend-limit refusal's own sentence (inner#1968 design 3.3a), the server's own
 * reason when it gave one (frames-split §7.11), otherwise that the run could not start.
 * @param error - The failure.
 * @param translate - The translator.
 * @returns The text.
 * @throws {never} Never.
 */
export function plannedRunRefusalText(error: unknown, translate: (key: string) => string): string {
  return ourSentence(error) ?? translate('canvas.miniTool.panel.couldNotStart');
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
      else { const ours = ourSentence(error); settle(ours === null ? { key: 'canvas.miniTool.panel.couldNotStart' } : { text: ours }); }
    },
  }).then((outcome) => { if (outcome.kind === 'released') settle(); return outcome; });
}
