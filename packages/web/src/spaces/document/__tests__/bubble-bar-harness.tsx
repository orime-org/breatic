// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Putting the bubble bar on screen, and opening one of its slots.
 *
 * The waits are not decoration. The bar reaches the document one render after
 * the selection changes, and a slot's menu one render after the pointer
 * arrives, so a synchronous query runs ahead of both and finds nothing.
 */

import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

/**
 * Render the editor, carrier and all, into the document.
 * @param editor - An editor with its body already in place.
 */
export function mountDocumentEditor(editor: Editor): void {
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} />
    </TooltipProvider>,
  );
}

/**
 * Move the pointer onto one slot and wait for its menu.
 * @param slotId - That slot's test id.
 * @returns The opened menu element.
 */
export async function hoverOpenSlot(slotId: string): Promise<HTMLElement> {
  act(() => {
    fireEvent.pointerEnter(screen.getByTestId(slotId));
  });
  return waitFor(() => screen.getByTestId(`${slotId}-menu`));
}
