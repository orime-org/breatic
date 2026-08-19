// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import type { Editor } from '@tiptap/react';

interface SelectionBubbleBarProps {
  /** The editor this bar acts on. */
  editor: Editor;
  /** True for a viewer; the whole bar stays away. */
  readOnly?: boolean;
}

/**
 * The bar that floats above a selection, carrying the commands whose object is
 * the current selection or the block it sits in.
 * @param root0 - Bar props.
 * @param root0.editor - The editor this bar acts on.
 * @param root0.readOnly - True for a viewer.
 * @returns The bar, or null while it has nothing to show.
 */
export function SelectionBubbleBar({
  editor: _editor,
  readOnly: _readOnly = false,
}: SelectionBubbleBarProps): React.JSX.Element | null {
  return null;
}
