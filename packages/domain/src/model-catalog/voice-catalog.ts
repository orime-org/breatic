// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The voices a tts model offers, in one shape whichever vendor answers.
 *
 * Which vendor that is depends on the deployment (`resolveActiveProvider`),
 * and it decides where the request goes. The id handed back here is the one
 * that provider accepts, because it is what the panel writes into the node
 * and what the next generation sends back out.
 */

import { AppError } from "@breatic/core";
import { httpRequest, t, type Voice, type VoicePage } from "@breatic/shared";

import {
  MODALITIES,
  getFullModelConfig,
  type FullModelEntry,
} from "@domain/model-catalog/model-catalog.js";
import {
  resolveActiveProvider,
  type ActiveProvider,
} from "@domain/model-catalog/resolve-active-provider.js";

// `Voice` and `VoicePage` are the wire shape, so they live in shared where the
// panel that renders them can reach them too. Re-exported here so this module
// stays the one place a caller looks for anything voice-catalog.
export type { Voice, VoicePage };

/** What to ask the catalog for. */
export interface VoiceQuery {
  query?: string;
  cursor?: string;
}

/** How many voices one page holds. Both vendors cap a page at 100. */
const PAGE_SIZE = 50;

/** A voice as written inline in a model's yaml entry. */
interface InlineVoice {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  sample_url?: unknown;
}

/**
 * Find the model and the modality it lives in.
 * @param modelName - The model's catalog name.
 * @returns The model's yaml entry and its modality.
 * @throws {AppError} 404 when no modality carries this model.
 */
function findModel(modelName: string): { entry: FullModelEntry; modality: string } {
  for (const modality of MODALITIES) {
    const entry = getFullModelConfig(modality).models.find((m) => m.name === modelName);
    if (entry) return { entry, modality };
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
 * Resolve the provider serving this model, as a configuration answer.
 *
 * Provider resolution refuses with a plain error, which reaches a route as a
 * 500. Nothing is broken here: a deployment simply configured no key for any
 * of the model's providers, and the fix is an operator's.
 * @param modality - The modality the model lives in.
 * @param modelName - The model's catalog name.
 * @returns The provider this deployment will call.
 * @throws {AppError} 503 when no provider of the model has a key.
 */
function providerServing(modality: string, modelName: string): ActiveProvider {
  try {
    return resolveActiveProvider(modality, modelName);
  } catch {
    throw new AppError(503, t("server.canvas.voices_provider_unconfigured"));
  }
}

/**
 * Read a JSON body from an upstream, or fail with what it said.
 * @param url - The request URL.
 * @param headers - Auth headers for that vendor.
 * @param timeoutSeconds - The provider's configured timeout.
 * @returns The parsed body.
 * @throws {AppError} 502 when the upstream refuses or answers with a non-2xx
 *   status. The vendor's own status is not forwarded: what failed is our call
 *   to them, and its wording is theirs, in their language.
 */
async function readJson(
  url: string,
  headers: Record<string, string>,
  timeoutSeconds: number,
): Promise<unknown> {
  // Replay-safe: these are reads, so a retried delivery costs nothing.
  const resp = await httpRequest(
    url,
    { method: "GET", headers },
    { replaySafe: true, timeoutMs: timeoutSeconds * 1000 },
  );
  if (!resp.ok) {
    throw new AppError(502, t("server.canvas.voices_upstream_failed"));
  }
  const body: unknown = await resp.json().catch(() => null);
  // A 200 whose payload is not an object failed the same way a refusal did:
  // every caller here reads named fields off this value, so a bare one either
  // throws where no layer above expects it, or reads as zero voices — which
  // tells the user the model offers none when the upstream is what broke.
  if (body === null || typeof body !== "object") {
    throw new AppError(502, t("server.canvas.voices_upstream_failed"));
  }
  return body;
}

/**
 * Describe an ElevenLabs voice from whichever of its fields carry a description.
 * @param voice - One entry of the vendor's list response.
 * @returns A sentence for the panel, or undefined when the vendor gave nothing.
 */
function elevenLabsDescription(voice: Record<string, unknown>): string | undefined {
  if (typeof voice.description === "string" && voice.description) return voice.description;
  const labels = voice.labels;
  if (labels && typeof labels === "object") {
    const values = Object.values(labels as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (values.length > 0) return values.join(", ");
  }
  return undefined;
}

/**
 * Project one ElevenLabs voice onto our shape.
 * @param raw - One entry of the vendor's response.
 * @returns The voice, or null when it carries no usable identity.
 */
function fromElevenLabs(raw: unknown): Voice | null {
  const voice = raw as Record<string, unknown>;
  const id = voice.voice_id;
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    name: typeof voice.name === "string" ? voice.name : id,
    ...(elevenLabsDescription(voice) ? { description: elevenLabsDescription(voice)! } : {}),
    ...(typeof voice.preview_url === "string" && voice.preview_url
      ? { previewUrl: voice.preview_url }
      : {}),
  };
}

/**
 * Project one Fish model onto our shape.
 * @param raw - One entry of the vendor's response.
 * @returns The voice, or null when it carries no usable identity.
 */
function fromFish(raw: unknown): Voice | null {
  const model = raw as Record<string, unknown>;
  const id = model._id;
  if (typeof id !== "string" || !id) return null;

  const samples = Array.isArray(model.samples) ? model.samples : [];
  const firstAudio = (samples[0] as Record<string, unknown> | undefined)?.audio;
  const languages = Array.isArray(model.languages)
    ? model.languages.filter((l): l is string => typeof l === "string")
    : [];

  return {
    id,
    name: typeof model.title === "string" ? model.title : id,
    ...(typeof model.description === "string" && model.description
      ? { description: model.description }
      : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(typeof firstAudio === "string" && firstAudio ? { previewUrl: firstAudio } : {}),
  };
}

/**
 * Read the voices a model writes inline in its yaml entry.
 *
 * This is the list for a deployment behind an aggregating gateway, which has
 * no voice endpoint of its own to ask. The file carries the vendor's id and
 * the readable name in separate fields, and an entry missing either is
 * dropped: the id is the only thing the vendor accepts, and the name is the
 * only thing a person can choose by (#2086).
 * @param entry - The model's yaml entry.
 * @returns Every inline voice, in the order the file lists them.
 */
function inlineVoices(entry: FullModelEntry): Voice[] {
  const declared = Array.isArray(entry.voices) ? entry.voices : [];
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
        : {}),
    });
  }
  return voices;
}

