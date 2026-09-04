// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ModelRate } from '@breatic/shared';

/** Counts the units one vendor bills by, for text about to be sent. */
const COUNTERS: Record<ModelRate['unit'], (text: string) => number> = {
  // Spread, not `.length`: the latter counts UTF-16 code units, so one emoji
  // reads as two and a vendor charging per character would look twice as
  // expensive as it is.
  characters: (text) => [...text].length,
  utf8_bytes: (text) => new TextEncoder().encode(text).length,
};

/**
 * What one generation off this prompt would cost, in credits.
 *
 * The video panel prints its model's cost per call, a number that does not
 * move. A tts model bills by how much text it is handed, so this follows the
 * prompt: at 10 credits per 1000 characters, 2000 characters read 20.
 *
 * An estimate, not the charge — charging happens after generation on the usage
 * the vendor reports. Part-credits round up, since a fraction of a credit is
 * not a thing that gets charged.
 * @param rate - What the model bills, or undefined when it states no rate.
 * @param text - The prompt as it stands.
 * @returns The credits, or undefined when the model states no rate.
 */
export function estimateAudioCredits(
  rate: ModelRate | undefined,
  text: string,
): number | undefined {
  if (!rate) return undefined;
  const units = COUNTERS[rate.unit](text);
  return Math.ceil((units / rate.per) * rate.credits);
}
