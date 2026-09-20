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

import { COLOUR_HUES } from '../document-colour-run';

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

  it('draws itself unavailable where alignment reaches no block', async () => {
    // A list item is not one of the four block types alignment acts on, so
    // every row in the menu would be a press with nothing behind it (R7).
    await barOver('<ul><li><p>an item</p></li></ul>', 'an item');

    const opener = await screen.findByTestId('doc-bubble-align');

    expect(opener).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not open its menu while it is unavailable', async () => {
    await barOver('<ul><li><p>an item</p></li></ul>', 'an item');

    // The same event `hoverOpenSlot` opens a menu with, so a menu that still
    // opens here fails rather than passing for want of a trigger.
    await act(async () => {
      fireEvent.pointerEnter(screen.getByTestId('doc-bubble-align'));
    });

    expect(screen.queryByTestId('doc-bubble-align-menu')).toBeNull();
  });

  it('names itself the command rather than a promise of it', async () => {
    await barOver('<p>plain words</p>', 'plain words');

    const opener = await screen.findByTestId('doc-bubble-align');

    expect(opener.getAttribute('aria-label')).toBe(en.spaces.document.commands.align);
  });
});

/**
 * The lucide class on the icon an opener draws.
 *
 * Which icon is rendered is the observable identity of this face, so the
 * assertion reads the drawn svg rather than an attribute carrying the value
 * the icon is meant to come from — the rows and the greying already read that
 * value correctly, and a test on it would pass with the icon still nailed
 * down.
 * @param testId - The opener's test id.
 * @returns The `lucide-*` class, or undefined where no icon is drawn.
 */
function faceIcon(testId: string): string | undefined {
  const svg = screen.getByTestId(testId).querySelector('svg');
  return [...(svg?.classList ?? [])].find(
    (name) => name.startsWith('lucide-') && name !== 'lucide',
  );
}

