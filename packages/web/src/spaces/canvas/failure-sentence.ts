// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { asTaskFailureReason, uploadableFormatList } from '@breatic/shared';

import type { useTranslation } from '@web/i18n/use-translation';

/**
 * What a failed run is told to the reader.
 *
 * A cause this product knows travels as a code and becomes a sentence here,
 * where the reader's language is. Anything else is what some provider said
 * about its own failure, and it travels as itself.
 *
 * One home, because the same failure reaches the reader two ways: on the
 * node's task list and in its history. A reading is the first kind of run to
 * store codes rather than a provider's prose, so a surface printing the
 * stored text raw shows `understand_over_cap` in every language.
 * @param stored - What the row holds — a code of ours, or a provider's words.
 * @param t - The translator.
 * @param medium - What the host node holds, for a refusal that names formats.
 * @returns The sentence, or the stored text when it is not ours to name.
 */
export function failureSentence(
  stored: string | null | undefined,
  t: ReturnType<typeof useTranslation>,
  medium?: 'image' | 'video' | 'audio',
): string {
  const reason = asTaskFailureReason(stored ?? null);
  if (reason === null) return stored ?? '';
  // The formats are named for the one sentence that carries them; the rest
  // hold no such placeholder and ICU leaves an unused parameter alone. A node
  // holding no listed medium falls to the `other` arm, which names nothing
  // and needs nothing.
  return t(`canvas.task.failure.${reason}`, {
    kind: medium ?? 'other',
    formats: medium === undefined ? '' : uploadableFormatList(medium),
  });
}
