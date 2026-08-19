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
 * Only ONE control asks anything now (#1952): the ✕ removes a row in every
 * state, so there is nothing left for it to refuse. What the user can no
 * longer USE and what they can no longer GET RID OF stopped being the same
 * question — the second one has no answer but yes.
 *
 * {@link insertRefusal} starts from the ROW KIND and asks only what can
 * actually refuse that kind:
 *
 * | Row kind | asks, in order |
 * |---|---|
 * | text | Is there a prompt |
 * | image / audio / video / … | Does this mode use references; is there a prompt; is this row an image |
 *
 * Every reason names a state the user can leave and arrive somewhere the row
 * works: a media row becomes usable in a mode that takes references, a text row
 * in a mode that sends a prompt. Asking a media row about the prompt first
 * would have sent its user to t2v / i2v / first_last / animate — all of which
 * send a prompt and still refuse it.
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
 * Why a rail control refuses to act. Three reasons, each with its own remedy:
 * switch to a mode that uses references, bring an image instead, or switch to
 * a model that takes a prompt.
 *
 * One message per reason, three in all. The `source-type-unused` one varies by
 * modality through ICU rather than through a second key.
 */
export type ReferenceRefusal =
  | 'mode-takes-no-references'
  | 'source-type-unused'
  | 'model-takes-no-prompt';

/**
 * What the rail needs to know to answer for a row: one fact about the active
 * MODE (does it use the reference pool) and one about the active MODEL (does
 * it take a prompt). Named for what it is used for rather than for either
 * source, because the two fields do not share one — see each field.
 */
export interface ReferenceUsabilityContext {
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
 * @param ctx - What the active mode does with references, and whether its model takes a prompt.
 * @returns The refusal reason, or null when the row can be inserted.
 */
export function insertRefusal(
  sourceNodeType: NodeKind,
  ctx: ReferenceUsabilityContext,
): ReferenceRefusal | null {
  // A text row lives in the prompt and nowhere else, so the prompt question is
  // the only one that can refuse it. The video container used to ask this one,
  // reading the same `promptRequired` its editor mounts on; that second home is
  // what #1962 removed.
  if (!isReferenceMaterial(sourceNodeType)) {
    return ctx.takesPrompt ? null : 'model-takes-no-prompt';
  }
  // For a media row the reference question comes first, and it comes first for
  // the reason the whole module exists: of the two refusals, only this one
  // names a state the user can leave and reach a mode where the row WORKS.
  // Leading with "there is no prompt box" sends them to t2v / i2v /
  // first_last / animate, which all send a prompt and still refuse this row.
  if (!ctx.takesReferences) return 'mode-takes-no-references';
  // The mode does use references, so now the destination matters: with no
  // prompt there is no box to put the `@` chip in. Unreachable in today's
  // catalog — the one mode that takes references also sends a prompt — but the
  // order has to be total.
  if (!ctx.takesPrompt) return 'model-takes-no-prompt';
  // The pool is the image pool — see the module docstring. Everything else is
  // a legitimate connection (an edge carries creative intent as well as data
  // use, user 2026-08-13) that this pool has no way to carry.
  return sourceNodeType === 'image' ? null : 'source-type-unused';
}
