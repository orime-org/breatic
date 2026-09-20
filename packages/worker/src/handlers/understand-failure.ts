// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a failed understand run as something the node's row can hold
 * (#2175).
 *
 * The capability says why it failed in its own vocabulary — five ways an
 * address yields nothing, five ways a service refuses. The row stores one of
 * ours, which is turned into a sentence where the reader is. The two
 * vocabularies meet here and nowhere else.
 */

import { MediaUnavailable, UnderstandRefused } from "@breatic/domain";
import type { RefusalKind, UnavailableKind } from "@breatic/domain";
import {
  assetNameFromUrl,
  encodeTaskFailure,
  formatNameOf,
  type TaskFailureReason,
} from "@breatic/shared";

/** What each way an address can yield nothing is stored as. */
const UNAVAILABLE_AS: Readonly<Record<UnavailableKind, TaskFailureReason>> = {
  unreachable: "source_unreachable",
  "unsupported-type": "understand_unsupported_type",
  "too-large": "understand_over_cap",
  slow: "source_too_slow",
  empty: "empty",
};

/**
 * What each way a service can refuse is stored as.
 *
 * Not one code between them. `internal` promises the address was fine and
 * that sending it again is what the person does next — true of the two that
 * are about this deployment or this moment, and false of the other three: the
 * safety gate refused this question, the service refused these bytes, and the
 * backend could not reach the address we handed it.
 */
const REFUSAL_AS: Readonly<Record<RefusalKind, TaskFailureReason>> = {
  "content-filter": "declined",
  media: "media_refused",
  unfetchable: "source_unreachable",
  deployment: "internal",
  transient: "internal",
};

/**
 * The service answered, and the answer was empty.
 *
 * Nothing refused anything, so neither vocabulary above has a word for it:
 * the run finished with no reading to put on the node. It is a type rather
 * than a message because a message read back as a code is a sentence trusted
 * to stay spelled that way.
 */
export class AnsweredNothing extends Error {
  /** Builds the error a run with an empty answer throws. */
  public constructor() {
    super("the model answered nothing");
    this.name = "AnsweredNothing";
  }
}

/**
 * Kinds whose verdict a second attempt would only repeat.
 *
 * Each says something about the media or the question rather than about the
 * moment: the same bytes are the same size and the same format, and the same
 * question asked of the same service is refused the same way. The kinds left
 * out name the address, this deployment, or the draw itself — an answer that
 * came back empty is one a service sampled, and asking again genuinely
 * samples another. So {@link AnsweredNothing} is not one of these, and the
 * run's remaining attempts are spent on it.
 */
const SETTLED: ReadonlySet<string> = new Set([
  "unsupported-type",
  "too-large",
  "empty",
  "content-filter",
  "media",
]);

/**
 * Whether running this job again would reach the same refusal.
 *
 * Worth asking because a repeat is not free here: it re-reads the media, up
 * to the ceiling, and a refusal from the service means the call was paid for.
 * @param err - Whatever the run threw.
 * @returns True when another attempt would land on the same answer.
 */
export function verdictStands(err: unknown): boolean {
  if (err instanceof MediaUnavailable) return SETTLED.has(err.kind);
  if (err instanceof UnderstandRefused) return SETTLED.has(err.kind);
  return false;
}

/**
 * Read what a run threw as the code its row holds.
 * @param err - Whatever the run threw.
 * @returns The stored code, which the reader is told in their own language.
 */
export function understandFailureCode(err: unknown): TaskFailureReason {
  if (err instanceof MediaUnavailable) return UNAVAILABLE_AS[err.kind];
  if (err instanceof UnderstandRefused) return REFUSAL_AS[err.kind];
  if (err instanceof AnsweredNothing) return "no_result";
  // Something on our side broke, and which part is in the log rather than on
  // the node: a reader has the same thing to do either way.
  return "internal";
}

/**
 * What a failed read's row holds: the code, and the file it was about.
 *
 * A refusal over a file leaves the reader asking which of theirs this was,
 * and what about it we would not take. This run holds every part of that
 * answer at the moment it refuses — the address it was handed names the
 * asset, and the classification carries the type it judged and the size it
 * measured — so they are written down here rather than left for a surface
 * that cannot reach them (user 2026-09-20).
 *
 * A cause that says nothing about a file adds nothing; `encodeTaskFailure`
 * settles that, and stores the bare code.
 * @param err - Whatever the run threw.
 * @param sourceUrl - The address this run was handed.
 * @returns What to store in the row's `error_message`.
 */
export function understandFailureMessage(
  err: unknown,
  sourceUrl: string | undefined,
): string {
  const reason = understandFailureCode(err);
  const about = err instanceof MediaUnavailable ? err : undefined;
  const refusedTheFile =
    reason === "understand_unsupported_type" || reason === "understand_over_cap";
  return encodeTaskFailure(reason, {
    ...(refusedTheFile && {
      file: assetNameFromUrl(sourceUrl) ?? undefined,
      type: formatNameOf(about?.declaredType) ?? undefined,
      bytes: about?.bytes,
    }),
  });
}
