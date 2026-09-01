// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Code units per code point, at worst.
 *
 * Memory is cut in code points, which is where a character ends, and the
 * assembled payload is measured in code units, which is what a string's
 * length is. Everything outside the basic plane — emoji, and every script
 * that lives above it — is two units per point, and the consolidating prompt
 * asks the model to answer in the language of the conversation.
 *
 * Two readers, and they have to agree: the turn budget reserves this much
 * room below the keep line, and the config loader refuses a pair of ceilings
 * that would leave that line at or below zero. Written twice, one of them
 * drifts and the loader starts admitting a config the budget cannot work to.
 */
export const MEMORY_RESERVE_FACTOR = 2;
