// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ModelRate } from '@breatic/shared';

/**
 * What a generation bills against, whichever unit its model states.
 *
 * Two shapes travel together because one panel serves both kinds of model and
 * only the rate says which one is read.
 */
export interface BillableInput {
  /** The prompt as it stands. */
  text: string;
  /**
   * The clip length the user picked, on a model that has one.
   *
   * Optional because the speech models declare no length: the node holds
   * nothing for it, and their rates count the prompt instead.
   */
  seconds?: number;
}

/** Counts the units one vendor bills by, for the generation about to be sent. */
const COUNTERS: Record<ModelRate['unit'], (input: BillableInput) => number> = {
  // Spread, not `.length`: the latter counts UTF-16 code units, so one emoji
  // reads as two and a vendor charging per character would look twice as
  // expensive as it is.
  characters: (input) => [...input.text].length,
  utf8_bytes: (input) => new TextEncoder().encode(input.text).length,
  // A sound effect is priced by the length asked for, and the description is
  // free. Absent means the node holds no length yet, which reads as nothing
  // to charge for rather than as some length of our choosing.
  seconds: (input) => input.seconds ?? 0,
};

/**
 * What one generation off this prompt would cost, in credits.
 *
 * The video panel prints its model's cost per call, a number that does not
 * move. An audio model bills by how much it is given, so this follows what the
 * user has set: at 10 credits per 1000 characters, 2000 characters read 20;
 * at 1 credit per 5 seconds, a 30-second effect reads 6.
 *
 * An estimate, not the charge — charging happens after generation on the usage
 * the vendor reports. Part-credits round up, since a fraction of a credit is
 * not a thing that gets charged.
 * @param rate - What the model bills, or undefined when it states no rate.
 * @param input - The prompt and, on a model that takes one, the clip length.
 * @returns The credits, or undefined when the model states no rate.
 */
export function estimateAudioCredits(
  rate: ModelRate | undefined,
  input: BillableInput,
): number | undefined {
  if (!rate) return undefined;
  const units = COUNTERS[rate.unit](input);
  return Math.ceil((units / rate.per) * rate.credits);
}
