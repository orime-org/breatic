// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `config/voice-samples.json`: where the voice samples we generate are served
 * from, and what each one says (#2156, #2239).
 *
 * Every deployment plays the samples from `base_url`, one fixed public
 * address, whatever bucket that deployment stores its own assets in. The
 * catalog's `sample_key`s are paths under it; the worker's `pnpm
 * voice-samples` makes the ones that address does not serve yet.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MONOREPO_ROOT } from "@breatic/core";

/** `config/voice-samples.json`. */
export interface VoiceSampleConfig {
  /** The public address every sample key is served under, without a trailing slash. */
  base_url: string;
  /** Language tag -> the sentence, and the `{boost}` a model may send with it. */
  languages: Record<string, { text: string; boost?: string }>;
  /** Model name -> fields sent beyond text and voice; `{boost}` is filled in. */
  extra_body: Record<string, Record<string, string>>;
}

let cached: VoiceSampleConfig | undefined;

/**
 * Whether a JSON value is an object.
 * @param value - The value.
 * @returns True for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check the parsed file.
 * @param raw - The file's JSON.
 * @returns The config.
 * @throws {Error} When the address, the sentences or the extras are malformed.
 */
export function parseVoiceSampleConfig(raw: unknown): VoiceSampleConfig {
  const { base_url: baseUrl, languages, extra_body: extraBody } = (raw ?? {}) as Record<string, unknown>;
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("https://") || baseUrl.endsWith("/")) {
    throw new Error("config/voice-samples.json: `base_url` must be an https address without a trailing slash");
  }
  if (!isRecord(languages) || !isRecord(extraBody)) {
    throw new Error("config/voice-samples.json needs `languages` and `extra_body` objects");
  }
  for (const [tag, said] of Object.entries(languages)) {
    if (!isRecord(said) || typeof said.text !== "string" || said.text === "") {
      throw new Error(`config/voice-samples.json: language "${tag}" needs a text`);
    }
  }
  return { base_url: baseUrl, languages, extra_body: extraBody } as VoiceSampleConfig;
}

/**
 * Read `config/voice-samples.json`, once.
 * @returns The config.
 * @throws {Error} When the file is missing or malformed.
 */
export function getVoiceSampleConfig(): VoiceSampleConfig {
  cached ??= parseVoiceSampleConfig(
    JSON.parse(readFileSync(resolve(MONOREPO_ROOT, "config/voice-samples.json"), "utf8")),
  );
  return cached;
}

/**
 * The public address of one generated sample.
 * @param key - The catalog's `sample_key`.
 * @returns The url every deployment plays it from.
 * @throws {Error} When the config file is missing or malformed.
 */
export function voiceSampleUrl(key: string): string {
  return `${getVoiceSampleConfig().base_url}/${key}`;
}
