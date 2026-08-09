// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The envelope every canvas Generate shares, whatever it generates.
 *
 * Generate modifies the node itself, so the task runs in `overwrite` mode
 * against `target_node_id`, gen-fenced by `node_gens` (#1580 #7: the frontend
 * reads the node's `leaseGen` and sends `gen = leaseGen + 1`). That fence is
 * what stops a stale panel from overwriting a newer result, so it must read
 * identically for every modality — hence one implementation rather than one
 * per panel. What each modality puts in `params` is its own business and stays
 * in its own builder.
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
  /** The node's current persistent lease counter; gen = leaseGen + 1. Absent = 0. */
  leaseGen?: number;
}

/**
 * Wraps already-assembled params in the overwrite, gen-fenced task envelope.
 * @param input - Task type, node, project/space, model, params and lease gen.
 * @returns The `POST /canvas/tasks` request body.
 */
export function buildOverwriteTaskPayload(
  input: OverwriteTaskInput,
): TaskCreateInput {
  const gen = (input.leaseGen ?? 0) + 1;
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
    node_gens: { [input.nodeId]: gen },
  };
}
