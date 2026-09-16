// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #916 acceptance C1 to C3: the text being linked stays visibly marked.
 *
 * The panel takes the focus so the reader can type an address, and a
 * contenteditable that is not focused has its selection painted by nobody. The
 * mark that stands in for it is a ProseMirror decoration, which survives the
 * focus leaving because it is the document's own render and not the browser's.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  openSharedBody,
  mountDocumentEditor,
  closeShared,
  focusBody,
  selectTextRange,
  type HarnessEditor,
} from './bubble-bar-harness';

const HREF = 'https://a.example/docs';

/** Body `see<a>our docs</a>for more`. Offsets come from {@link offsetsOfText}. */
const ONE_LINK = `<p>see<a href="${HREF}">our docs</a>for more</p>`;

afterEach(() => {
  cleanup();
  closeShared();
});

/**
 * Opens an editor over {@link ONE_LINK} and mounts it.
 * @returns The editor.
 */
function mounted(): HarnessEditor {
  const editor = openSharedBody(ONE_LINK);
  mountDocumentEditor(editor);
  return editor;
}

/**
 * Where the given text starts, counted the way `selectTextRange` counts.
 *
 * It takes character offsets across the body's text nodes, not ProseMirror
 * positions — its own docstring says so, and the two differ by however many
 * nodes wrap each block.
 * @param editor - The editor.
 * @param needle - The text to find.
 * @returns The offsets it occupies.
 * @throws {Error} When the body does not hold it.
 */
function offsetsOfText(
  editor: HarnessEditor,
  needle: string,
): { from: number; to: number } {
  let text = '';
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.isText) text += node.text ?? '';
    return true;
  });
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${JSON.stringify(needle)} in the body`);
  return { from: at, to: at + needle.length };
}

/**
 * The text the selection mark covers, if any.
 * @param editor - The editor.
 * @returns The marked text, or null when nothing is marked.
 */
function markedText(editor: HarnessEditor): string | null {
  const marked = editor.prosemirrorView?.dom.querySelectorAll(
    '[data-show-selection]',
  );
  if (!marked || marked.length === 0) return null;
  return [...marked].map((node) => node.textContent ?? '').join('');
}

/**
 * Selects the given text and presses the bubble bar's link button.
 * @param editor - The editor.
 * @param needle - The text to select.
 */
async function openPanelOver(
  editor: HarnessEditor,
  needle: string,
): Promise<void> {
  const { from, to } = offsetsOfText(editor, needle);
  focusBody(editor);
  selectTextRange(editor, from, to);
  await waitFor(() => {
    expect(screen.getByTestId('doc-bubble-tool-link')).toBeInTheDocument();
  });
  await userEvent.click(screen.getByTestId('doc-bubble-tool-link'));
  await waitFor(() => {
    expect(screen.getByTestId('doc-link-popover')).toBeInTheDocument();
  });
}

describe('the text a new link is being written onto', () => {
  it('is marked while the panel holds the focus', async () => {
    const editor = mounted();

    await openPanelOver(editor, 'see');

    expect(markedText(editor)).toBe('see');
  });

  it('stays marked while the reader types an address', async () => {
    const editor = mounted();
    await openPanelOver(editor, 'see');

    await userEvent.type(screen.getByTestId('doc-link-input'), 'example.com');

    expect(markedText(editor)).toBe('see');
  });

  // The two cases below are green before the mark exists at all — a negative
  // assertion holds while the thing it denies is missing. What they are here
  // for is the other direction: once the mark is being drawn, forgetting to
  // take it away turns them red.
  it('is no longer marked once the panel closes', async () => {
    const editor = mounted();
    await openPanelOver(editor, 'see');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-popover')).not.toBeInTheDocument();
    });

    expect(markedText(editor)).toBeNull();
  });

  it('marks nothing while no panel is open', () => {
    const editor = mounted();
    const { from, to } = offsetsOfText(editor, 'see');
    focusBody(editor);
    selectTextRange(editor, from, to);

    expect(markedText(editor)).toBeNull();
  });
});
