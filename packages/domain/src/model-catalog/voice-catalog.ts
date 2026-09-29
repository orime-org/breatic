// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The voices a tts model offers, read from the voices its yaml entry lists.
 *
 * Every tts model runs on WaveSpeed, which has no voice endpoint to ask, so
 * the catalog carries each model's voices inline. The id handed back here is
 * the one the upstream accepts, because it is what the panel writes into the
 * node and what the next generation sends back out.
 */

import { AppError, getStorageAdapter } from "@breatic/core";
import { t, type Voice, type VoicePage } from "@breatic/shared";

import {
  MODALITIES,
  getFullModelConfig,
  type FullModelEntry,
} from "@domain/model-catalog/model-catalog.js";

// `Voice` and `VoicePage` are the wire shape, so they live in shared where the
// panel that renders them can reach them too. Re-exported here so this module
// stays the one place a caller looks for anything voice-catalog.
export type { Voice, VoicePage };

/** What to ask the catalog for. */
export interface VoiceQuery {
  query?: string;
  cursor?: string;
}

/** A voice as written inline in a model's yaml entry. */
interface InlineVoice {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  sample_url?: unknown;
  sample_key?: unknown;
}

/**
 * Find the model and the modality it lives in.
 * @param modelName - The model's catalog name.
 * @returns The model's yaml entry.
 * @throws {AppError} 404 when no modality carries this model.
 */
function findModel(modelName: string): FullModelEntry {
  for (const modality of MODALITIES) {
    const entry = getFullModelConfig(modality).models.find((m) => m.name === modelName);
    if (entry) return entry;
  }
  throw new AppError(404, t("server.canvas.voices_model_not_found"));
}

/**
 * Assert that the model has a param this catalog fills.
 * @param entry - The model's yaml entry.
 * @throws {AppError} 404 when the model declares no param filled from a voice
 *   catalog, which is what makes asking for its voices meaningless.
 */
function assertOffersVoices(entry: FullModelEntry): void {
  for (const spec of Object.values(entry.params ?? {})) {
    if (spec.remote_source === "voices") return;
  }
  throw new AppError(404, t("server.canvas.voices_not_offered"));
}

/**
 * Read the voices a model writes inline in its yaml entry.
 *
 * The file carries the vendor's id and
 * the readable name in separate fields, and an entry missing either is
 * dropped: the id is the only thing the vendor accepts, and the name is the
 * only thing a person can choose by (#2086).
 *
 * A sample is either the vendor's own (`sample_url`, served from its CDN) or
 * one we generated (`sample_key`, an object in this deployment's bucket, #2156
 * design §16.4). The key is resolved here rather than written as a url in the
 * yaml because every deployment serves its bucket from its own address.
 * @param entry - The model's yaml entry.
 * @returns Every inline voice, in the order the file lists them.
 * @throws {Error} When a voice names a sample key and the storage settings are missing.
 */
async function inlineVoices(entry: FullModelEntry): Promise<Voice[]> {
  const declared = Array.isArray(entry.voices) ? entry.voices : [];
  const keyed = declared.some((raw) => typeof (raw as InlineVoice).sample_key === "string");
  // Only asked for when a key needs it: the adapter needs the storage
  // settings, and a model whose samples are all the vendor's needs none.
  const storage = keyed ? await getStorageAdapter() : null;
  const voices: Voice[] = [];
  for (const raw of declared) {
    const voice = raw as InlineVoice;
    if (typeof voice.id !== "string" || !voice.id) continue;
    if (typeof voice.name !== "string" || !voice.name) continue;
    voices.push({
      id: voice.id,
      name: voice.name,
      ...(typeof voice.description === "string" && voice.description
        ? { description: voice.description }
        : {}),
      ...(typeof voice.sample_url === "string" && voice.sample_url
        ? { previewUrl: voice.sample_url }
        : storage && typeof voice.sample_key === "string" && voice.sample_key
          ? { previewUrl: storage.publicUrl(voice.sample_key) }
          : {}),
    });
  }
  return voices;
}

/**
 * List the voices a model offers, filtered by name.
 * @param modelName - The model's catalog name.
 * @param options - Search term; the cursor is accepted and ignored, the whole list is one page.
 * @returns One page holding every matching voice.
 * @throws {AppError} 404 when the model is unknown or offers no voices.
 * @throws {Error} When a voice names a sample key and the storage settings are missing.
 */
export async function listVoices(modelName: string, options: VoiceQuery): Promise<VoicePage> {
  const entry = findModel(modelName);
  assertOffersVoices(entry);
  // By name alone: the ids here are the vendor's opaque strings, and matching
  // them would answer a one-letter search with every voice whose id happens to
  // contain that letter.
  const term = options.query?.toLowerCase();
  const voices = (await inlineVoices(entry)).filter(
    (v) => !term || v.name.toLowerCase().includes(term),
  );
  return { voices, hasMore: false };
}

/**
 * Read one voice by the id stored on a node, so the panel can name it.
 * @param modelName - The model's catalog name.
 * @param voiceId - The value stored in the node's params.
 * @returns The voice, or null when the model's list no longer carries that id.
 * @throws {AppError} 404 when the model is unknown or offers no voices.
 * @throws {Error} When a voice names a sample key and the storage settings are missing.
 */
export async function getVoice(modelName: string, voiceId: string): Promise<Voice | null> {
  const entry = findModel(modelName);
  assertOffersVoices(entry);
  return (await inlineVoices(entry)).find((v) => v.id === voiceId) ?? null;
}
