// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The envelope every canvas Generate shares, whatever it generates.
 *
 * Generate modifies the node itself, so the task runs in `overwrite` mode
 * against `target_node_id`. A node carries several tasks at once (#186), so an
 * overwrite claims nothing: the later result wins on the node and every task
 * keeps its own on its row. This envelope reads identically for every
 * modality — hence one implementation rather than one per panel. What each
 * modality puts in `params` is its own business and stays in its own builder.
 */

import type { TaskCreateInput } from '@breatic/shared';

/** Inputs for {@link buildOverwriteTaskPayload}. */
export interface OverwriteTaskInput {
  /** Which worker pipeline runs this (`image` / `video` / …). */
  taskType: string;
  /** Node being generated (the overwrite target). */
  nodeId: string;
  projectId: string;
  spaceId: string;
  /** Selected model id. */
  model: string;
  /** The fully assembled request params, prompt and sources included. */
  params: Record<string, unknown>;
}

/**
 * Wraps already-assembled params in the overwrite task envelope.
 * @param input - Task type, node, project/space, model and params.
 * @returns The `POST /canvas/tasks` request body.
 */
export function buildOverwriteTaskPayload(
  input: OverwriteTaskInput,
): TaskCreateInput {
  return {
    task_type: input.taskType,
    model: input.model,
    params: input.params,
    node_ids: [input.nodeId],
    project_id: input.projectId,
    space_id: input.spaceId,
    source: 'canvas',
    target_node_id: input.nodeId,
    mode: 'overwrite',
  };
}
