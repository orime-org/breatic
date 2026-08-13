// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Whether a reference rail row can act, and when it cannot, why (#1945).
 *
 * The rail expresses two independent things and used to carry both in one
 * boolean, which is how it got both wrong.
 *
 * The dim was the visible half: it reached only the IMAGE rows, so audio and
 * video rows stayed bright and removable inside a mode that would never read
 * them (#1930, #1940).
 *
 * The insert criterion was the invisible half. It asked whether the row's
 * modality could connect to an IMAGE node — the image panel's question, where
 * `audio → image` really is a pre-rules legacy edge. On a video node,
 * `audio → video` is a currently legal connection, so the question was wrong
 * even where its ANSWER happened to be right: under every mode reachable
 * today the two criteria agree verdict for verdict. What changes is the
 * reason a row is refused, and what happens next — when a mode's references
 * start accepting video, the rule moves in domain's table and nothing here
 * needs touching.
 *
 * Splitting them gives each control one question to answer:
 *
 * | Dimension | Asked by | Decides |
 * |---|---|---|
 * | Does this mode use references at all | {@link removeRefusal} | row dim + ✕ |
 * | Is this row's modality consumed this run | {@link insertRefusal} | insert + `@` picker |
 *
 * Both dimensions read on REFERENCE MATERIAL. A text row is prompt material —
 * its `@` chip substitutes into the prompt STRING, which every mode sends —
 * so it sits outside both: always lit, always insertable, always removable
 * (user 2026-08-13: the dim rule's subject is the reference material, not
 * every row in the rail).
 */

import type { SourceType } from '@breatic/shared';

import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/**
 * Why a rail control refuses to act. Each value maps to one toast — the two
 * refusals are not interchangeable, because they suggest different remedies:
 * one says switch modes, the other says this model does not eat that.
 */
export type ReferenceRefusal =
  | 'mode-takes-no-references'
  | 'source-type-unused';

/** What the active mode does with the reference pool. */
export interface ReferenceModeContext {
  /**
   * Does this mode consume the `@`-picked pool at all (`modeTakesReferences`
   * on the video panel, `!imageSourcesOff` on the image one)? This is the
   * row-level dimension: false dims every row and freezes every ✕.
   */
  takesReferences: boolean;
  /**
   * The source types this mode's payload needs — the backend-computed
   * `ModelEntry.sourcesByMode[mode]`, whose rule lives in domain's
   * `MODE_REQUIRED_SOURCES`. Read rather than re-derived so a future mode that
   * accepts video references needs no frontend change.
   *
   * Independent of `takesReferences` above: `i2v` needs an image and takes it
   * from a SLOT, so its list is non-empty while its rail is dark.
   *
   * `undefined` and `[]` are DIFFERENT and must stay so. `undefined` means no
   * restriction has been stated — typically the model catalog has not resolved
   * yet, so nothing is known — and nothing is refused on those grounds. `[]`
   * is a statement: this mode consumes no source type at all. Collapsing the
   * first into the second made a lit rail refuse every media row with a reason
   * that was false, and it was stricter than the code it replaced.
   */
  allowedSourceTypes: readonly SourceType[] | undefined;
}

/**
 * Decides whether a row can be inserted into the prompt as an `@`-mention —
 * the same call the `@` picker filters with, so the two entry points cannot
 * drift into disagreeing about one row.
 * @param sourceNodeType - The upstream node's modality.
 * @param ctx - What the active mode does with references.
 * @returns The refusal reason, or null when the row can be inserted.
 */
export function insertRefusal(
  sourceNodeType: NodeKind,
  ctx: ReferenceModeContext,
): ReferenceRefusal | null {
  // Text is prompt material, not reference material: its substitution feeds
  // the prompt string in every mode (`video-task-payload.ts` sends
  // `prompt: promptText` with no mode branch), so no mode can refuse it.
  if (sourceNodeType === 'text') return null;
  // Mode before modality when both would refuse: "switch to a mode that uses
  // references" is actionable, "this model's references do not take audio" is
  // merely true.
  if (!ctx.takesReferences) return 'mode-takes-no-references';
  // Nothing stated about the consumable types: refuse nothing on those
  // grounds. The mode dimension above still applies, so an unresolved catalog
  // cannot turn a dark rail into a live one.
  if (ctx.allowedSourceTypes === undefined) return null;
  return (ctx.allowedSourceTypes as readonly string[]).includes(sourceNodeType)
    ? null
    : 'source-type-unused';
}

/**
 * Decides whether a row's ✕ can remove it.
 *
 * Freezing the ✕ in a mode that ignores references protects a row from being
 * thrown away before the user switches back to the mode that uses it
 * (decision 2026-08-11). That reasoning has a premise — "this mode cannot use
 * the row" — and it holds for reference MATERIAL only. A text row is prompt
 * material: every mode substitutes its content into the prompt string, so
 * there is never a mode that cannot use it, and nothing to hold in trust
 * (user 2026-08-13). Hence the row kind, and only that distinction: the three
 * media kinds always answer identically, which is what stops audio and video
 * rows from staying removable inside a dimmed mode while image rows freeze
 * (#1940).
 * @param sourceNodeType - The upstream node's modality.
 * @param ctx - What the active mode does with references.
 * @returns The refusal reason, or null when the row can be removed.
 */
export function removeRefusal(
  sourceNodeType: NodeKind,
  ctx: ReferenceModeContext,
): ReferenceRefusal | null {
  if (sourceNodeType === 'text') return null;
  return ctx.takesReferences ? null : 'mode-takes-no-references';
}
