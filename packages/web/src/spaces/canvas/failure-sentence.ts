// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  READABLE_FORMAT_LIST,
  asTaskFailureReason,
  uploadableFormatList,
} from '@breatic/shared';

import { getCachedUnderstandMaxBytes } from '@web/data/api/canvas';
import { formatBytes } from '@web/lib/format-bytes';
import type { useTranslation } from '@web/i18n/use-translation';

/** The medium a node holds, when it holds one of the three. */
type Medium = 'image' | 'video' | 'audio';

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
 *
 * The two reading refusals take what the browser's own gates say when they
 * refuse first — the ceiling, the formats. A node restored from history
 * carries neither type nor size, so those gates stay silent about it and the
 * run is what refuses; this row is then the only place the reader is told,
 * and it says as much as the toast would have.
 *
 * A reading's row sits on the text node it writes to, and a text node holds
 * no medium — so a reading's refusal names every format a reading takes
 * rather than asking the node it is drawn on which ones to name. `medium` is
 * the upload lane's, where the row does sit on the node holding the file.
 * @param stored - What the row holds — a code of ours, or a provider's words.
 * @param t - The translator.
 * @param medium - What the host node holds, for a refusal that names formats.
 * @returns The sentence, or the stored text when it is not ours to name.
 */
export function failureSentence(
  stored: string | null | undefined,
  t: ReturnType<typeof useTranslation>,
  medium?: Medium,
): string {
  const reason = asTaskFailureReason(stored ?? null);
  if (reason === null) return stored ?? '';
  const ceiling = getCachedUnderstandMaxBytes();
  // The formats are named for the sentences that carry them; the rest hold no
  // such placeholder and ICU leaves an unused parameter alone. A node holding
  // no listed medium falls to the `other` arm, which names nothing and needs
  // nothing.
  return t(`canvas.task.failure.${reason}`, {
    kind: medium ?? 'other',
    formats:
      reason === 'understand_unsupported_type'
        ? READABLE_FORMAT_LIST.join(' / ')
        : medium === undefined
          ? ''
          : uploadableFormatList(medium),
    // The one sentence reading it selects on this word, so a ceiling that has
    // not arrived yet drops the clause rather than printing a blank.
    limit: ceiling === null ? 'unknown' : formatBytes(ceiling),
  });
}
