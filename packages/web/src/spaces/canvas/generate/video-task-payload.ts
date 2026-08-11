// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Assembles the `POST /canvas/tasks` request body for a video-node Generate.
 *
 * Its own builder rather than a flag on the image one: the two share the task
 * envelope (which they get from `buildOverwriteTaskPayload`) and nothing else.
 * What goes in `params` is where they differ, and video's list grows with each
 * generation mode — first frame, end frame, character image, driving audio —
 * none of which mean anything to an image task.
 */

import type { TaskCreateInput } from '@breatic/shared';

import { buildOverwriteTaskPayload } from '@web/spaces/canvas/generate/overwrite-task-payload';
import { slotsForMode } from '@web/spaces/canvas/generate/video-mode-options';
import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type { VideoSlotUrls } from '@web/spaces/canvas/generate/video-slots';

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
  /** The active generation mode — it decides which source fields are built. */
  mode: string;
  /**
   * URLs picked into slots. Only the ones the active mode collects are built
   * into the payload; the rest stay on the node, where a switch back to their
   * mode finds them again.
   */
  slotUrls: VideoSlotUrls;
  /** The node's current persistent lease counter; gen = leaseGen + 1. Absent = 0. */
  leaseGen?: number;
}

/**
 * The source params one mode sends.
 *
 * Built FROM the mode rather than collected and then guarded: a mode's field
 * set is fixed, so a slot the mode does not collect has no way in and needs no
 * check to keep it out (user 2026-08-10). Each URL travels as its own param,
 * never folded into the reference array — that array is the `@`-picked pool
 * and means something else to the model. An empty slot leaves no key behind at
 * all, because the upstream provider reads a source field's presence, not its
 * value.
 * @param mode - The active generation mode.
 * @param slotUrls - What is currently picked, by slot.
 * @returns The source params, ready to merge into the payload.
 */
function sourceParams(
  mode: string,
  slotUrls: VideoSlotUrls,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const slot of slotsForMode(mode)) {
    const url = slotUrls[slot];
    if (url) params[VIDEO_SLOTS[slot].param] = url;
  }
  return params;
}

/**
 * Builds the overwrite-mode task payload for a video-node Generate.
 * @param input - The node, project/space, model, params, prompt, mode, picked slots and lease gen.
 * @returns The `POST /canvas/tasks` request body (overwrite, gen-fenced).
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
      ...sourceParams(input.mode, input.slotUrls),
    },
    leaseGen: input.leaseGen,
  });
}