/**
 * List the voices a model offers on the provider this deployment resolved to.
 * @param modelName - The model's catalog name.
 * @param options - Search term and page cursor.
 * @returns One page of voices.
 * @throws {AppError} 404 when the model is unknown or offers no voices, 503
 *   when no provider of it is configured, 502 when the upstream refuses.
 */
export async function listVoices(
  modelName: string,
  options: VoiceQuery,
): Promise<VoicePage> {
  const { entry, modality } = findModel(modelName);
  assertOffersVoices(entry);

  const provider = providerServing(modality, modelName);

  if (provider.providerName === "elevenlabs") {
    // Search and pagination live on v2, while base_url already carries the v1
    // the TTS transport posts to.
    const url = new URL("/v2/voices", new URL(provider.baseUrl).origin);
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (options.query) url.searchParams.set("search", options.query);
    if (options.cursor) url.searchParams.set("next_page_token", options.cursor);

    const body = (await readJson(
      url.toString(),
      { "xi-api-key": provider.apiKey },
      provider.timeout,
    )) as Record<string, unknown>;

    const rawVoices = Array.isArray(body.voices) ? body.voices : [];
    const nextToken = body.next_page_token;
    // The flag and the cursor travel together. Reporting more without a token
    // leaves the picker asking for "the next page" with no cursor, which is
    // page one again: every scroll to the bottom refetches it, the dedupe
    // drops all of it, and the list never moves.
    const hasMore =
      body.has_more === true && typeof nextToken === "string" && nextToken !== "";
    return {
      voices: rawVoices.map(fromElevenLabs).filter((v): v is Voice => v !== null),
      hasMore,
      ...(hasMore ? { nextCursor: nextToken } : {}),
    };
  }

  if (provider.providerName === "fish") {
    const pageNumber = Number.parseInt(options.cursor ?? "1", 10) || 1;
    const url = new URL("/model", provider.baseUrl);
    url.searchParams.set("page_size", String(PAGE_SIZE));
    url.searchParams.set("page_number", String(pageNumber));
    // Two million community voices is not a list anyone can pick from: only
    // what the vendor licensed, ordered by how much it is actually used.
    url.searchParams.set("licensed", "true");
    url.searchParams.set("sort_by", "task_count");
    if (options.query) url.searchParams.set("title", options.query);

    const body = (await readJson(
      url.toString(),
      { Authorization: `Bearer ${provider.apiKey}` },
      provider.timeout,
    )) as Record<string, unknown>;

    const items = Array.isArray(body.items) ? body.items : [];
    const hasMore = body.has_more === true;
    return {
      voices: items.map(fromFish).filter((v): v is Voice => v !== null),
      hasMore,
      ...(hasMore ? { nextCursor: String(pageNumber + 1) } : {}),
    };
  }

  // By name alone: the ids here are the vendor's opaque strings, and matching
  // them would answer a one-letter search with every voice whose id happens to
  // contain that letter.
  const term = options.query?.toLowerCase();
  const voices = inlineVoices(entry).filter(
    (v) => !term || v.name.toLowerCase().includes(term),
  );
  return { voices, hasMore: false };
}

/**
 * Read one voice by the id stored on a node, so the panel can name it.
 * @param modelName - The model's catalog name.
 * @param voiceId - The value stored in the node's params.
 * @returns The voice, or null when this provider no longer carries that id.
 * @throws {AppError} 404 when the model is unknown or offers no voices, 503
 *   when no provider of it is configured, 502 when the upstream refuses.
 */
export async function getVoice(
  modelName: string,
  voiceId: string,
): Promise<Voice | null> {
  const { entry, modality } = findModel(modelName);
  assertOffersVoices(entry);

  const provider = providerServing(modality, modelName);

  if (provider.providerName === "elevenlabs") {
    // Single reads stayed on v1 when the list moved to v2.
    const url = new URL(
      `/v1/voices/${encodeURIComponent(voiceId)}`,
      new URL(provider.baseUrl).origin,
    );
    const body = await readJson(
      url.toString(),
      { "xi-api-key": provider.apiKey },
      provider.timeout,
    );
    return fromElevenLabs(body);
  }

  if (provider.providerName === "fish") {
    const url = new URL(`/model/${encodeURIComponent(voiceId)}`, provider.baseUrl);
    const body = await readJson(
      url.toString(),
      { Authorization: `Bearer ${provider.apiKey}` },
      provider.timeout,
    );
    return fromFish(body);
  }

  return inlineVoices(entry).find((v) => v.id === voiceId) ?? null;
}
