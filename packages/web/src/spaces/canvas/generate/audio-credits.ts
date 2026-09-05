// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ModelEntry, ModelRate } from '@breatic/shared';

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
 * Two kinds of model sit on this one panel, and the model itself says which it
 * is. One bills by how much it is given, so the number follows what the user
 * has set: at 10 credits per 1000 characters, 2000 characters read 20; at 1
 * credit per 5 seconds, a 30-second effect reads 6. The other bills a flat sum
 * per call — the two music models charge the same whether the brief is four
 * words or four hundred — and states it as `cost_per_call`, the same field the
 * image and video panels print.
 *
 * The model is passed rather than its rate because answering undefined without
 * one made the panel drop the whole line, and the price before spending it is
 * the one thing that line exists to say (#1960).
 *
 * An estimate, not the charge — charging happens after generation on the usage
 * the vendor reports. Part-credits round up, since a fraction of a credit is
 * not a thing that gets charged.
 * @param model - The selected model, or undefined when none is picked yet.
 * @param input - The prompt and, on a model that takes one, the clip length.
 * @returns The credits, or undefined when no model is picked.
 */
export function estimateAudioCredits(
  model: ModelEntry | undefined,
  input: BillableInput,
): number | undefined {
  if (!model) return undefined;
  const rate: ModelRate | undefined = model.rate;
  if (!rate) return model.cost_per_call;
  const units = COUNTERS[rate.unit](input);
  return Math.ceil((units / rate.per) * rate.credits);
}
