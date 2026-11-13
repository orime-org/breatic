// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The attributes a copied formula carries its LaTeX in (inner#1423). The chat
 * writes them on what it copies and the document body reads them back, so a
 * formula pasted from a reply arrives as a formula; anywhere else the copy
 * reads as its `$$` text.
 */

/** The attribute an inline formula's source travels in. */
export const MATH_SOURCE_ATTR = 'data-math';

/** The attribute a block formula's source travels in. */
export const MATH_BLOCK_SOURCE_ATTR = 'data-math-block';
