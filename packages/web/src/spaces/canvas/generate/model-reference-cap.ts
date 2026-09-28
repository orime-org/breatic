// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many reference images the model in front of the user takes (#1928).
 *
 * The video Generate panel's submit gate refuses a submission carrying more
 * than this. Adding a reference image on the canvas is a separate question
 * with a separate answer — the site-wide pool cap, which knows nothing about
 * models (#2112).
 */

import type { ModelEntry } from '@breatic/shared';
import { itemCap, positiveCap, REFERENCE_POOL_PARAM } from '@breatic/shared';

/**
 * The reference-image cap for one node's current model.
 * @param model - The catalog entry the node has selected, or undefined while the catalog has not answered.
 * @returns The cap, or undefined when the model is unknown or states none.
 */
export function modelReferenceCap(model: ModelEntry | undefined): number | undefined {
  const descriptor = model?.params[REFERENCE_POOL_PARAM];
  if (!descriptor) return undefined;
  return positiveCap(itemCap(descriptor));
}
