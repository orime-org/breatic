// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #905 验收 A1 · A2 · A4 · A5 · A7 · A8 · A9: the two slots, wired.
 *
 * Both panels were drawn in #915 and pressed nothing. What the presses do to
 * the document is `document-align-run.ts` and BlockNote's own `addStyles` /
 * `removeStyles`; what is asserted here is that the cells reach them, and that
 * the mark each panel draws — the active alignment row, the cell in force —
 * reads the selection rather than a value written into the markup.
 *
 * The marks matter as much as the presses. A panel that always draws "default"
 * as the one in force tells the reader their red text is not red.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { screen, act, waitFor, fireEvent } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';

import en from '../../../../../../locales/en.json';

import {
  mountDocumentEditor,
  hoverOpenSlot,
  openSharedBody,
  closeShared,
  focusBody,
  selectBlockText,
  waitForBar,
  type HarnessEditor,
} from './bubble-bar-harness';

afterEach(() => {
  closeShared();
});

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content?: readonly { readonly styles?: Record<string, unknown> }[];
}

/**
 * Puts the bar on screen over the given words.
 * @param bodyHtml - The body.
 * @param words - The text to select.
 * @returns The editor.
 */
async function barOver(
  bodyHtml: string,
  words: string,
): Promise<HarnessEditor> {
  const editor = openSharedBody(bodyHtml);
  mountDocumentEditor(editor);
  focusBody(editor);
  selectBlockText(editor, words);
  await waitForBar();
  return editor;
}

/**
 * Selects from inside the first block to inside the second.
 * @param editor - The editor.
 */
function selectTwoBlocks(editor: HarnessEditor): void {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(doc, 3, doc.content.size - 3),
    ),
  );
}

/**
 * Colours the selection through the editor, leaving the selection where it is.
 * @param editor - The editor.
 * @param styles - What to add.
 */
function colour(
  editor: HarnessEditor,
  styles: Record<string, string>,
): void {
  editor.addStyles(styles as never);
  const view = editor.prosemirrorView!;
  const { anchor, head } = view.state.selection;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, anchor, head),
    ),
  );
}

/**
 * Presses one cell of an open panel.
 * @param testId - The cell's test id.
 */
async function press(testId: string): Promise<void> {
  const cell = await screen.findByTestId(testId);
  await act(async () => {
    fireEvent.click(cell);
  });
}

/**
 * What every block reads as.
 * @param editor - The editor.
 * @returns The blocks.
 */
function blocks(editor: HarnessEditor): ReadBlock[] {
  return editor.document as unknown as ReadBlock[];
}

/**
 * The styles on the first run of text in the first block.
 * @param editor - The editor.
 * @returns Those styles.
 */
function firstRunStyles(editor: HarnessEditor): Record<string, unknown> {
  return blocks(editor)[0]?.content?.[0]?.styles ?? {};
}

