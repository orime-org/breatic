// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Whether a reference rail row can act, and when it cannot, why (#1945).
 *
 * The rail expresses two independent things and used to carry both in one
 * boolean, which is how it got both wrong: a mode that ignores references
 * dimmed only the IMAGE rows, and insertability was decided by asking whether
 * the row's modality could connect to an IMAGE node — a question copied from
 * the image panel, where `audio → image` really is a pre-rules legacy edge. On
 * a video node `audio → video` is a currently legal connection, so the same
 * question turned a live edge into a dead one.
 *
 * Splitting them gives each control one question to answer:
 *
 * | Dimension | Asked by | Decides |
 * |---|---|---|
 * | Does this mode use references at all | {@link removeRefusal} | row dim + ✕ |
 * | Is this row's modality consumed this run | {@link insertRefusal} | insert + `@` picker |
 *
 * Text rows sit outside both: their `@` chip substitutes into the prompt
 * STRING, which every mode sends, so they are never reference material and
 * never dim: text is not reference material, it is prompt material (user
 * 2026-08-13).
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
   */
  allowedSourceTypes: readonly SourceType[];
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
  return (ctx.allowedSourceTypes as readonly string[]).includes(sourceNodeType)
    ? null
    : 'source-type-unused';
}

/**
 * Decides whether a row's ✕ can remove it. Deliberately takes no row argument:
 * references are shared across modes, so a row thrown away in a mode that
 * ignores it would be gone on switching back (decision 2026-08-11) — and that
 * verdict is the same for all four modalities. Reading the row's type here is
 * exactly what let audio / video rows stay removable inside a dimmed mode
 * while image rows were frozen (#1940).
 * @param ctx - What the active mode does with references.
 * @returns The refusal reason, or null when the row can be removed.
 */
export function removeRefusal(
  ctx: ReferenceModeContext,
): ReferenceRefusal | null {
  return ctx.takesReferences ? null : 'mode-takes-no-references';
}
