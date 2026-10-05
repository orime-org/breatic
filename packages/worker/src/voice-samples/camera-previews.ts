// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which camera command preview clips the sample address has to serve, and how
 * each is made (inner#1241). Every clip shows the same scene with one command,
 * so the clips differ only in how the camera moves.
 */

import type { FullModelEntry } from "@breatic/domain";

import type { VoiceSampleJob } from "@worker/voice-samples/plan.js";

/** The scene every preview films: a subject in the middle, depth behind it. */
export const CAMERA_PREVIEW_SCENE =
  "A red vintage car parked on a quiet street of white townhouses, the car in the middle of the frame, late afternoon light, realistic.";

/**
 * What a run sends besides the prompt: each of the entry's panel params at its
 * own default, so a clip costs what the model's cheapest default run costs.
 * @param model - The text-to-video entry making the clips.
 * @returns The params, in the upstream's field names.
 */
function defaultsOf(model: FullModelEntry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(model.params ?? {})
      .filter(([, spec]) => spec.fill === "panel" && spec.default !== undefined && spec.default !== null)
      .map(([name, spec]) => [spec.upstream ?? name, spec.default]),
  );
}

/**
 * Whether an entry serves text-to-video, which a clip needs: the scene is all
 * it is given.
 * @param model - The entry.
 * @returns True when it does.
 */
function servesTextToVideo(model: FullModelEntry): boolean {
  return (Array.isArray(model.mode) ? model.mode : [model.mode]).includes("t2v");
}

/**
 * One job per preview key the video catalog names, made by a text-to-video
 * entry that declares that key.
 * @param models - The video catalog's entries.
 * @returns The jobs, in catalog order.
 * @throws {Error} When a key is declared only by entries that cannot make it from text.
 */
export function planCameraPreviews(models: readonly FullModelEntry[]): VoiceSampleJob[] {
  const keys = [...new Set(models.flatMap((m) => (m.camera_commands ?? []).map((c) => c.sample_key)))];
  return keys.map((key) => {
    const maker = models.find(
      (m) => servesTextToVideo(m) && (m.camera_commands ?? []).some((c) => c.sample_key === key),
    );
    if (!maker) throw new Error(`${key}: no text-to-video entry declares it, so nothing can make the clip`);
    const command = (maker.camera_commands ?? []).find((c) => c.sample_key === key)?.name;
    return {
      model: maker.name,
      key,
      body: { prompt: `${CAMERA_PREVIEW_SCENE} [${command}]`, ...defaultsOf(maker) },
    };
  });
}
