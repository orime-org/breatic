// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Send one Generate press, once (inner#1490).
 *
 * The three Generate panels (image, video, audio) submit the same way: one
 * press per node, held in the run-once registry so it outlives the panel,
 * re-sent with its key until the server answers for good. The answer closes
 * the Generate panel open on that node, whichever opening it is.
 */

import { t, type TaskCreateInput } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { canvasSessions, type CanvasSessionState } from '@web/stores/canvas-session';
import { getRunning, runOnce, useRunning } from '@web/stores/task-actions-in-flight';
import { createNodeTask } from '@web/spaces/canvas/generate/create-node-task';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';

/** The three Generate panels. */
type GeneratePanelKind = Extract<
  NonNullable<CanvasSessionState['panelKind']>,
  'generate' | 'generateVideo' | 'generateAudio'
>;

/**
 * The run-once intent of a Generate press on one node.
 * @param spaceId - The Space the node lives in.
 * @param nodeId - The node.
 * @returns The intent id.
 */
function generateIntent(spaceId: string, nodeId: string): string {
  return `generate:${spaceId}:${nodeId}`;
}

/**
 * Whether a Generate press on this node is still waiting, outside React.
 * @param spaceId - The Space the node lives in.
 * @param nodeId - The node.
 * @returns True while it waits.
 */
export function isGenerating(spaceId: string, nodeId: string): boolean {
  return getRunning(generateIntent(spaceId, nodeId)) !== undefined;
}

/**
 * Whether a Generate press on this node is still waiting; the execute button
 * reads it.
 * @param spaceId - The Space the node lives in.
 * @param nodeId - The node.
 * @returns True while it waits.
 */
export function useGenerating(spaceId: string, nodeId: string): boolean {
  return useRunning(generateIntent(spaceId, nodeId)) !== undefined;
}

/**
 * Send a Generate press.
 * @param opts - The press.
 * @param opts.spaceId - The Space the node lives in.
 * @param opts.nodeId - The node.
 * @param opts.panelKind - Which Generate panel the press came from.
 * @param opts.buildPayload - Builds the request body at the press.
 */
export function submitGeneration(opts: {
  spaceId: string;
  nodeId: string;
  panelKind: GeneratePanelKind;
  buildPayload: () => TaskCreateInput;
}): void {
  void runOnce(generateIntent(opts.spaceId, opts.nodeId), {
    scope: 'generate',
    prepare: opts.buildPayload,
    send: (key, body: TaskCreateInput) => createNodeTask(opts.spaceId, opts.nodeId, body, key),
    // The Space's session as it is now: its tab may have been closed and
    // opened again since the press.
    onDone: () => {
      canvasSessions.peek(opts.spaceId)?.getState().closePanelOn(opts.nodeId, opts.panelKind);
      return undefined;
    },
    // Unconditional: a press that failed after the reader closed the panel
    // still explains itself.
    onFailure: (err) => {
      toast.error(executeErrorMessage(err instanceof ApiException ? err.status : undefined, t));
    },
  });
}
