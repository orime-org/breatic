// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Assembles the `POST /canvas/tasks` request body for an audio-node Generate.
 *
 * The task type is read off the MODEL rather than fixed for the panel, and
 * that is what this builder exists to get right: the worker loads a different
 * provider module per task type (`dispatch.ts` has one case for `tts` and
 * another for `audio`), while this one panel serves both buckets — text to speech
 * and voice cloning come out of `config/models/tts/`, sound effects and music
 * out of `config/models/audio/`. A panel-wide constant would send one of those
 * to the other's module.
 *
 * The catalog is what stamps the bucket on an entry, so the modality carried
 * by the selected model IS the answer, with no second table to keep in step.
 */

import type { ModelEntry, TaskCreateInput } from '@breatic/shared';

import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import type { AudioSlot, AudioSlotUrls } from '@web/spaces/canvas/generate/audio-slots';
import { buildOverwriteTaskPayload } from '@web/spaces/canvas/generate/overwrite-task-payload';

/**
 * The picked source assets, under the param names their vendors read.
 *
 * Built from the MODE's slots, not from everything the node holds: a pick
 * survives a mode switch (that is the point of storing it on the node), so a
 * reference audio chosen for cloning is still there while text to speech is
 * selected, and walking the whole registry would send it under a mode that
 * never asked for one.
 *
 * A slot with nothing picked contributes no key here, so the value the payload
 * carries for it is the `null` the model's own record holds. With every slot
 * the mode collects left empty, that null is what the panel gate, the
 * server's source gate and the mini-tool schema each refuse first; on a mode
 * taking any one of several, the nulls beside the picked one ride along and
 * the WaveSpeed transport strips them before the request.
 * @param slots - The slots the active mode collects.
 * @param slotUrls - What each slot currently holds.
 * @returns The source params, empty when nothing is picked.
 */
function sourceParams(
  slots: readonly AudioSlot[],
  slotUrls: AudioSlotUrls,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const slot of slots) {
    const url = slotUrls[slot];
    if (url) params[AUDIO_SLOTS[slot].param] = url;
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
  /** What each audio slot holds, for the modes that collect one. */
  slotUrls?: AudioSlotUrls;
  /** The slots the active mode collects; absent means it collects none. */
  slots?: readonly AudioSlot[];
  /**
   * The words to sing, on a mode that collects them (#1960).
   *
   * Absent means this mode has no lyrics box at all, and the field is then
   * left out of the request entirely rather than sent empty. An empty STRING
   * is a different statement: the track was marked instrumental, which is the
   * one case the gateway accepts without words (measured 2026-09-05 — with
   * `is_instrumental: true` it completes, and both music models refuse an
   * empty lyrics on any vocal run).
   */
  lyricsText?: string;
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
      // Only when the mode collects them; see `lyricsText`. After the params
      // spread for the same reason the prompt is: what the user wrote wins
      // over a same-named key the catalog carries.
      ...(input.lyricsText !== undefined ? { lyrics: input.lyricsText } : {}),
      // After the params spread on purpose: what the user picked in the slot
      // wins over a same-named key the catalog carries.
      ...sourceParams(input.slots ?? [], input.slotUrls ?? {}),
    },
  });
}
