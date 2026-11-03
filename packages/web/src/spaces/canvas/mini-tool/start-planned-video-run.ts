// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { newId, t } from '@breatic/shared';
import { miniToolById, miniToolPlannedRequestSchema, videoToolDraftSchema, type MiniToolAnalysisRecord, type MiniToolPlannedRequest, type VideoToolDraft, type VideoToolId } from '@breatic/shared/mini-tools';
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
  canWrite: () => boolean;
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
  if (run.toolId !== 'video.remove-bg') throw new Error('Planned video execution requires a complete public recipe');
  const held = videoToolDraftSchema('video.remove-bg').parse(draft);
  if (held.source.nodeId !== source.id) throw new Error('Planned source differs from its canvas host');
  const spec = miniToolById(run.toolId);
  if (spec === undefined || spec.run.kind !== 'planned' || !spec.outputs) throw new Error('Planned video execution has no output descriptor');
  const placements = plannedOutputPlacementOf(spec.outputs, [{ width: held.source.mediaInfo.width, height: held.source.mediaInfo.height }], source.name);
  const nodes = placements.map((placed) => {
    const node = createEmptyNode(placed.output.modality, {
      x: source.position.x + (source.groupOrigin?.x ?? 0) + NODE_STEP.x + placed.x,
      y: source.position.y + (source.groupOrigin?.y ?? 0) + placed.y,
    }, run.userId);
    return { ...node, data: { ...node.data, name: placed.name,
      ...(placed.size === undefined ? {} : { mediaWidth: placed.size.width, mediaHeight: placed.size.height }) } };
  });
  const body = miniToolPlannedRequestSchema.parse({ tool: run.toolId, project_id: run.projectId, space_id: run.spaceId,
    run_id: newId(), draft: held, analysis_refs: [],
    outputs: nodes.map((node, outputIndex) => ({ outputIndex, nodeId: node.id, recipe: { kind: 'remove-bg' } })),
  });
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
      if (operations.length === 0) toast.error(t('canvas.miniTool.panel.couldNotStart'));
      else settle(error instanceof ApiException && error.fromServer && error.message ? { text: error.message } : { key: 'canvas.miniTool.panel.couldNotStart' });
    },
  }).then((outcome) => { if (outcome.kind === 'released') settle(); return outcome; });
}
