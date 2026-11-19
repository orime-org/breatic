// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { inputRefusalText, readTaskFailure, uploadableFormatList } from '@breatic/shared';

import { getCachedUnderstandMaxBytes } from '@web/data/api/canvas';
import { whoseKey, type KeyFailureWords } from '@web/features/byok/key-failure-words';
import { formatBytes } from '@web/lib/format-bytes';
import type { useTranslation } from '@web/i18n/use-translation';

/** The medium a node holds, when it holds one of the three. */
type Medium = 'image' | 'video' | 'audio';

/**
 * What a sentence naming a refused file is given to select on.
 *
 * The sentences take a name and a format, and each half a refusal did not
 * carry drops its part of the clause rather than printing a gap where a name
 * belongs. `none` is the word the catalogs' `select` arms are written
 * against; this file spells it twice — here for the name and the format, and
 * in {@link failureSentence} for the size, whose value is a number this does
 * not hold. Changing the word means changing both, and the ten catalog arms
 * that read it.
 * @param about - What the refusal carried, from either gate.
 * @param about.file - What the file is called, when the refusal named it.
 * @param about.type - What format it is in, when the refusal named that.
 * @returns The parameters to format the sentence with.
 */
export function refusalClause(about: {
  file?: string | null;
  type?: string | null;
}): { file: string; type: string } {
  return { file: about.file ?? 'none', type: about.type ?? 'none' };
}

/**
 * What a failed run is told to the user.
 *
 * A cause this product knows travels as a code and becomes a sentence here,
 * where the user's language is. Anything else is what some provider said
 * about its own failure, and it travels as itself.
 *
 * One home, because the same failure reaches the user two ways: on the
 * node's task list and in its history. A reading is the first kind of run to
 * store codes rather than a provider's prose, so a surface printing the
 * stored text raw shows `understand_over_cap` in every language.
 *
 * The two reading refusals take what the browser's own gates say when they
 * refuse first — the ceiling, and the file's own name and format. A node
 * restored from history carries neither type nor size, so those gates stay
 * silent about it and the run is what refuses; this row is then the only
 * place the user is told, and it says as much as the toast would have.
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
 * @param keys - Whose key a failure of the payer's own key was to the viewer, and each upstream's name on screen, off
 *   the Project's key plan; without it the sentence names no owner and the upstream by its id.
 * @returns The sentence, or the stored text when it is not ours to name.
 */
export function failureSentence(
  stored: string | null | undefined,
  t: ReturnType<typeof useTranslation>,
  medium?: Medium,
  keys?: KeyFailureWords,
): string {
  const held = readTaskFailure(stored ?? null);
  const reason = held.reason;
  if (reason === null) return stored ?? '';
  // #1521: the limit a refused run broke, said the way the panel and the server say it.
  if (reason === 'input_refused' && held.limit !== undefined) return inputRefusalText({ reason: '', limit: held.limit }, held.model ?? '');
  const ceiling = getCachedUnderstandMaxBytes();
  // The formats are named for the sentences that carry them; the rest hold no
  // such placeholder and ICU leaves an unused parameter alone. A node holding
  // no listed medium falls to the `other` arm, which names nothing and needs
  // nothing.
  return t(`canvas.task.failure.${reason}`, {
    kind: medium ?? 'other',
    formats: medium === undefined ? '' : uploadableFormatList(medium),
    ...refusalClause(held),
    // The size the run measured, for the one sentence that names it. A
    // refusal that carried none selects the arm without that clause.
    bytes: held.bytes === undefined ? 'none' : formatBytes(held.bytes),
    // The one sentence reading it selects on this word, so a ceiling that has
    // not arrived yet drops the clause rather than printing a blank.
    limit: ceiling === null ? 'unknown' : formatBytes(ceiling),
    // Which reading failed, off the record itself, so the row and history agree
    // (inner#856). Always a value: ICU throws on a select with none.
    reading: held.reading ?? 'other',
    // The model a refusal or a missing setup is about, and the variables it needs.
    model: held.model ?? '',
    envVars: (held.envVars ?? []).join(', '),
    // The upstream an account's own key failed on or whose key is gone, by its name on screen, whose key it was, and
    // why (inner#1953). Always a value: ICU throws on a select with none, and the gone-key sentence selects on `none`
    // to drop the upstream a run did not record.
    upstream: held.upstream === undefined ? 'none' : (keys?.upstreamNames[held.upstream] ?? held.upstream),
    whose: whoseKey(keys, held.keyOwner),
    keyReason: held.keyReason ?? 'other',
  });
}
