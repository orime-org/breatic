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
   * The picked first frame (image-to-video). Travels as its OWN param, never
   * folded into the reference array: the array is the `@`-picked pool and
   * means something else to the model. Absent when nothing is picked — the
   * key is then left OFF the wire entirely, because the upstream provider
   * reads its presence, not its value.
   */
  firstFrameUrl?: string;
  /** The node's current persistent lease counter; gen = leaseGen + 1. Absent = 0. */
  leaseGen?: number;
}

/**
 * Builds the overwrite-mode task payload for a video-node Generate.
 * @param input - The node, project/space, model, params, prompt and lease gen.
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
      ...(input.firstFrameUrl ? { image: input.firstFrameUrl } : {}),
    },
    leaseGen: input.leaseGen,
  });
}
