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
 * `audio → image` really is a pre-rules legacy edge, while on a video node
 * `audio → video` is a currently legal connection. The right question is not
 * about connections at all: what the rail feeds is `params.images`, a list of
 * image URLs, so a reference row is usable when it is an image.
 *
 * That list has TWO producers, and neither has anything to take from a
 * non-image row. A node row goes through `mentionedImageUrls`, whose
 * `imageUrlOf` resolves `kind === 'image'` and nothing else. A focus crop
 * never reaches that function — its pool id is `focus:<id>`, which matches no
 * canvas node — and is appended by the image panel's own `focusImages`
 * branch, from a crop that is an image by construction. So this predicate is
 * not re-evaluating one expression the payload also evaluates; it asks for
 * the one property both producers require.
 *
 * Splitting them gives each control the smallest question it can ask. Remove
 * asks the mode question alone; insert asks it too — mode first, so its
 * message names the state the user can leave — and then the modality one:
 *
 * | Asked by | Asks | Decides |
 * |---|---|---|
 * | {@link removeRefusal} | Does this mode use references at all | row dim + ✕ |
 * | {@link insertRefusal} | That, and then: is this row an image | insert + `@` picker |
 *
 * Both read on REFERENCE MATERIAL. A text row is prompt material — its `@`
 * chip substitutes into the prompt STRING — so it sits outside both: always
 * lit, always insertable, always removable (user 2026-08-13: the dim rule's
 * subject is the reference material, not every row in the rail).
 *
 * That every mode sends a prompt stopped being true in #1950: a model that
 * declares no `prompt` gets an empty one, and its panel mounts no editor to
 * insert into. Neither question here can see that — it comes from the model
 * catalog, which is exactly what the paragraph below keeps out of them — so
 * the video container refuses that insert itself, reading the same
 * `promptRequired` its editor mounts on.
 *
 * Neither dimension reads anything asynchronous, and that is deliberate. An
 * earlier version took the consumable types from `ModelEntry.sourcesByMode`,
 * which made both answers depend on whether the model catalog had loaded.
 * Three rounds of adversarial review produced three different wrong answers to
 * "what should the rail do meanwhile" — refuse everything with a false reason,
 * refuse nothing at all, then promise a wait that two of its three causes never
 * end. The question was the defect: a mode-level constant was being read
 * through an async, model-indexed channel.
 */

import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/**
 * Why a rail control refuses to act. Each value maps to one message, because
 * each suggests a different remedy: switch to a mode that uses references, or
 * bring an image instead.
 */
export type ReferenceRefusal =
  | 'mode-takes-no-references'
  | 'source-type-unused';

/** What the active mode does with the reference pool. */
export interface ReferenceModeContext {
  /**
   * Does this mode consume the `@`-picked pool at all (`modeTakesReferences`
   * on the video panel, `!imageSourcesOff` on the image one)? This is the
   * row-level dimension: false dims every REFERENCE MATERIAL row and freezes
   * its ✕. Text rows are outside it — see the module docstring.
   *
   * The only field, on purpose: what a lit rail can consume is not a variable
   * (see the module docstring), so nothing else has to be known to answer.
   */
  takesReferences: boolean;
}

/**
 * Whether a row is REFERENCE MATERIAL — the thing both dimensions read on.
 *
 * A named predicate rather than a check spelled out at each site: the dim, the
 * ✕ and the empty hint all ask this one question, and when two of them spelled
 * it differently ("is it one of the three media kinds" vs "is it not text")
 * they disagreed about `3d` and `web` — one lit the row while the other froze
 * its ✕. Text is the only modality that is not reference material, because it
 * is prompt material: its content substitutes into the prompt string.
 * @param kind - The upstream node's modality.
 * @returns True for everything except text.
 */
export function isReferenceMaterial(kind: NodeKind): boolean {
  return kind !== 'text';
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
  // Text is prompt material, and this question is about reference material, so
  // it passes here unconditionally. Whether the active model has a prompt to
  // insert INTO is a separate question this module cannot answer (#1950 — see
  // the module docstring); the video container asks it.
  if (!isReferenceMaterial(sourceNodeType)) return null;
  // Mode before modality when both would refuse. The mode reason names the
  // state the user can leave — this mode ignores references, another one does
  // not — while the modality reason names a rule that holds everywhere and
  // leaves nothing to do. Told both, the user can act on only one of them.
  if (!ctx.takesReferences) return 'mode-takes-no-references';
  // The pool is the image pool — see the module docstring. Everything else is
  // a legitimate connection (an edge carries creative intent as well as data
  // use, user 2026-08-13) that this pool has no way to carry.
  return sourceNodeType === 'image' ? null : 'source-type-unused';
}

/**
 * Decides whether a row's ✕ can remove it.
 *
 * Freezing the ✕ in a mode that ignores references protects a row from being
 * thrown away before the user switches back to the mode that uses it
 * (decision 2026-08-11). That reasoning has a premise — "this mode cannot use
 * the row" — and it holds for reference MATERIAL only. A text row is prompt
 * material, which this question is not about, so it stays removable
 * (user 2026-08-13). The reason given then — every mode substitutes it into
 * the prompt string, so no mode cannot use it — no longer holds for a model
 * that declares no prompt (#1950); whether such a mode should hold a text row
 * in trust too is open (#1965) and the behaviour here is unchanged. Hence the
 * row kind, and only that distinction: the three
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
  if (!isReferenceMaterial(sourceNodeType)) return null;
  return ctx.takesReferences ? null : 'mode-takes-no-references';
}
