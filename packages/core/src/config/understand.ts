// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Understand run loader (#2175).
 *
 * Reads `config/understand.yaml`: what a canvas run reading a node's media
 * into text is allowed to take in media size, output tokens and concurrency.
 *
 * Its own file rather than a section of the agent's, because the two are
 * separate runs with separate ceilings — the agent's are sized for a
 * conversation reading several pieces of media in turn, and these are sized
 * for one press producing one task.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const understandConfigSchema = z.object({
  max_media_bytes: z.number().int().positive().default(20_971_520),
  max_output_tokens: z.number().int().positive().default(8_192),
  transcribe_max_output_tokens: z.number().int().positive().default(65_536),
  max_concurrent: z.number().int().positive().default(5),
  long_media: z.object({
    max_source_bytes: z.number().int().positive().default(2_147_483_648),
    max_sources: z.number().int().positive().default(10),
    max_segment_bytes: z.number().int().positive().default(20_000_000),
    audio_core_seconds: z.number().int().positive().default(300),
    video_core_seconds: z.number().int().positive().default(60),
    max_active_leaves: z.number().int().positive().default(512),
    max_concurrent_encoders: z.number().int().positive().default(2),
    delivery_concurrency: z.number().int().positive().default(2),
    per_operation_delivery_concurrency: z.number().int().positive().default(1),
    operation_lease_ms: z.number().int().positive().default(30_000),
    container_class: z.literal("LongMediaContainerStd4").default("LongMediaContainerStd4"),
    container_max_instances: z.number().int().positive().default(2),
    profile_version: z.string().min(1).max(64).default("source-file-v1"),
    audio_codec: z.string().min(1).max(32).default("libmp3lame"),
    audio_bitrate: z.string().min(1).max(16).default("128k"),
    video_codec: z.string().min(1).max(32).default("libx264"),
    video_crf: z.number().int().min(0).max(51).default(23),
    video_audio_codec: z.string().min(1).max(32).default("aac"),
    video_audio_bitrate: z.string().min(1).max(16).default("128k"),
  }).strict().default({
    max_source_bytes: 2_147_483_648,
    max_sources: 10,
    max_segment_bytes: 20_000_000,
    audio_core_seconds: 300,
    video_core_seconds: 60,
    max_active_leaves: 512,
    max_concurrent_encoders: 2,
    delivery_concurrency: 2,
    per_operation_delivery_concurrency: 1,
    operation_lease_ms: 30_000,
    container_class: "LongMediaContainerStd4",
    container_max_instances: 2,
    profile_version: "source-file-v1",
    audio_codec: "libmp3lame",
    audio_bitrate: "128k",
    video_codec: "libx264",
    video_crf: 23,
    video_audio_codec: "aac",
    video_audio_bitrate: "128k",
  }),
});

/** Validated understand configuration. */
export type UnderstandConfig = z.infer<typeof understandConfigSchema>;

let _cached: Readonly<UnderstandConfig> | null = null;

/**
 * Load the understand run's ceilings from YAML.
 * @returns Frozen, validated config, memoized after the first read.
 * @throws {z.ZodError} When a value is malformed.
 */
export function getUnderstandConfig(): Readonly<UnderstandConfig> {
  if (_cached) return _cached;

  const raw = readFileSync(
    resolve(MONOREPO_ROOT, "config/understand.yaml"),
    "utf-8",
  );
  const parsed = understandConfigSchema.parse(parse(raw) as unknown);
  _cached = Object.freeze({ ...parsed, long_media: Object.freeze(parsed.long_media) });
  return _cached;
}
