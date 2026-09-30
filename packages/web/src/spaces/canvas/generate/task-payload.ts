// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Assembles the `POST /canvas/tasks` request body for an image-node Generate.
 *
 * Generate modifies the node itself, so the task runs in `overwrite` mode
 * against `target_node_id`. The prompt text
 * + the reference source URLs are snapshotted into `params` at execute time —
 * the worker reads `params.prompt` (via `extractPromptText`) and `params.images`
 * (the reference / image-to-image inputs); it never reads the live node.
 */

import type { ReferencePool, TaskCreateInput } from '@breatic/shared';
import type { EstimateInput } from '@breatic/shared/pricing';

import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import { buildOverwriteTaskPayload } from '@web/spaces/canvas/generate/overwrite-task-payload';
import { poolParams, type ReferenceUrls } from '@web/spaces/canvas/generate/reference-urls';

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
  /**
   * The mentioned references under the params the model reads them from, as
   * `poolParams` builds them (#2156) — empty when none are mentioned.
   */
  poolParams: Readonly<Record<string, readonly string[]>>;
  /**
   * Style-reference image URL (image-node style slice #1664) — the node's
   * pick-time copy, included by the caller ONLY when the active model supports
   * style references (capability gate). Sent as `params.style_images` (a
   * one-element list — the wire param is list-typed; the product caps it at
   * one). Absent → the key is omitted. Rides every mode (style survives t2i),
   * distinct from the pool (the i2i source).
   */
  styleImageUrl?: string;
}

/**
 * The source params one run sends: the mentioned references and, when the
 * caller passes one, the style image as a one-element list.
 * @param pool - The mentioned references, under the params the model reads.
 * @param styleImageUrl - The style image, only when the model takes one.
 * @returns The source params, ready to merge into the payload.
 */
function imageSourceParams(
  pool: Readonly<Record<string, readonly string[]>>,
  styleImageUrl: string | undefined,
): Record<string, unknown> {
  return {
    ...pool,
    ...(styleImageUrl ? { [IMAGE_SLOTS.style.param]: [styleImageUrl] } : {}),
  };
}

/**
 * Builds the overwrite-mode task payload for an image-node Generate.
 * @param input - The node, project/space, model, params, prompt and references.
 * @returns The `POST /canvas/tasks` request body, in overwrite mode.
 */
export function buildGenerateTaskPayload(
  input: GenerateTaskInput,
): TaskCreateInput {
  return buildOverwriteTaskPayload({
    taskType: IMAGE_TASK_TYPE,
    nodeId: input.nodeId,
    projectId: input.projectId,
    spaceId: input.spaceId,
    model: input.model,
    // Model params spread FIRST so the user's prompt + reference images always
    // win over any same-named key a (malformed / untrusted) model catalog might
    // carry — never let model params silently overwrite what the user typed.
    params: {
      ...input.params,
      prompt: input.promptText,
      ...imageSourceParams(input.poolParams, input.styleImageUrl),
    },
  });
}

/** What the price reads off the image panel's view model. */
interface ImageEstimateSource {
  params: Readonly<Record<string, unknown>>;
  pool: ReferencePool;
  referenceUrls: ReferenceUrls;
  styleSupported: boolean;
  styleImageUrl?: string;
}

/**
 * The run the panel quotes a price for (#2156, design §14): the params with
 * the same source fields the submit sends.
 * @param vm - The panel's view model.
 * @param prompt - The prompt as the model reads it.
 * @returns The estimate input.
 */
export function imageEstimateInput(vm: ImageEstimateSource, prompt: string): EstimateInput {
  const style = vm.styleSupported ? vm.styleImageUrl : undefined;
  return {
    params: { ...vm.params, ...imageSourceParams(poolParams(vm.pool, vm.referenceUrls), style) },
    prompt,
  };
}
