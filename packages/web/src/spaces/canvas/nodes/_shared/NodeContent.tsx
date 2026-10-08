// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

interface NodeContentProps {
  hasContent: boolean;
  placeholder: React.ReactNode;
  content: React.ReactNode;
}

/**
 * Switches between placeholder and content on whether a content payload
 * exists. A node shows no task state (inner#888 §7.8): what its tasks did is
 * the counts column beside it and the task list, so a running task leaves the
 * body on whatever it already holds and a failed one leaves it empty.
 * Type-node bodies pass their modality-specific renderers.
 * @param root0 - Node content props.
 * @param root0.hasContent - Whether a content payload exists.
 * @param root0.placeholder - Empty-state node rendered when the node holds nothing.
 * @param root0.content - Modality-specific body rendered when the node holds something.
 * @returns The branch element for the current node state.
 */
export function NodeContent({
  hasContent,
  placeholder,
  content,
}: NodeContentProps): React.JSX.Element {
  // An empty node fills a fixed h-48 box so every empty node is the same size
  // regardless of modality; a filled node grows to its content's real height.
  return hasContent ? (
    <>{content}</>
  ) : (
    <div data-testid='node-content-empty' className='h-48'>
      {placeholder}
    </div>
  );
}
