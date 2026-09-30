// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two carriers a reader opens a comment from (#18, A1 · A2 · A3).
 *
 * Both entries already stood in their carriers with nothing behind them, and
 * what these pin is the path a reader takes: press the entry, get the box.
 * The bubble bar is driven through the mounted editor, so the wiring is under
 * test as well as the command — a `canRun` that answers correctly says
 * nothing about whether a press reaches it.
 *
 * The bubble bar's entry becomes a tool like the four marks beside it, so its
 * test id follows theirs. Its old id said the command was not open yet.
 *
 * TDD: red because neither entry is wired.
 */

import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { TooltipProvider } from '@web/components/ui/tooltip';
import {
  closeShared,
  focusBody,
  mountDocumentEditor,
  openSharedBody,
  selectTextRange,
  type HarnessEditor,
} from '@web/spaces/document/__tests__/bubble-bar-harness';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { draftRangeIn } from '@web/spaces/document/document-comment-draft-range';

afterEach(() => {
  cleanup();
  closeShared();
});

/** A block as `editor.document` hands it back. */
interface Seen {
  readonly id: string;
}

/**
 * Opens the block handle's menu over one row, the way its own tests do.
 * @param editor - The editor.
 * @param index - Which row the pointer is over.
 */
function openMenuOver(editor: HarnessEditor, index: number): void {
  const block = (editor.document as unknown as Seen[])[index]!;
  render(
    <TooltipProvider>
      <DropdownMenu open>
        <DropdownMenuTrigger />
        <DropdownMenuContent>
          <DocumentBlockMenu
            editor={editor as never}
            block={block as never}
            close={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>,
  );
}

describe('the bubble bar entry', () => {
  it('aims a draft at the words the reader selected', async () => {
    const editor = openSharedBody('<p>alpha bravo charlie</p>');
    mountDocumentEditor(editor);
    focusBody(editor);
    selectTextRange(editor, 0, 5);

    await userEvent.click(await screen.findByTestId('doc-bubble-tool-comment'));

    // The range is the whole of what this entry does. Where a comment is
    // then written, and what it looks like, is the panel's (A28).
    await waitFor(() => {
      expect(draftRangeIn(editor.prosemirrorState)).not.toBeNull();
    });
    const at = draftRangeIn(editor.prosemirrorState)!;
    expect(editor.prosemirrorState.doc.textBetween(at.from, at.to)).toBe(
      'alpha',
    );
  });

  it('stays out of the tab order, the way the whole bar does', async () => {
    const editor = openSharedBody('<p>alpha bravo charlie</p>');
    mountDocumentEditor(editor);
    focusBody(editor);
    selectTextRange(editor, 0, 5);

    const entry = await screen.findByTestId('doc-bubble-tool-comment');
    expect(entry.getAttribute('tabindex')).toBe('-1');
  });
});

describe('the block handle entry', () => {
  it('opens a draft over the whole row', async () => {
    const editor = openSharedBody('<p>alpha bravo charlie</p>');
    openMenuOver(editor, 0);

    await userEvent.click(await screen.findByTestId('doc-block-row-comment'));

    const range = draftRangeIn(editor.prosemirrorState);
    expect(range).not.toBeNull();
    expect(
      editor.prosemirrorState.doc.textBetween(range!.from, range!.to),
    ).toBe('alpha bravo charlie');
  });

  it('is unavailable on a row with no words in it', async () => {
    // A3: an empty row covers no run, so there is nothing for a press to mark
    // and the row says so rather than looking usable (R7).
    const editor = openSharedBody('<p></p>');
    openMenuOver(editor, 0);

    const row = await screen.findByTestId('doc-block-row-comment');
    expect(row.getAttribute('aria-disabled')).toBe('true');

    await userEvent.click(row);
    expect(draftRangeIn(editor.prosemirrorState)).toBeNull();
  });
});
