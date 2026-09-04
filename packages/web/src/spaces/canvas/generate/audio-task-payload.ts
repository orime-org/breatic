// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Assembles the `POST /canvas/tasks` request body for an audio-node Generate.
 *
 * The task type is read off the MODEL rather than fixed for the panel, and
 * that is what this builder exists to get right: the worker loads a different
 * provider module per task type (`dispatch.ts` has one case for `tts` and
 * another for `audio`), while this one panel serves both buckets — voiceover
 * and voice cloning come out of `config/models/tts/`, sound effects and music
 * out of `config/models/audio/`. A panel-wide constant would send one of those
 * to the other's module.
 *
 * The catalog is what stamps the bucket on an entry, so the modality carried
 * by the selected model IS the answer, with no second table to keep in step.
 */

import type { ModelEntry, TaskCreateInput } from '@breatic/shared';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { buildOverwriteTaskPayload } from '@web/spaces/canvas/generate/overwrite-task-payload';

/** One URL per audio slot the node holds a pick in. */
export type AudioSlotUrls = Partial<Record<keyof typeof AUDIO_SLOTS, string>>;

/**
 * The picked source assets, under the param names their vendors read.
 *
 * A slot with nothing picked contributes no key at all. An `audio: undefined`
 * riding along would read as a present-but-empty source to the server gate,
 * which tests `typeof value === 'string'` — so absent and blank have to stay
 * different things.
 * @param slotUrls - What each slot currently holds.
 * @returns The source params, empty when nothing is picked.
 */
function sourceParams(slotUrls: AudioSlotUrls): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [slot, spec] of Object.entries(AUDIO_SLOTS)) {
    const url = slotUrls[slot as keyof typeof AUDIO_SLOTS];
    if (url) params[spec.param] = url;
  }
  return params;
}

/** Inputs for {@link buildAudioTaskPayload}. */
export interface AudioTaskInput {
  /** Node being generated (the overwrite target). */
  nodeId: string;
  projectId: string;
  spaceId: string;
  /**
   * The selected model itself. Its id and its bucket both come from here so
   * the two cannot be passed in disagreeing with each other.
   */
  model: ModelEntry;
  /** Model params already reconciled for the model (voice, stability, speed, …). */
  params: Record<string, unknown>;
  /** The lines to speak, serialized from the prompt at click time. */
  promptText: string;
  /** The node's current persistent lease counter; gen = leaseGen + 1. Absent = 0. */
  leaseGen?: number;
  /** What each audio slot holds, for the modes that collect one. */
  slotUrls?: AudioSlotUrls;
}

/**
 * Builds the overwrite-mode task payload for an audio-node Generate.
 * @param input - The node, project/space, model, params, prompt and lease gen.
 * @returns The `POST /canvas/tasks` request body (overwrite, gen-fenced).
 */
export function buildAudioTaskPayload(input: AudioTaskInput): TaskCreateInput {
  return buildOverwriteTaskPayload({
    taskType: input.model.modality,
    nodeId: input.nodeId,
    projectId: input.projectId,
    spaceId: input.spaceId,
    model: input.model.name,
    // Model params spread FIRST so what the user typed always wins over a
    // same-named key a malformed catalog might carry.
    params: {
      ...input.params,
      prompt: input.promptText,
      // After the params spread on purpose: what the user picked in the slot
      // wins over a same-named key the catalog carries.
      ...sourceParams(input.slotUrls ?? {}),
    },
    leaseGen: input.leaseGen,
  });
}