describe('the alignment slot face', () => {
  it('draws the centre icon over a centred block', async () => {
    await barOver(
      '<p data-text-alignment="center">plain words</p>',
      'plain words',
    );

    expect(faceIcon('doc-bubble-align')).toBe('lucide-text-align-center');
  });

  it('draws the right icon over a right-aligned block', async () => {
    await barOver(
      '<p data-text-alignment="right">plain words</p>',
      'plain words',
    );

    expect(faceIcon('doc-bubble-align')).toBe('lucide-text-align-end');
  });

  it('draws the left icon over a block that was never aligned', async () => {
    // The prop's own default is `left`, so this block reads as left rather
    // than as nothing.
    await barOver('<p>plain words</p>', 'plain words');

    expect(faceIcon('doc-bubble-align')).toBe('lucide-text-align-start');
  });

  it('falls back to the left icon where the covered blocks disagree', async () => {
    // No single alignment is in force, and naming one of them on the bar would
    // claim the whole selection is where that one block is. CKEditor 5 binds
    // the opener to the command's value and falls back to the writing
    // direction's default for exactly this state (`alignmentui.ts`).
    const editor = openSharedBody(
      '<p data-text-alignment="center">first words</p>'
        + '<p data-text-alignment="right">second words</p>',
    );
    mountDocumentEditor(editor);
    focusBody(editor);
    selectTwoBlocks(editor);
    await waitForBar();

    expect(faceIcon('doc-bubble-align')).toBe('lucide-text-align-start');
  });

  it('falls back to the left icon where alignment reaches no block', async () => {
    await barOver('<ul><li><p>an item</p></li></ul>', 'an item');

    expect(screen.getByTestId('doc-bubble-align')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(faceIcon('doc-bubble-align')).toBe('lucide-text-align-start');
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

  it('leaves every fill cell border to the stylesheet', async () => {
    await barOver('<p>plain words</p>', 'plain words');
    await hoverOpenSlot('doc-bubble-color');
    await screen.findByTestId('doc-bubble-color-fill-pink');

    // The hue reaches each cell as a custom property and the border itself
    // stays a class, which is the only arrangement the `hover:` variant can
    // win under: an inline `borderColor` outranks every class, hover
    // included. Measured in a real browser 2026-09-19, all seven fill cells
    // read the same border under the pointer as at rest, while the text
    // cells — which set no inline border — moved from
    // `rgba(30, 30, 30, 0.12)` to `rgb(95, 95, 95)`.
    for (const hue of COLOUR_HUES) {
      const cell = screen.getByTestId(`doc-bubble-color-fill-${hue}`);
      expect(cell.style.borderColor).toBe('');
      expect(cell.style.getPropertyValue('--cell-edge')).not.toBe('');
    }
  });

  it('takes both marks off from the reset button', async () => {
    const editor = await barOver('<p>plain words</p>', 'plain words');
    colour(editor, { textColor: 'green' });
    colour(editor, { backgroundColor: 'orange' });
    await hoverOpenSlot('doc-bubble-color');

    await press('doc-bubble-color-reset');

    expect(firstRunStyles(editor)).toEqual({});
  });

  it('marks the cell of the run the selection opens on', async () => {
    const editor = await barOver('<p>alpha beta</p>', 'alpha beta');
    // `alpha` red, ` beta` left plain, then the whole line selected.
    const view = editor.prosemirrorView!;
    await act(async () => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 3, 8),
        ),
      );
    });
    colour(editor, { textColor: 'red' });
    await act(async () => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 3, 13),
        ),
      );
    });

    await hoverOpenSlot('doc-bubble-color');

    await waitFor(() => {
      expect(
        screen.getByTestId('doc-bubble-color-text-red'),
      ).toHaveAttribute('data-selected', 'true');
    });
    ['default', 'orange', 'green', 'blue', 'violet', 'pink', 'teal'].forEach(
      (cell) => {
        expect(
          screen.getByTestId(`doc-bubble-color-text-${cell}`),
        ).not.toHaveAttribute('data-selected');
      },
    );
  });

  it('draws itself unavailable where no block takes a colour', async () => {
    // A code block takes no marks, so every cell would be a press with
    // nothing behind it (R7).
    await barOver('<pre><code>const a = 1</code></pre>', 'const a = 1');

    const opener = await screen.findByTestId('doc-bubble-color');

    expect(opener).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not open its panel while it is unavailable', async () => {
    await barOver('<pre><code>const a = 1</code></pre>', 'const a = 1');

    // The same event `hoverOpenSlot` opens a menu with, so a menu that still
    // opens here fails rather than passing for want of a trigger.
    await act(async () => {
      fireEvent.pointerEnter(screen.getByTestId('doc-bubble-color'));
    });

    expect(screen.queryByTestId('doc-bubble-color-menu')).toBeNull();
  });

  it('stays available over a selection running into a code block', async () => {
    // One block it reaches is enough, which is how the alignment slot judges
    // the same shape of selection.
    const editor = openSharedBody(
      '<p>prose here</p><pre><code>const a = 1</code></pre>',
    );
    mountDocumentEditor(editor);
    focusBody(editor);
    selectTwoBlocks(editor);
    await waitForBar();

    const opener = await screen.findByTestId('doc-bubble-color');

    expect(opener).not.toHaveAttribute('aria-disabled');
  });

  it('closes its panel when the selection moves somewhere it cannot act', async () => {
    const editor = openSharedBody(
      '<p>prose here</p><pre><code>const a = 1</code></pre>',
    );
    mountDocumentEditor(editor);
    focusBody(editor);
    selectBlockText(editor, 'prose here');
    await waitForBar();
    await hoverOpenSlot('doc-bubble-color');

    await act(async () => {
      selectBlockText(editor, 'const a = 1');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-bubble-color-menu')).toBeNull();
    });
  });

  it('names itself the command rather than a promise of it', async () => {
    await barOver('<p>plain words</p>', 'plain words');

    const opener = await screen.findByTestId('doc-bubble-color');

    expect(opener.getAttribute('aria-label')).toBe(en.spaces.document.commands.color);
  });
});
