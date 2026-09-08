// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The voices a tts model offers (#1960).
 *
 * These types live here rather than beside the catalog reader because both
 * ends read them: the backend assembles a page from whichever vendor this
 * deployment resolved to, and the panel's voice picker renders it.
 *
 * `sanitizeVoicePage` is the trust boundary, the same shape as
 * `sanitizeModelCatalog`: the page is built from a vendor's response, so the
 * web layer runs it through once and every reader downstream can trust the
 * types instead of re-guarding each field.
 */

import { z } from "zod";

/** One voice, as the panel reads it. */
export interface Voice {
  /** The value this deployment's provider accepts for the model's voice param. */
  id: string;
  name: string;
  description?: string;
  languages?: string[];
  /** Audio to play as a sample. Absent where the provider offers none. */
  previewUrl?: string;
}

/** One page of voices. */
export interface VoicePage {
  voices: Voice[];
  hasMore: boolean;
  /**
   * Opaque token for the next page, absent on the last one. Opaque because the
   * vendors disagree on what paging is: one takes a continuation token, the
   * other a page number, and callers work with neither.
   */
  nextCursor?: string;
}

/**
 * One voice. `id` and `name` are required with no fallback: the id is what
 * gets written into the request and the name is the only thing the user has to
 * choose by, so an entry missing either is dropped rather than repaired.
 */
const voiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().catch(undefined),
  languages: z.array(z.string()).optional().catch(undefined),
  previewUrl: z.string().optional().catch(undefined),
});

/** An empty page, the answer whenever the payload is unusable. */
const EMPTY_PAGE: VoicePage = { voices: [], hasMore: false };

const voicePageSchema = z
  .object({
    voices: z
      .array(z.unknown())
      .catch([])
      .transform((list) =>
        list.flatMap((entry) => {
          const parsed = voiceSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
    hasMore: z.boolean().catch(false),
    nextCursor: z.string().optional().catch(undefined),
  })
  .catch(EMPTY_PAGE)
  // Paging asks for `nextCursor`, so "there is more" without one would send
  // the list refetching the page it already has, forever.
  .transform((page) =>
    page.hasMore && page.nextCursor === undefined
      ? { ...page, hasMore: false }
      : page,
  );

/**
 * Sanitizes an untrusted voices response into a trusted {@link VoicePage}.
 * Never throws: malformed voices are dropped, malformed fields are coerced,
 * and total garbage yields an empty page.
 * @param raw - The raw response payload (already unwrapped from the envelope).
 * @returns A structurally valid page.
 */
export function sanitizeVoicePage(raw: unknown): VoicePage {
  return voicePageSchema.parse(raw);
}
