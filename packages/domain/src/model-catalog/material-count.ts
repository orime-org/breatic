// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many pieces of material a run asks its reader for (#269, #2156).
 */

import { missingSources, type SourcedModel } from "@breatic/shared";

/**
 * The pieces of material one model in one mode asks a reader to supply.
 *
 * Every requirement an empty run leaves unmet is one piece: a required slot,
 * a pool the reader has to put something in, or a group of which one member
 * is enough.
 * @param model - The model, with its parameter declarations and groups.
 * @param mode - The mode being asked about.
 * @returns How many separate pieces the reader has to point at.
 */
export function materialCount(model: SourcedModel, mode: string): number {
  return missingSources(model, mode, {}).length;
}
