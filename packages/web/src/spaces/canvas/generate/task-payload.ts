// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Assembles the `POST /canvas/tasks` request body for an image-node Generate.
 *
 * Generate modifies the node itself, so the task runs in `overwrite` mode
 * against `target_node_id`, gen-fenced by `node_gens` (#1580 #7: the frontend
 * reads the node's `leaseGen` and sends `gen = leaseGen + 1`). The prompt text
 * + the reference source URLs are snapshotted into `params` at execute time —
 * the worker reads `params.prompt` (via `extractPromptText`) and `params.images`
 * (the reference / image-to-image inputs); it never reads the live node.
 */

import type { TaskCreateInput } from '@breatic/shared';

/** Image-node generation task type (AIGC_TASK_TYPES key on the worker). */
const IMAGE_TASK_TYPE = 'image';

/** Inputs for {@link buildGenerateTaskPayload}. */
export interface GenerateTaskInput {
  /** Node being generated (the overwrite target). */
  nodeId: string;
  projectId: string;
  spaceId: string;
  /** Selected model id. */
  model: string;
  /** Model-specific params already reconciled for the model (ratio, resolution…). */
  params: Record<string, unknown>;
  /** Plain-text prompt (extracted from the rich-text prompt). */
  promptText: string;
  /** Reference source image URLs, snapshotted from the reference rail. */
  referenceUrls: string[];
  /**
   * Style-reference image URL (image-node style slice #1664) — the node's
   * pick-time copy, included by the caller ONLY when the active model supports
   * style references (capability gate). Sent as `params.style_images` (a
   * one-element list — the wire param is list-typed; the product caps it at
   * one). Absent → the key is omitted. Rides every mode (style survives t2i),
   * distinct from `params.images` (the i2i source).
   */
  styleImageUrl?: string;
  /** The node's current persistent lease counter; gen = leaseGen + 1. Absent = 0. */
  leaseGen?: number;
}

/**
 * Builds the overwrite-mode task payload for an image-node Generate.
 * @param input - The node, project/space, model, params, prompt, references, and lease gen.
 * @returns The `POST /canvas/tasks` request body (overwrite, gen-fenced).
 */
export function buildGenerateTaskPayload(
  input: GenerateTaskInput,
): TaskCreateInput {
  const gen = (input.leaseGen ?? 0) + 1;
  return {
    task_type: IMAGE_TASK_TYPE,
    model: input.model,
    // Model params spread FIRST so the user's prompt + reference images always
    // win over any same-named key a (malformed / untrusted) model catalog might
    // carry — never let model params silently overwrite what the user typed.
    params: {
      ...input.params,
      prompt: input.promptText,
      ...(input.referenceUrls.length > 0
        ? { images: input.referenceUrls }
        : {}),
      ...(input.styleImageUrl ? { style_images: [input.styleImageUrl] } : {}),
    },
    node_ids: [input.nodeId],
    project_id: input.projectId,
    space_id: input.spaceId,
    source: 'canvas',
    target_node_id: input.nodeId,
    mode: 'overwrite',
    node_gens: { [input.nodeId]: gen },
  };
}
