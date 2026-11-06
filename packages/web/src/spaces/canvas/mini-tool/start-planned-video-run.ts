// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { newId, t } from '@breatic/shared';
import { miniToolById, miniToolPlannedRequestSchema, videoToolDraftSchema, type MiniToolAnalysisRecord, type MiniToolPlannedRequest, type VideoToolAnalysisRef, type VideoToolDraft, type VideoToolId } from '@breatic/shared/mini-tools';
import { miniToolsApi, type MiniToolPlannedRunAnswer } from '@web/data/api/mini-tools';
import { ApiException } from '@web/data/api/types';
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
}

/** What the panel knows besides the draft that a planned request names (§97 D27-1). */
export interface PlannedVideoFacts {
  projectId: string;
  spaceId: string;
  /** The selected version of each input: `{ source }` for one input, input id → ref for transitions. */
  presentationRef: MiniToolPlannedRequest['presentation_ref'];
  /** The analysis refs the node holds; the draft's own are the ones the request names. */
  analysisRefs: readonly VideoToolAnalysisRef[];
}

/** A quoted press: the request facts and the output node ids its quote named. */
export interface PlannedVideoPress extends PlannedVideoFacts { outputNodeIds: readonly string[] }

/** The one output recipe each planned video tool's request names. */
const PLANNED_RECIPES: Partial<Record<VideoToolId, MiniToolPlannedRequest['outputs'][number]['recipe']>> = {
  'video.remove-bg': { kind: 'remove-bg' }, 'video.lip-sync': { kind: 'lip-sync' }, 'video.transitions': { kind: 'transitions' },
};

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
  const recipe = PLANNED_RECIPES[tool];
  if (recipe === undefined) throw new Error(`${tool} has no single-recipe planned request`);
  return miniToolPlannedRequestSchema.parse({ tool, project_id: facts.projectId, space_id: facts.spaceId, run_id: newId(), draft: structuredClone(draft),
    analysis_refs: facts.analysisRefs.filter((reference) => reference.toolId === tool && reference.draftId === draft.draftId).map((reference) => structuredClone(reference)),
    presentation_ref: structuredClone(facts.presentationRef), outputs: outputNodeIds.map((nodeId, outputIndex) => ({ outputIndex, nodeId, recipe })) });
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
  if (PLANNED_RECIPES[run.toolId] === undefined) throw new Error('Planned video execution requires a complete public recipe');
  const held = videoToolDraftSchema(run.toolId).parse(draft) as VideoToolDraft;
  if (held.source.nodeId !== source.id) throw new Error('Planned source differs from its canvas host');
  const spec = miniToolById(run.toolId);
  if (spec === undefined || spec.run.kind !== 'planned' || !spec.outputs) throw new Error('Planned video execution has no output descriptor');
  const placements = plannedOutputPlacementOf(spec.outputs, [{ width: held.source.mediaInfo.width, height: held.source.mediaInfo.height }], source.name);
  const nodes = placements.map((placed, index) => {
    const node = createEmptyNode(placed.output.modality, {
      x: source.position.x + (source.groupOrigin?.x ?? 0) + NODE_STEP.x + placed.x,
      y: source.position.y + (source.groupOrigin?.y ?? 0) + placed.y,
    }, run.userId);
    const id = run.plan?.outputNodeIds[index] ?? node.id;
    return { ...node, id, data: { ...node.data, name: placed.name,
      ...(placed.size === undefined ? {} : { mediaWidth: placed.size.width, mediaHeight: placed.size.height }) } };
  });
  const body = buildPlannedVideoRequest(run.toolId, held, { projectId: run.projectId, spaceId: run.spaceId, presentationRef: run.presentationRef, analysisRefs: run.plan?.analysisRefs ?? [] },
    nodes.map((node) => node.id));
  runCanvasUndoBatch(run.projectId, run.spaceId, () => {
    for (const node of nodes) {
      addNode(run.projectId, run.spaceId, node);
      addEdge(run.projectId, run.spaceId, { id: `${source.id}->${node.id}`, source: source.id, target: node.id, toolId: run.toolId });
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
