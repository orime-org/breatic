// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two generation modes the user toggles between: text-to-image and
 * image-to-image. A model belongs to a mode when its `mode` field includes
 * that value (a multi-mode `["i2i", "edit"]` model belongs to `i2i`).
 */

import type { ModeOption } from '@web/spaces/canvas/generate/ModeToggle';
import { resolveAvailableMode } from '@web/spaces/canvas/generate/mode-selection';

export type ImageGenMode = 't2i' | 'i2i';

/**
 * The image modes, in display order (text-to-image first — the default).
 *
 * Labels are English only, never localized (user 2026-07-10 item 15): they are
 * product mode names in the do-not-translate spirit of the DNT glossary, so
 * they read identically across all locales.
 *
 * Here rather than inside `ImageModeToggle` (#1951): the container has to
 * narrow this list to the modes the deployment can serve before the picker
 * ever sees it, and a module-private const in a component file is out of its
 * reach. The video panel's list already lives in a plain module for the same
 * reason.
 */
export const IMAGE_MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  { value: 't2i', label: 'Text to Image', testId: 'generate-mode-t2i' },
  { value: 'i2i', label: 'Image to Image', testId: 'generate-mode-i2i' },
];

/** Where a node lands when nothing it stored can be served (#1951). */
const NO_AVAILABLE_MODE_FALLBACK: ImageGenMode = 't2i';

/**
 * Reads a node's stored generation sub-mode, resolved against what this
 * deployment can actually serve (#1951).
 *
 * Availability is the test, not legality: a stored `t2i` on a deployment with
 * no text-to-image model resolves to whatever IS offered, because a mode with
 * no model is one this deployment does not have and the picker will not list
 * it. Nothing is written back — this is derived per render.
 *
 * The fallback is only reachable when the panel has no mode at all to offer,
 * and the panel does not open at all in that case (`CatalogGatedFrame`). It
 * exists so the return type stays the narrow union its callers need.
 * @param stored - The node's stored `mode` (free string on the wire).
 * @param availableModes - The image modes with at least one model, in display order.
 * @returns The active {@link ImageGenMode}.
 */
export function resolveMode(
  stored: string | undefined,
  availableModes: readonly { value: string }[],
): ImageGenMode {
  const resolved = resolveAvailableMode(stored, availableModes);
  return resolved === 'i2i' || resolved === 't2i'
    ? resolved
    : NO_AVAILABLE_MODE_FALLBACK;
}

/**
 * Whether this image mode consumes the `@`-picked reference pool (#1952).
 *
 * One statement, four readers, mirroring what the video panel has had all
 * along (`video-mode-options.ts`): the payload collects the picked URLs only
 * for a mode that says yes, the rail dims the content of every reference
 * material row for a mode that says no, the `@` picker drops those rows from
 * its list, and the Focus trigger follows too — a focus crop IS a reference
 * image (#1782), so the mode that cannot use one cannot make one either.
 *
 * A named function rather than four `mode === 't2i'` literals: they were the
 * same question answered four times, which is exactly the shape this slice
 * exists to remove.
 * @param mode - The active image mode.
 * @returns True when this mode reads reference images.
 */
export function imageModeTakesReferences(mode: ImageGenMode): boolean {
  return mode !== 't2i';
}
