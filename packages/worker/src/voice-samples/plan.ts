// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which voice samples a deployment's bucket has to hold, and how each is made
 * (#2156, design §16.4).
 *
 * The keys are the catalog's own (`sample_key`, and `sample_keys` for a voice
 * that speaks whichever language the reader picks). A key names its language
 * by the path segment after the model — `voice-samples/<model>/<lang>/<voice>.mp3`
 * — and a key with no segment is English. The sentence each language says,
 * and anything a model takes beyond its text and voice, come from
 * `config/voice-samples.json`.
 */

import type { FullModelEntry } from "@breatic/domain";

/** `config/voice-samples.json`. */
export interface VoiceSampleConfig {
  /** Language tag -> the sentence, and the `{boost}` a model may send with it. */
  languages: Record<string, { text: string; boost?: string }>;
  /** Model name -> fields sent beyond text and voice; `{boost}` is filled in. */
  extra_body: Record<string, Record<string, string>>;
}

/** One sample to make. */
export interface VoiceSampleJob {
  model: string;
  key: string;
  /** The request body, in the upstream's field names. */
  body: Record<string, unknown>;
}

/** The tag a sample key without a language segment speaks. */
const DEFAULT_TAG = "en";

/**
 * The language a sample key names.
 * @param model - The model the key belongs to.
 * @param key - The key.
 * @returns The language tag.
 */
function tagOf(model: string, key: string): string {
  const rest = key.slice(`voice-samples/${model}/`.length).split("/");
  return rest.length > 1 ? (rest[0] as string) : DEFAULT_TAG;
}

/**
 * The upstream field a declared param is sent as.
 * @param entry - The model.
 * @param find - Which param.
 * @returns The field name, or undefined when the model declares no such param.
 */
function fieldOf(
  entry: FullModelEntry,
  find: (spec: NonNullable<FullModelEntry["params"]>[string]) => boolean,
): string | undefined {
  for (const [name, spec] of Object.entries(entry.params ?? {})) {
    if (find(spec)) return spec.upstream ?? name;
  }
  return undefined;
}

/**
 * Every sample the catalog's voices name, and the body that makes each one.
 * @param models - The tts models.
 * @param config - The sentences and per-model extras.
 * @returns One job per distinct sample key, in catalog order.
 * @throws {Error} When a key names a language with no sentence, or a model
 *   with samples declares no voice param.
 */
export function planVoiceSamples(models: readonly FullModelEntry[], config: VoiceSampleConfig): VoiceSampleJob[] {
  const jobs: VoiceSampleJob[] = [];
  for (const entry of models) {
    const voices = entry.voices ?? [];
    if (!voices.some((voice) => voice.sample_key !== undefined || voice.sample_keys !== undefined)) continue;
    const voiceField = fieldOf(entry, (spec) => spec.remote_source === "voices");
    if (voiceField === undefined) throw new Error(`${entry.name} has voice samples but no voice param`);
    const languageField = fieldOf(entry, (spec) => spec.value_locales !== undefined);
    const textField = entry.prompt_upstream ?? "prompt";

    /**
     * The job for one key.
     * @param voiceId - The voice.
     * @param key - The sample key.
     * @param language - The language param's value, for a many-language voice.
     * @returns The job.
     * @throws {Error} When the key's language has no sentence.
     */
    const jobFor = (voiceId: string, key: string, language?: string): VoiceSampleJob => {
      const tag = tagOf(entry.name, key);
      const said = config.languages[tag];
      if (said === undefined) throw new Error(`${key}: no sentence for language "${tag}"`);
      const extra = Object.fromEntries(
        Object.entries(config.extra_body[entry.name] ?? {}).map(([field, value]) => [
          field,
          value.replace("{boost}", said.boost ?? ""),
        ]),
      );
      return {
        model: entry.name,
        key,
        body: {
          [textField]: said.text,
          [voiceField]: voiceId,
          ...(language !== undefined && languageField !== undefined ? { [languageField]: language } : {}),
          ...extra,
        },
      };
    };

    for (const voice of voices) {
      const named = Object.entries(voice.sample_keys ?? {});
      // A key named both ways is one file: it is made once, in the language it names.
      if (voice.sample_key !== undefined && !named.some(([, key]) => key === voice.sample_key)) {
        jobs.push(jobFor(voice.id, voice.sample_key));
      }
      for (const [language, key] of named) jobs.push(jobFor(voice.id, key, language));
    }
  }
  return jobs;
}
