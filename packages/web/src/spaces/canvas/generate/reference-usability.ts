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
 * A third question joined them in #1966: does the active model consume the
 * prompt at all (`ModelEntry.takes_prompt`)? That every mode sends a prompt
 * stopped being true in #1950 — a model that declares none mounts no editor —
 * and the answer used to live in the video container, which refused the insert
 * itself. It moved in here so that "can this row act" has ONE home (#1962).
 *
 * Both controls start from the ROW KIND, and from there each asks only what
 * can actually refuse that kind:
 *
 * | Row kind | {@link insertRefusal} asks, in order | {@link removeRefusal} asks |
 * |---|---|---|
 * | text | Is there a prompt | Is there a prompt |
 * | image / audio / video / … | Does this mode use references; is there a prompt; is this row an image | Does this mode use references |
 *
 * Two properties fall out of that shape, and both are the point. The two
 * controls on one row always give the SAME first answer, so a row never shows
 * two different reasons for being frozen. And every reason names a state the
 * user can leave and arrive somewhere the row works: a media row becomes usable
 * in a mode that takes references, a text row in a mode that sends a prompt.
 * Asking a media row about the prompt first would have sent its user to t2v /
 * i2v / first_last / animate — all of which send a prompt and still refuse it.
 *
 * Insert then asks two more, because insertion needs more than removal does: a
 * destination to insert INTO, and a row the pool can carry.
 *
 * The dim still reads on REFERENCE MATERIAL alone: a text row is prompt
 * material, and the dim rule's subject is the reference material, not every row
 * in the rail (user 2026-08-13).
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
  | 'source-type-unused'
  | 'mode-sends-no-prompt';

/** What the active mode does with the reference pool. */
export interface ReferenceModeContext {
  /**
   * Does this mode consume the `@`-picked pool at all (`modeTakesReferences`
   * on the video panel, `!imageSourcesOff` on the image one)? This is the
   * row-level dimension: false dims every REFERENCE MATERIAL row and freezes
   * its ✕. Text rows are outside it — see the module docstring.
   */
  takesReferences: boolean;
  /**
   * Does the ACTIVE MODEL consume the prompt (`ModelEntry.takes_prompt`,
   * #1966)? False freezes INSERT on every row — there is no editor to insert
   * into — and freezes the ✕ on TEXT rows, which are prompt material and have
   * nothing to be material FOR under such a mode (user 2026-08-16).
   *
   * A plain boolean the caller passes in, exactly like `takesReferences`: the
   * value comes from the model catalog, but this module still reads nothing
   * asynchronous itself — the thing the module docstring keeps out of here.
   */
  takesPrompt: boolean;
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
 * @param ctx - What the active mode does with references, and whether its model sends a prompt.
 * @returns The refusal reason, or null when the row can be inserted.
 */
export function insertRefusal(
  sourceNodeType: NodeKind,
  ctx: ReferenceModeContext,
): ReferenceRefusal | null {
  // A text row lives in the prompt and nowhere else, so the prompt question is
  // the only one that can refuse it. The video container used to ask this one,
  // reading the same `promptRequired` its editor mounts on; that second home is
  // what #1962 removed.
  if (!isReferenceMaterial(sourceNodeType)) {
    return ctx.takesPrompt ? null : 'mode-sends-no-prompt';
  }
  // For a media row the reference question comes first, and it comes first for
  // the reason the whole module exists: of the two refusals, only this one
  // names a state the user can leave and reach a mode where the row WORKS.
  // Leading with "there is no prompt box" sends them to t2v / i2v /
  // first_last / animate, which all send a prompt and still refuse this row.
  // It also keeps the two controls on a row agreeing: {@link removeRefusal}
  // asks the same first question, so one row never shows two different reasons.
  if (!ctx.takesReferences) return 'mode-takes-no-references';
  // The mode does use references, so now the destination matters: with no
  // prompt there is no box to put the `@` chip in. Unreachable in today's
  // catalog — the one mode that takes references also sends a prompt — but the
  // order has to be total.
  if (!ctx.takesPrompt) return 'mode-sends-no-prompt';
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
 * (decision 2026-08-11). That premise — "this mode cannot use the row" — holds
 * for reference MATERIAL. A text row is prompt material, so it answers to the
 * OTHER question: a mode whose model sends no prompt cannot use a text row
 * either, and freezing it there is the same protection for the same reason
 * (#1965, user 2026-08-13 + 2026-08-16).
 *
 * So each row kind gets exactly the question that applies to it, and this is
 * where remove parts company with {@link insertRefusal}. Insert names only the
 * cause, so asking "is there a prompt to insert into" first is right for every
 * row. Remove has to name the way OUT, and the two questions lead to different
 * exits: a media row becomes removable in a mode that TAKES REFERENCES, and
 * telling its user to "switch to a mode that sends a prompt" sends them to
 * t2v / i2v / first_last / animate, where the ✕ refuses all the same. Asking
 * the reference question for media rows is what keeps that advice true.
 *
 * The three media kinds still answer identically, which is what stops audio and
 * video rows from staying removable inside a dimmed mode while image rows
 * freeze (#1940).
 * @param sourceNodeType - The upstream node's modality.
 * @param ctx - What the active mode does with references, and whether its model sends a prompt.
 * @returns The refusal reason, or null when the row can be removed.
 */
export function removeRefusal(
  sourceNodeType: NodeKind,
  ctx: ReferenceModeContext,
): ReferenceRefusal | null {
  // A text row lives in the prompt: one prompt is shared across the modes
  // (#1919), so removing it under a mode with no prompt would take it out of
  // every mode that does send one. Switching to such a mode is a way out that
  // actually works for it, because the reference question never applied here.
  if (!isReferenceMaterial(sourceNodeType)) {
    return ctx.takesPrompt ? null : 'mode-sends-no-prompt';
  }
  return ctx.takesReferences ? null : 'mode-takes-no-references';
}
