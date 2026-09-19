// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The external services a case can declare it needs.
 *
 * A clean machine has none of these. A case that needs one carries its tag,
 * and the default command excludes every tagged case — so the green a
 * developer sees covers what that machine can actually reach, and the cases
 * it could not reach never appear as passing.
 *
 * The list lives here because three separate things read it and none of
 * them may disagree: the guard that rejects a misspelt tag, the helper the
 * specs import, and the command that builds the default selection. A
 * misspelt tag is worse than no tag — the case reads as guarded and runs in
 * the default selection anyway, because the exclusion pattern never matches
 * it.
 *
 * Adding a tag is adding a service the suite can be told to skip, so it
 * comes with the same question every time: is this something a clean
 * machine genuinely cannot have, or something setup could build?
 */
export const SCENARIO_TAGS = [
  /** A real model provider key. */
  "@needs-model",
  /** A reachable public host. */
  "@needs-internet",
  /** R2 credentials and a reachable bucket. */
  "@needs-storage",
  /** The deployed ingest Worker, which a fresh clone never has. */
  "@needs-ingest",
  /** An ElevenLabs or Fish key, for the voice catalogue. */
  "@needs-tts",
  /** Stripe, and at least one credit pack on the screen. */
  "@needs-payments",
  /** A Brave Search credential. */
  "@needs-search",
  /** ffmpeg on the local PATH. */
  "@needs-ffmpeg",
] as const;

/** One of the declared scenario tags. */
export type ScenarioTag = (typeof SCENARIO_TAGS)[number];

/** Matches the prefix every scenario tag shares. */
export const SCENARIO_TAG_PREFIX = "@needs-";

/**
 * Answers whether a string is one of the declared tags.
 * @param candidate The text to check.
 * @returns Whether it appears in the list.
 */
export function isScenarioTag(candidate: string): candidate is ScenarioTag {
  return (SCENARIO_TAGS as readonly string[]).includes(candidate);
}
