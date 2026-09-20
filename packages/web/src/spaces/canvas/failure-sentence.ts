// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readTaskFailure, uploadableFormatList } from '@breatic/shared';

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
 * A refusal names the file it happened to and the format it was in rather
 * than the formats a gate takes (user 2026-09-20). Both travel with the
 * cause, written down where the refusal was raised: this row sits on the text
 * node a reading writes to, which holds no file of its own, so anything it
 * did not carry here cannot be looked up from here. `medium` is the upload
 * lane's, where the row does sit on the node holding the file.
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
  const held = readTaskFailure(stored ?? null);
  const reason = held.reason;
  if (reason === null) return stored ?? '';
  const ceiling = getCachedUnderstandMaxBytes();
  // The formats are named for the sentences that carry them; the rest hold no
  // such placeholder and ICU leaves an unused parameter alone. A node holding
  // no listed medium falls to the `other` arm, which names nothing and needs
  // nothing.
  return t(`canvas.task.failure.${reason}`, {
    kind: medium ?? 'other',
    formats: medium === undefined ? '' : uploadableFormatList(medium),
    // Each sentence naming the file selects on these, so a half the failure
    // did not carry drops its part of the clause rather than printing a gap
    // where a name belongs.
    file: held.file ?? 'none',
    type: held.type ?? 'none',
    // The one sentence reading it selects on this word, so a ceiling that has
    // not arrived yet drops the clause rather than printing a blank.
    limit: ceiling === null ? 'unknown' : formatBytes(ceiling),
  });
}
