// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Assembles the `POST /canvas/tasks` request body for a video-node Generate.
 *
 * Its own builder rather than a flag on the image one: the two share the task
 * envelope (which they get from `buildOverwriteTaskPayload`) and nothing else.
 * What goes in `params` is where they differ, and video's list grows with each
 * generation mode — first frame, end frame, character image, driving video,
 * driving audio — none of which mean anything to an image task. The one field
 * the two do share, the reference pool, is still built on different terms:
 * here it belongs to a single mode (#1927), where on the image side it
 * belongs to all but one.
 */

import type { TaskCreateInput } from '@breatic/shared';

import { buildOverwriteTaskPayload } from '@web/spaces/canvas/generate/overwrite-task-payload';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlot, VideoSlotUrls } from '@web/spaces/canvas/generate/video-slots';

/** Video-node generation task type (AIGC_TASK_TYPES key on the worker). */
const VIDEO_TASK_TYPE = 'video';

/** Inputs for {@link buildVideoTaskPayload}. */
export interface VideoTaskInput {
  /** Node being generated (the overwrite target). */
  nodeId: string;
  projectId: string;
  spaceId: string;
  /** Selected model id. */
  model: string;
  /** Model params already reconciled for the model (ratio, resolution, duration, audio). */
  params: Record<string, unknown>;
  /** Plain-text prompt (extracted from the rich-text prompt). */
  promptText: string;
  /**
   * The slots the toolbar draws for this model in this mode — the source
   * fields that are built. Picks in any other slot stay on the node, where a
   * switch back to their mode or model finds them again.
   */
  slots: readonly VideoSlot[];
  /** URLs picked into slots, by slot. */
  slotUrls: VideoSlotUrls;
  /**
   * The `@`-mentioned references under the params the model reads them from,
   * as `poolParams` builds them (#1927, #2156) — empty under a mode whose
   * model takes no pool, or when nothing is mentioned.
   */
  poolParams: Readonly<Record<string, readonly string[]>>;
}

/**
 * The source params one run sends.
 *
 * Built FROM the drawn slots rather than collected and then guarded: a slot
 * the toolbar does not draw has no way in and needs no check to keep it out
 * (user 2026-08-10). Each URL travels as its own param,
 * never folded into the pool — the pool is the `@`-picked references and
 * means something else to the model. An empty slot adds no key here,
 * because the upstream provider reads a source field's presence, not its
 * value.
 *
 * "Adds no key" is a statement about this function, not about the payload:
 * the model's own declared params are merged in first, and a model that
 * declares `images` (as `kling-o3-pro-ref` does, with a null default) puts the
 * key there whatever this returns. That is the same route `seed` and
 * `generate_audio` arrive by, and the worker drops null values before mapping
 * them to vendor names.
 * @param slots - The slots the toolbar draws.
 * @param slotUrls - What is currently picked, by slot.
 * @param pool - The `@`-mentioned references, under the params the model reads.
 * @returns The source params, ready to merge into the payload.
 */
export function sourceParams(
  slots: readonly VideoSlot[],
  slotUrls: VideoSlotUrls,
  pool: Readonly<Record<string, readonly string[]>>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const slot of slots) {
    const url = slotUrls[slot];
    if (url) params[VIDEO_SLOTS[slot].param] = url;
  }
  // Reference-to-video (#1927): the `@`-picked pool IS this mode's source, so
  // here it is a source param like any other — same rule, same shape. An empty
  // pool writes nothing for the same reason an empty slot does: upstream reads
  // a source field's presence, so an empty list would be a claim rather than a
  // silence. Execute refuses that submit anyway, and whatever the model's own
  // declared default left in `params` stays as it was.
  for (const [param, urls] of Object.entries(pool)) params[param] = [...urls];
  return params;
}

/**
 * Builds the overwrite-mode task payload for a video-node Generate.
 * @param input - The node, project/space, model, params, prompt, drawn slots, picks and references.
 * @returns The `POST /canvas/tasks` request body, in overwrite mode.
 */
export function buildVideoTaskPayload(input: VideoTaskInput): TaskCreateInput {
  return buildOverwriteTaskPayload({
    taskType: VIDEO_TASK_TYPE,
    nodeId: input.nodeId,
    projectId: input.projectId,
    spaceId: input.spaceId,
    model: input.model,
    // Model params spread FIRST so the user's prompt always wins over any
    // same-named key a (malformed / untrusted) model catalog might carry —
    // never let model params silently overwrite what the user typed.
    params: {
      ...input.params,
      prompt: input.promptText,
      ...sourceParams(
        input.slots,
        input.slotUrls,
        input.poolParams,
      ),
    },
  });
}
