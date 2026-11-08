// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The model facts a video tool panel reads beyond its draft (inner#1306; canvas design §4 remove-background and lip-sync rows): the
 * configured models and the erase and expand limits from `GET /canvas/limits`, the models joined to their catalog entries;
 * and, for lip-sync, the last run's failure and its retry (execution design §9.4, §10.4, §10.5; frames-split §7.11 retry row).
 */
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { newId } from '@breatic/shared';
import { lipsyncFailureReasonSchema, type LipsyncFailureReason, type VideoToolId } from '@breatic/shared/mini-tools';
import { canvasApi, canvasLimitsQuery, type CanvasEraseLimits, type CanvasExpandLimits } from '@web/data/api/canvas';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { docName, getDoc } from '@web/data/yjs/manager';
import { readEdges, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { plannedRetryIntent, plannedRunRefusalText } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import type { LipSyncChoices } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import { runOnce } from '@web/stores/task-actions-in-flight';

/** What the panel reads of its tool's models. */
export interface VideoToolModels {
  lipSync?: LipSyncChoices;
  erase?: CanvasEraseLimits;
  expand?: CanvasExpandLimits;
  lipSyncFailure: LipsyncFailureReason | null;
  onRetryFailed?: () => void;
  /** The press intent of that retry, which its button waits on. */
  retryIntent?: string;
  /** How long the priced inputs hold still before the panel asks for a quote (config `quote_debounce_ms`). */
  quoteDebounceMs: number;
  /** The most outputs one run of this tool creates (config `executions[tool].max_outputs`), absent while unknown. */
  maxOutputs?: number;
}

/**
 * The host's last failed lip-sync run: the newest lip-sync task of the output nodes its lip-sync edges lead to, and that
 * run's failed output reason.
 * @param projectId - The project.
 * @param spaceId - The space.
 * @param outputs - The output node ids.
 * @returns The run and its reason, or null.
 * @throws {Error} When a read fails.
 */
async function lastLipSyncFailure(projectId: string, spaceId: string, outputs: readonly string[]): Promise<{ runId: string; reason: LipsyncFailureReason } | null> {
  const tasks = (await Promise.all(outputs.map((id) => canvasApi.listNodeTasks(id, projectId, spaceId)))).flat()
    .flatMap((task) => task.action === 'mini_tool' && task.label === 'video.lip-sync' && task.taskId !== null ? [{ ...task, taskId: task.taskId }] : [])
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const last = tasks[0];
  if (last === undefined) return null;
  const record = await miniToolsApi.getRun(projectId, last.taskId);
  const result = record.outputs[0]?.result;
  const reason = result?.status === 'failed' ? lipsyncFailureReasonSchema.safeParse(result.error) : null;
  return reason?.success === true ? { runId: last.taskId, reason: reason.data } : null;
}

/**
 * Read the configured models, the estimate and the lip-sync failure for an open video tool.
 * @param args - The panel.
 * @param args.projectId - The project.
 * @param args.spaceId - The space.
 * @param args.nodeId - The host node.
 * @param args.toolId - The tool.
 * @param args.nodes - The canvas's node views, so the outputs follow the canvas.
 * @returns The facts.
 * @throws {never} Never.
 */
export function useVideoToolModels(args: { projectId: string; spaceId: string; nodeId: string; toolId: VideoToolId; nodes: readonly CanvasNodeView[] }): VideoToolModels {
  const { projectId, spaceId, nodeId, toolId, nodes } = args;
  const t = useTranslation();
  const queryClient = useQueryClient();
  const modelTool = toolId === 'video.lip-sync';
  const limits = useQuery({ ...canvasLimitsQuery(), enabled: modelTool || toolId === 'video.erase' || toolId === 'video.expand' || toolId === 'video.split' }).data;
  const catalog = useQuery({ ...modelCatalogQuery(), enabled: modelTool }).data;
  const erase = limits?.erase ?? undefined;
  const expand = limits?.expand ?? undefined;
  const lipSync = React.useMemo((): LipSyncChoices | undefined => {
    const config = limits?.lipSync;
    if (toolId !== 'video.lip-sync' || config == null || catalog === undefined) return undefined;
    return {
      ...config,
      models: config.models.flatMap((model) => {
        const entry = catalog.video.find((candidate) => candidate.name === model.name);
        return entry === undefined ? [] : [{ ...entry, ...model }];
      }),
    };
  }, [toolId, limits, catalog]);
  const outputs = React.useMemo(() => toolId !== 'video.lip-sync' ? [] : readEdges(getDoc(docName.canvasSpace(projectId, spaceId)))
    .filter((edge) => edge.source === nodeId && edge.toolId === 'video.lip-sync' && nodes.some((node) => node.id === edge.target)).map((edge) => edge.target).sort(),
  [toolId, projectId, spaceId, nodeId, nodes]);
  const failureKey = React.useMemo(() => ['lip-sync-failure', projectId, spaceId, ...outputs], [projectId, spaceId, outputs]);
  const failure = useQuery({ queryKey: failureKey, queryFn: () => lastLipSyncFailure(projectId, spaceId, outputs), enabled: outputs.length > 0 }).data ?? null;
  const onRetryFailed = React.useMemo(() => failure === null ? undefined : (): void => {
    void runOnce(plannedRetryIntent(failure.runId), {
      scope: 'mini-tool',
      prepare: () => ({ tool: 'video.lip-sync' as const, project_id: projectId, space_id: spaceId, run_id: newId(), retry: { runId: failure.runId, outputIndexes: [0] } }),
      send: (key, body) => miniToolsApi.retryPlannedVideoRun(body, key),
      onDone: () => { void queryClient.invalidateQueries({ queryKey: failureKey }); return undefined; },
      onFailure: (error) => { toast.error(plannedRunRefusalText(error, t)); },
    });
  }, [failure, spaceId, projectId, queryClient, t, failureKey]);
  return { ...(lipSync === undefined ? {} : { lipSync }), ...(erase === undefined ? {} : { erase }), ...(expand === undefined ? {} : { expand }), lipSyncFailure: failure?.reason ?? null,
    ...(onRetryFailed === undefined || failure === null ? {} : { onRetryFailed, retryIntent: plannedRetryIntent(failure.runId) }), quoteDebounceMs: limits?.quoteDebounceMs ?? 0,
    ...(limits?.maxOutputs?.[toolId] === undefined ? {} : { maxOutputs: limits.maxOutputs[toolId] }) };
}
