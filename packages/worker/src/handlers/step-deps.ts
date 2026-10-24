// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The storage and helpers a task's upstream steps run against in production
 * (#2156): the two step and clone repositories, a source's cache key read
 * off the asset ledger, and the one-sentence description a Kling element is
 * created with.
 */

import { getRawEnvVar, getStorageAdapter, getUnderstandConfig } from "@breatic/core";
import {
  assetRepo,
  readingLimitsUntil,
  understandMediaAt,
  upstreamCloneRepo,
  upstreamStepRepo,
  UNDERSTAND_PINS,
} from "@breatic/domain";

import type { StepDeps } from "@worker/providers/run-steps.js";
import { withUnderstandSlot } from "@worker/handlers/understand-slots.js";

/** What the element description is asked to be. */
const DESCRIBE_QUESTION =
  "Describe the main subject of this image in one plain sentence of at most 100 characters.";

/**
 * The step storage for a task run in a studio.
 * @param studioId - The studio whose assets key the clone cache, or null.
 * @param deadlineAt - When the task runs out; a description it asks for gets
 *   what is left of it (inner#1367).
 * @returns The dependencies `runCatalogTask` takes.
 */
export function stepDepsFor(studioId: string | null, deadlineAt: number): StepDeps {
  return {
    steps: upstreamStepRepo,
    clones: upstreamCloneRepo,
    /**
     * The asset's sha256 behind one of our storage urls, whichever studio
     * registered it: a node pasted from another studio keeps the url.
     * @param url - A source url.
     * @returns The hash, or null for a url that is not one of our assets.
     */
    sourceKeyOf: async (url: string): Promise<string | null> => {
      if (studioId === null) return null;
      const key = (await getStorageAdapter()).keyFromUrl(url);
      return key === null ? null : assetRepo.findHashByStorageKey(key);
    },
    /**
     * One sentence about an image, from the understand model.
     * @param url - The image.
     * @returns The sentence and what it cost; a service that reported no cost is recorded at 0.
     * @throws {StillRunning} when every reading place in this process is taken.
     */
    describeImage: async (url: string): Promise<{ text: string; costUsd: number }> => {
      const cfg = getUnderstandConfig();
      let costUsd = 0;
      const answer = await withUnderstandSlot(() => understandMediaAt({
        items: [{ url }],
        question: DESCRIBE_QUESTION,
        model: UNDERSTAND_PINS.model,
        backend: UNDERSTAND_PINS.backend,
        apiKey: getRawEnvVar("OPENROUTER_API_KEY") ?? "",
        baseUrl: UNDERSTAND_PINS.baseUrl,
        maxBytes: cfg.max_media_bytes,
        ...readingLimitsUntil(deadlineAt, cfg.max_media_bytes),
        maxOutputTokens: cfg.max_output_tokens,
        onBilled: (billed) => {
          costUsd = billed ?? 0;
        },
      }));
      return { text: answer.text.trim(), costUsd };
    },
  };
}