describe('the alignment slot, wired', () => {
  it('centres the selected paragraph when its row is pressed', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    await hoverOpenSlot('doc-bubble-align');

    await press('doc-bubble-align-item-center');

    expect(blocks(editor)[0]?.props['textAlignment']).toBe('center');
  });

  it('takes it back to the left', async () => {
    const editor = await barOver(
      '<p data-text-alignment="center">plain words</p>',
      'plain words',
    );
    await hoverOpenSlot('doc-bubble-align');

    await press('doc-bubble-align-item-left');

    expect(blocks(editor)[0]?.props['textAlignment']).toBe('left');
  });

  it('draws the row the selection is on, not always the left one', async () => {
    await barOver(
      '<p data-text-alignment="right">plain words</p>',
      'plain words',
    );

    await hoverOpenSlot('doc-bubble-align');

    await waitFor(() => {
      expect(
        screen.getByTestId('doc-bubble-align-item-right'),
      ).toHaveAttribute('data-active', 'true');
    });
    expect(screen.getByTestId('doc-bubble-align-item-left')).not.toHaveAttribute(
      'data-active',
    );
  });

  it('draws no row where the covered blocks disagree', async () => {
    const editor = openSharedBody(
      '<p data-text-alignment="center">first words</p>'
        + '<p data-text-alignment="right">second words</p>',
    );
    mountDocumentEditor(editor);
    focusBody(editor);
    selectTwoBlocks(editor);
    await waitForBar();

    await hoverOpenSlot('doc-bubble-align');

    await waitFor(() => {
      expect(screen.getByTestId('doc-bubble-align-item-left')).toBeTruthy();
    });
    ['left', 'center', 'right'].forEach((row) => {
      expect(
        screen.getByTestId(`doc-bubble-align-item-${row}`),
      ).not.toHaveAttribute('data-active');
    });
  });

  it('names itself the command rather than a promise of it', async () => {
    await barOver('<p>plain words</p>', 'plain words');

    const opener = await screen.findByTestId('doc-bubble-align');

    expect(opener.getAttribute('aria-label')).toBe(en.spaces.document.commands.align);
  });
});

describe('the colour slot, wired', () => {
  it('colours the selected words when a text hue is pressed', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    await hoverOpenSlot('doc-bubble-color');

    await press('doc-bubble-color-text-red');

    expect(firstRunStyles(editor)['textColor']).toBe('red');
  });

  it('takes the colour off again from the default cell', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    // Coloured through the editor rather than through the panel, so this case
    // fails while the cell does nothing. Pressing a hue that does nothing and
    // then a default that does nothing reads the same as both working.
    colour(editor, { textColor: 'violet' });
    await hoverOpenSlot('doc-bubble-color');

    await press('doc-bubble-color-text-default');

    expect(firstRunStyles(editor)['textColor']).toBeUndefined();
  });

  it('fills the selected words when a background hue is pressed', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    await hoverOpenSlot('doc-bubble-color');

    await press('doc-bubble-color-fill-teal');

    expect(firstRunStyles(editor)['backgroundColor']).toBe('teal');
  });

  it('takes the fill off again from the none cell', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    colour(editor, { backgroundColor: 'teal' });
    await hoverOpenSlot('doc-bubble-color');

    await press('doc-bubble-color-fill-none');

    expect(firstRunStyles(editor)['backgroundColor']).toBeUndefined();
  });

  it('marks the cell the selection carries, not always the default', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    colour(editor, { textColor: 'blue' });

    await hoverOpenSlot('doc-bubble-color');

    await waitFor(() => {
      expect(screen.getByTestId('doc-bubble-color-text-blue')).toHaveAttribute(
        'data-selected',
        'true',
      );
    });
    expect(
      screen.getByTestId('doc-bubble-color-text-default'),
    ).not.toHaveAttribute('data-selected');
  });

  it('marks the fill cell the selection carries', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    colour(editor, { backgroundColor: 'pink' });

    await hoverOpenSlot('doc-bubble-color');

    await waitFor(() => {
      expect(screen.getByTestId('doc-bubble-color-fill-pink')).toHaveAttribute(
        'data-selected',
        'true',
      );
    });
    expect(
      screen.getByTestId('doc-bubble-color-fill-none'),
    ).not.toHaveAttribute('data-selected');
  });

  it('takes both marks off from the reset button', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    colour(editor, { textColor: 'green' });
    colour(editor, { backgroundColor: 'orange' });
    await hoverOpenSlot('doc-bubble-color');

    await press('doc-bubble-color-reset');

    expect(firstRunStyles(editor)).toEqual({});
  });

  it('names itself the command rather than a promise of it', async () => {
    await barOver('<p>plain words</p>', 'plain words');

    const opener = await screen.findByTestId('doc-bubble-color');

    expect(opener.getAttribute('aria-label')).toBe(en.spaces.document.commands.color);
  });
});
