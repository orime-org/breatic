// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three alignment rows, and the icon an opener draws for a reading.
 *
 * Two carriers offer these commands — the bubble bar's alignment slot and the
 * block handle's menu — and the rows are the same rows: one list, one order,
 * one set of labels and icons. Written out twice they drift, and the repo's
 * own rule is to reach for what is already there rather than draw a near copy
 * (`packages/web/CLAUDE.md`).
 */

import {
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
} from 'lucide-react';
import type * as React from 'react';

import type {
  Alignment,
  AlignFace,
} from '@web/spaces/document/document-align-run';

/** One row of the alignment menu. */
export interface AlignItem {
  /** Which alignment the row writes, and the stem of its test id. */
  readonly id: Alignment;
  /** The catalog key for the row's label. */
  readonly labelKey: string;
  /** The row's icon. */
  readonly Icon: React.ComponentType<{ className?: string }>;
}

/** The alignment menu's three rows, from the demo's alignment menu. */
export const ALIGN_ITEMS: readonly AlignItem[] = [
  {
    id: 'left',
    labelKey: 'spaces.document.commands.alignLeft',
    Icon: TextAlignStart,
  },
  {
    id: 'center',
    labelKey: 'spaces.document.commands.alignCenter',
    Icon: TextAlignCenter,
  },
  {
    id: 'right',
    labelKey: 'spaces.document.commands.alignRight',
    Icon: TextAlignEnd,
  },
];

/**
 * The icon an opener draws for what a range reads as.
 *
 * Where no single alignment is in force — the covered blocks disagree, or
 * alignment reaches none of them — this lands on the left row's icon, the way
 * CKEditor 5 binds its opener to the command's value and falls back to the
 * writing direction's default (`alignmentui.ts`). Naming one of the covered
 * alignments instead would tell the reader the whole range is where that one
 * block is.
 * @param face - What the range reads as.
 * @returns The icon to draw.
 */
export function alignFaceIcon(
  face: AlignFace,
): React.ComponentType<{ className?: string }> {
  return ALIGN_ITEMS.find((item) => item.id === face)?.Icon ?? TextAlignStart;
}
