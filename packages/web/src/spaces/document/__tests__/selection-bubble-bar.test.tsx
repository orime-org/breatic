// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The selection bubble bar (task #112, step 4 of the menu system).
 *
 * #112 built the carrier with no new command of its own, so the one question
 * that mattered was: ONCE A COMMAND MOVES INTO THE NEW CARRIER, DOES PRESSING
 * IT THERE REALLY CHANGE THE DOCUMENT? #902 added underline and inline code,
 * and the bar now carries six commands, four menus and one entry not open yet. The
 * design adversarial round (2026-08-19) found that not one of the first ten
 * acceptance items covered this — `canRun` only decides whether a button
 * lights up, `run` is a different field on `ToolDef`, and reusing `canRun`
 * covers none of it. The press also lands outside the editor's own DOM, which
 * is the layer this carrier newly introduced.
 *
 * The test ids carry a carrier prefix (`doc-bubble-tool-*`): back in #112 a
 * toolbar and this bar rendered the same `ToolDef`s, so an unprefixed id named
 * two buttons and `DocumentEditor.test.tsx`'s `getByTestId` (which throws on
 * more than one match) went red. The toolbar went in 2026-08-22; the prefix
 * stays for #113's block handle menu, for the reason written in
 * `document-tool-button.tsx`'s module comment, where the prefix is built.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  bubbleAnchorRect,
  pinnedScreenPoint,
} from '@web/spaces/document/SelectionBubbleBar';
import {
  MARK_TOOLS,
  INLINE_TOOLS,
} from '@web/spaces/document/document-tools';

const editors: Editor[] = [];
let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
});

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
  doc.destroy();
  // Restore the stub `pinSelectionBox` puts on `Range.prototype`. Left in
  // place it leaks into every file that runs after it in the same jsdom
  // (`singleFork` builds the environment once).
  vi.restoreAllMocks();
});

/**
 * A real editor holding the given body, bound to a real Y.Doc.
 * @param bodyHtml - The body's HTML.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) editor.commands.setContent(bodyHtml);
  return editor;
}

/**
 * Select a run of text, with the editor really holding the focus.
 *
 * The focus is not decoration: the first of the bar's conditions is that the
 * editor holds it, and without it the bar never enters the document at all, so
 * every query comes back empty.
 * @param editor - The editor.
 * @param from - Where the selection starts.
 * @param to - Where it ends.
 */
async function selectWithFocus(
  editor: Editor,
  from: number,
  to: number,
): Promise<void> {
  act(() => {
    editor.view.dom.focus();
    editor.commands.setTextSelection({ from, to });
  });
  // The bar reaches the document one render after the selection changes, so a
  // synchronous assertion would run ahead of it and find nothing.
  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
    ).toBeGreaterThan(0);
  });
}

/**
 * Render the editor, carriers and all, into the document.
 *
 * Through the real `DocumentEditor` rather than a shell of our own: the bar
 * mounts inside the body's scroller, which only exists once the editor is
 * really in the document.
 * @param editor - An editor with its body already in place.
 * @param readOnly - Whether the editor is read-only.
 */
function mount(editor: Editor, readOnly = false): void {
  // Wrapped in a provider to stand in for App: the whole product has one
  // `TooltipProvider`, mounted in `App.tsx`, and the bar's two entries that
  // are not open yet explain themselves through a tooltip.
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} readOnly={readOnly} />
    </TooltipProvider>,
  );
}


/**
 * Whether the bar is on screen right now, read from the document.
 *
 * When the bar does not belong on screen the component does not render it, so
 * querying for the element IS the thing the reader sees. How the middleware is
 * configured is a local argument to `useFloating`, neither readable nor worth
 * reading — the behaviour it produces is pinned by items G1 through G3.
 * @returns True while the bar is in the document.
 */
function barOnScreen(): boolean {
  return screen.queryByTestId('doc-selection-bubble-bar') !== null;
}


/**
 * Pin the body scroller's visible area to a known box.
 *
 * Every rectangle is zero in jsdom, and the anchor logic asks "is this line in
 * view", which a zero box cannot answer.
 * @param box - The visible box to pin.
 */
function pinViewport(box: DOMRect): void {
  const viewport = document.querySelector(
    '.doc-body-scroller [data-radix-scroll-area-viewport]',
  );
  expect(viewport).not.toBeNull();
  (viewport as HTMLElement).getBoundingClientRect = () => box;
}

/**
 * The bar's anchor rectangle.
 *
 * Calls the function that computes it rather than reaching into the
 * positioning engine: which line the anchor lands on is this bar's own rule,
 * and swapping engines should not take that coverage with it.
 * @param editor - The editor.
 * @param pinned - The screen point a select-all is pinned to, or null.
 * @returns The rectangle, or null while the selection is empty.
 */
function anchorRectOf(
  editor: Editor,
  pinned: { x: number; y: number } | null = null,
): DOMRect | null {
  const viewport = document.querySelector<HTMLElement>(
    '.doc-body-scroller [data-radix-scroll-area-viewport]',
  );
  expect(viewport).not.toBeNull();
  return bubbleAnchorRect(
    editor.view,
    (viewport as HTMLElement).getBoundingClientRect(),
    pinned,
  );
}

/**
 * Where the bar sits vertically right now, read from its own positioning style.
 *
 * This is the only outlet "where the bar is" has towards the reader: however
 * the anchor is computed, it ends up in this number.
 *
 * Vertical only: every element's `clientWidth` is zero in jsdom, so the
 * visible width `shift` derives from it is zero too and the horizontal
 * coordinate is always pushed back to 0. That is jsdom failing to measure
 * rather than the bar behaving, and the horizontal axis is left to a browser.
 * @returns The bar's vertical coordinate.
 */
function barTop(): number {
  const bar = screen.getByTestId('doc-selection-bubble-bar');
  const matched = /translate\(-?[\d.]+px,\s*(-?[\d.]+)px\)/.exec(bar.style.transform);
  expect(matched).not.toBeNull();
  return Number((matched as RegExpExecArray)[1]);
}

/**
 * Wait for the bar to land on a given vertical coordinate.
 *
 * floating-ui computes asynchronously (`computePosition` returns a promise),
 * so every recomputation needs waiting on; a synchronous read may still hold
 * the previous round's value.
 * @param top - The expected coordinate.
 */
async function expectBarTop(top: number): Promise<void> {
  await waitFor(() => {
    expect(barTop()).toBe(top);
  });
}

/** The selection box the anchor tests hold fixed; its `left` is the only
 * number the horizontal axis should ever take. */
const SELECTION_BOX = new DOMRect(137, 0, 400, 20);

/**
 * Pin the selection's bounding box to a known rectangle.
 *
 * The horizontal coordinate comes from this box while the vertical one comes
 * from a document position — two separate things, both of which jsdom needs
 * pinned.
 *
 * Through `vi.spyOn`, restored in `afterEach`. Writing
 * `Range.prototype.getBoundingClientRect = ...` and leaving it, as this once
 * did, leaks into every file that runs after: `vitest.setup.ts` assigns with
 * `??=`, which is a no-op against a function already there, and
 * `vitest.config.ts` runs `forks` with `singleFork`, so one jsdom environment
 * — one `Range.prototype` — serves the whole package. Measured: files running
 * after this one saw `createRange()` return the 137 by 400 pinned here, and
 * `reference-mention-caret.ts` sizes a drag image off exactly that.
 * @param box - The box to pin.
 */
function pinSelectionBox(box: DOMRect): void {
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(box);
}

/** The body with its markup, for telling whether a command really ran. */
function markupOf(): string {
  return documentBodyFragment(doc)
    .toArray()
    .map((n) => n.toString())
    .join('');
}

describe('the selection bubble bar', () => {
  it('appears on a selection, carrying those eight commands and the link', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).map((el) => el.getAttribute('data-testid')?.replace('doc-bubble-tool-', ''));

    expect(ids.sort()).toEqual(
      // The link is in neither array: it opens a panel rather than running a
      // command, which `ToolDef` has no room for (design §4.3). The three
      // block commands (bullet list, ordered list, quote) live in the block
      // type menu since 2026-08-26, the shape the demo's note names; whether they
      // still work is pinned by `selection-bubble-shell.test.tsx`.
      [...MARK_TOOLS, ...INLINE_TOOLS]
        .map((t) => t.id)
        .concat('link')
        .sort(),
    );
  });

  // A4: the order the demo draws, read straight off the DOM. Asserted as the
  // whole sequence rather than a few neighbours — a control landing in the
  // wrong group is exactly what this has to catch, and pairwise checks let it
  // through.
  it('lays the controls out in the order the demo draws', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]')!;
    const rendered = Array.from(bar.querySelectorAll('[data-testid^="doc-bubble-"]'))
      .map((el) => el.getAttribute('data-testid') as string)
      // Each of the four dropdowns is wrapped in a `-zone` (the container that
      // decides whether the pointer is inside "slot plus menu"), and an opened
      // `-menu` is portalled into the bar — neither is a slot.
      .filter((id) => !id.endsWith('-zone') && !id.endsWith('-menu'));

    expect(rendered).toEqual([
      'doc-bubble-block-type',
      'doc-bubble-sep-align',
      'doc-bubble-align',
      'doc-bubble-sep-marks',
      'doc-bubble-tool-bold',
      'doc-bubble-tool-italic',
      'doc-bubble-tool-strike',
      'doc-bubble-tool-underline',
      'doc-bubble-sep-inline',
      'doc-bubble-tool-link',
      'doc-bubble-tool-code',
      'doc-bubble-color',
      'doc-bubble-coming-comment',
      'doc-bubble-sep-ai',
      'doc-bubble-ai',
    ]);
  });

  // A5 / A6: what jsdom can answer about the separators is that they are
  // there, that they carry the semantics of one, and how many there are. The
  // geometry the demo pins (1px by 16px, 3px either side) needs a browser and
  // is measured in `selection-bubble-bar.spec.ts`.
  it('separates the groups with a real separator element', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]')!;
    const seps = bar.querySelectorAll('[role="separator"]');

    // Five groups, four rules (the demo's note): block type | alignment | B I S U |
    // link code colour comment | AI.
    expect(seps).toHaveLength(4);
    for (const sep of seps) {
      expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    }
  });

  // A9 / A10: the two entries whose commands are not open yet. They stand in
  // the bar so the shape is whole, and say for themselves that they cannot be
  // used — the same treatment the two snapshot commands got in the
  // whole-document menu (task #129).
  it.each([
    ['comment'],
  ])('shows %s as an entry that is not open yet', async (id) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const entry = screen.getByTestId(`doc-bubble-coming-${id}`);
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    expect(entry.className).toContain('cursor-not-allowed');
    expect(entry.className).toContain('opacity-50');
  });

  // A10: clicking one leaves the document exactly as it was.
  it.each([
    ['comment'],
  ])('does nothing when %s is clicked', async (id) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const before = markupOf();

    act(() => {
      screen.getByTestId(`doc-bubble-coming-${id}`).click();
    });

    expect(markupOf()).toBe(before);
  });

  // A11: the whole bar stays out of the tab order (ruling R4), so the comment
  // entry follows the command buttons beside it. What it carries is
  // `aria-disabled` rather than HTML `disabled`: the first leaves it in the
  // accessibility tree to be read, the second drops it out of it. The four
  // dropdowns are held to the same rule by `selection-bubble-shell.test.tsx`.
  it('keeps comment out of the tab order, the way the bar does', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const entry = screen.getByTestId('doc-bubble-coming-comment');
    expect(entry.getAttribute('tabindex')).toBe('-1');
    expect(entry.hasAttribute('disabled')).toBe(false);
  });

  // A3: the buttons report what the document is, not what was last clicked.
  // Driven through the editor's own command so the path under test is the one
  // a keyboard shortcut takes — `Mod-u` and `Mod-e` reach exactly these.
  it('lights underline when the mark is on, whoever turned it on', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const button = screen.getByTestId('doc-bubble-tool-underline');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      editor.commands.toggleUnderline();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));

    act(() => {
      editor.commands.toggleUnderline();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
  });

  it('lights inline code when the mark is on, whoever turned it on', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    const button = screen.getByTestId('doc-bubble-tool-code');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    act(() => {
      editor.commands.toggleCode();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));

    act(() => {
      editor.commands.toggleCode();
    });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
  });

  // A9: the demo draws the AI entry as a menu opener, with a label and a
  // chevron, and the comment entry as an icon button. Without this test,
  // dropping `drawsAsDropdown` left both layers green (proved by mutation in
  // the second adversarial round).
  it('draws the AI entry the way the demo draws a menu opener', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const ai = screen.getByTestId('doc-bubble-ai');
    const comment = screen.getByTestId('doc-bubble-coming-comment');

    expect(ai).toHaveTextContent('AI');
    // Icon plus chevron makes two svgs; the comment entry has only its icon.
    expect(ai.querySelectorAll('svg')).toHaveLength(2);
    expect(comment.querySelectorAll('svg')).toHaveLength(1);
    expect(comment.textContent).toBe('');

    // The demo draws the comment entry as the bubble WITH text lines
    // (`message-square-text`: one bubble path, three line paths). Counting
    // paths tells it apart from the bare `message-square` — the copy
    // adversarial round caught the implementation using the latter, and every
    // assertion above holds for both.
    expect(comment.querySelectorAll('svg path')).toHaveLength(4);
  });

  // A8: an icon-only button with no visible text is a square without a name.
  // Asserted as "not the key itself" rather than "not empty": `t()` hands back
  // the key when it resolves nothing (`shared/src/i18n/index.ts:131`), so a
  // label pointing at a key no catalog has would pass the weaker check.
  it.each([
    ['tool-underline', 'spaces.document.commands.underline'],
    ['tool-code', 'spaces.document.commands.code'],
    ['coming-comment', 'spaces.document.commands.comment'],
    ['ai', 'spaces.document.commands.ai'],
  ])('gives %s a name that can be read out', async (id, key) => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const label = screen.getByTestId(`doc-bubble-${id}`).getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).not.toContain(key);
  });

  // A11: the whole reason this step exists. Each one checked, none sampled.
  // The markers are schema node names inside the Yjs fragment rather than HTML
  // tag names — `toString()` prints `<bold>` / `<bulletlist>` and the like.
  it.each([
    ['bold', '<bold>', '<p>hello world</p>', 1, 6],
    ['italic', '<italic>', '<p>hello world</p>', 1, 6],
    ['strike', '<strike>', '<p>hello world</p>', 1, 6],
    ['underline', '<underline>', '<p>hello world</p>', 1, 6],
    ['code', '<code>', '<p>hello world</p>', 1, 6],
    // The three block commands (bullet list, ordered list, quote) live in the
    // block type menu since 2026-08-26; whether pressing them there still
    // changes the document is pinned by `selection-bubble-shell.test.tsx`'s
    // "running %s from the menu still changes the document".
  ])('pressing %s on the bar really changes the document', async (id, marker, body, from, to) => {
    const editor = open(body);
    mount(editor);
    await selectWithFocus(editor, from, to);
    expect(markupOf()).not.toContain(marker);

    act(() => {
      screen.getByTestId(`doc-bubble-tool-${id}`).click();
    });

    expect(markupOf()).toContain(marker);
  });

  // A13: the command buttons carry a carrier prefix in their test id. With the
  // toolbar gone the bar is the only carrier rendering these `ToolDef`s, and
  // the prefix stays: the block handle menu (#113) will render the same
  // definitions, and an unprefixed id would then name two buttons.
  it('prefixes the command test ids with the carrier', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    expect(
      document.querySelectorAll('[data-testid="doc-bubble-tool-bold"]'),
    ).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="doc-tool-bold"]')).toHaveLength(
      0,
    );
  });

  // "the plugin is handed the body's scroller with no extra render" is gone:
  // it asserted the configuration passed to the BubbleMenu plugin, and
  // positioning now goes through `useFloating`, so that object does not exist.
  // The behaviour belongs to acceptance item G1, whose verification is written
  // in §7 of the design record.

  // A3: the anchor, line by line. One test for each of the two rules design
  // §5.1 asks for, both put to the function that really computes it.
  //
  // The scenario is built by pinning "which line is where": jsdom has no
  // layout and every rectangle is zero, while this logic asks precisely "is
  // this line in view". So a visible box is pinned (100 through 500
  // vertically) and every document position answers with a known line.
  describe('the anchor', () => {
    beforeEach(() => {
      pinSelectionBox(SELECTION_BOX);
    });

    /**
     * Make every document position answer with a known line.
     * @param editor - The editor.
     * @param lines - Position to line top; anything unlisted answers 0.
     */
    function pinLines(editor: Editor, lines: Record<number, number>): void {
      editor.view.coordsAtPos = (pos: number) => {
        const top = lines[pos] ?? 0;
        return { top, bottom: top + 20, left: 40 + pos, right: 60 + pos };
      };
    }

    it('really moves above the new line when the selection changes', async () => {
      const editor = open('<p>hello</p><p>world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(new DOMRect(0, 100, 800, 400));

      pinLines(editor, { 1: 300, 6: 300, 8: 200, 12: 200 });
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      await expectBarTop(292);

      // Select in the second paragraph. The anchor is computed live, but the
      // number it comes back with only counts once it reaches the bar —
      // floating-ui recomputes when it is woken, and a selection change is not
      // among the things it listens for (it listens for scrolls and for
      // elements changing size). Without that wake-up the bar stays above the
      // first paragraph.
      act(() => {
        editor.commands.setTextSelection({ from: 8, to: 12 });
      });

      await expectBarTop(192);
    });

    it('anchors a dragged selection to the line it was released on, its head', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(new DOMRect(0, 100, 800, 400));

      // Dragged from 1 down to 6: the head is 6 and both ends are in view.
      // Each end gets its own line, which is what tells "the released end"
      // apart from "where the selection started".
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      pinLines(editor, { 1: 300, 6: 200 });

      const rect = anchorRectOf(editor);

      // Anchored to the line at 6 (200 through 220), with 8 either side.
      expect(rect?.top).toBe(192);
      expect(rect?.bottom).toBe(228);
      // The left edge comes from the selection's box, neither from the end of
      // the line nor from the anchored line's own x.
      expect(rect?.left).toBe(SELECTION_BOX.left);
    });

    it('anchors to the line the selection started on when the head is out of view', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 2, to: 12 });
      });
      // Dragged off the bottom: the released end (12) has scrolled past the
      // visible area while the start (2) is still on screen.
      pinLines(editor, { 2: 200, 12: 900 });

      const rect = anchorRectOf(editor);

      // The starting line runs 200 through 220, with 8 either side.
      expect(rect?.top).toBe(192);
      expect(rect?.bottom).toBe(228);
    });

    it('still anchors to the starting line when neither end is in view', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 2, to: 12 });
      });
      // The selection spans the visible area entirely: its start above, its
      // released end below. No third "line the reader can see right now" is
      // hunted for — that branch was the common source of five in-scope
      // findings across the first six adversarial rounds. The anchor is handed
      // over as computed, and the scroller's own overflow clips whatever falls
      // outside the body.
      pinLines(editor, { 2: -300, 12: 900 });

      const rect = anchorRectOf(editor);

      expect(rect?.top).toBe(-308);
    });

    // Three tests are gone from here, all of which asserted the configuration
    // passed to the BubbleMenu plugin — the gap not being handed to an
    // `offset` middleware, the `-start` alignment, and flip's boundary.
    // Positioning goes through `useFloating` now and that object does not
    // exist. The gap living in the anchor rectangle is covered by the anchor
    // tests above, which each expect a line's top minus 8; the other two
    // belong to acceptance items G1 and E3, whose verification is written in
    // §7 of the design record.

    it('hands over a line above the visible area uncapped, leaving flip to decide', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 });
      });
      // The line straddles the top edge: its top at 90 has scrolled away while
      // its bottom at 110 is still showing.
      pinLines(editor, { 1: 90, 6: 90 });

      const rect = anchorRectOf(editor);

      // This used to cap the top at 100. Capping lies to flip: it sees more
      // room than there is, never flips, and the bar gets clipped. The truth
      // is handed over instead.
      expect(rect?.top).toBe(82);
      expect(rect?.bottom).toBe(118);
    });


    it('gives no anchor while the selection is empty', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(new DOMRect(0, 100, 800, 400));

      act(() => {
        editor.commands.setTextSelection(3);
      });

      expect(
        anchorRectOf(editor),
      ).toBeNull();
    });
  });

  /**
   * The select-all tier (A14).
   *
   * Three rules, set by user 2026-08-20: at the moment the selection becomes a
   * select-all, the bar goes where the pointer is if the pointer is inside the
   * body and stays away otherwise; when the pointer enters the body while the
   * selection is a select-all and no bar is up, the bar goes where the pointer
   * is; once the bar is up, nothing re-decides and nothing moves it.
   *
   * "Select-all" means `AllSelection` — three quarters selected is still a
   * range, and takes the tier above.
   */
  describe('the select-all tier', () => {
    const VIEWPORT = new DOMRect(0, 100, 800, 400);

    beforeEach(() => {
      pinSelectionBox(SELECTION_BOX);
    });

    /**
     * Move the last known pointer position somewhere.
     *
     * Dispatched on `document` rather than on the editor: the question is
     * whether the pointer is inside the body, so its position has to keep
     * arriving after it leaves — otherwise the last coordinate inside the body
     * stands forever and the answer is always yes.
     * @param x - Viewport x.
     * @param y - Viewport y.
     */
    function moveMouseTo(x: number, y: number): void {
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }),
        );
      });
    }

    /**
     * Whether the bar is on screen right now.
     *
     * Queries the document for the element: when the bar does not belong on
     * screen the component does not render it, so this IS the thing the reader
     * sees.
     * @returns Whether it is there.
     */
    function shouldShowNow(): boolean {
      return screen.queryByTestId('doc-selection-bubble-bar') !== null;
    }

    it('anchors to the pointer, not to any line, while the pointer is inside the body', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);
      // Every line gets an unmistakable coordinate: were the anchor still
      // computed from a line, the assertions would read it back.
      editor.view.coordsAtPos = () => ({
        top: 300,
        bottom: 320,
        left: 40,
        right: 60,
      });

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });

      const rect = anchorRectOf(editor, { x: 420, y: 250 });

      expect(rect).toBeDefined();
      // The pointer is a point with no height; the anchor rectangle grows by
      // one gap (8) either side.
      expect(rect?.top).toBe(242);
      expect(rect?.bottom).toBe(258);
      // The horizontal coordinate comes from the pointer too, not from the
      // selection's box: a select-all has no "left edge of the selection", and
      // the box drawn around the whole document has the body column's left
      // edge, which says nothing about where the reader is looking.
      expect(rect?.left).toBe(420);
    });

    it('stays away while the pointer is outside the body', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // The body's visible area runs from y 100 to 500; 50 is above it.
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });

      expect(shouldShowNow()).toBe(false);
    });

    it('stays away when there has never been a pointer position', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      act(() => {
        editor.commands.selectAll();
      });

      expect(shouldShowNow()).toBe(false);
    });

    it('does not follow the pointer out of the body once it is up', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(true);

      // Once up, its place on screen is settled and the pointer no longer
      // affects it.
      moveMouseTo(420, 50);

      expect(shouldShowNow()).toBe(true);
      await expectBarTop(242);
    });

    it('comes up when the pointer enters the body, with no scroll to wait for', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // The pointer was outside the body when the selection became a
      // select-all, so nothing showed.
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(false);

      // The pointer enters the body. That is the moment: no scroll and no
      // second select-all needed (user 2026-08-20 moved the trigger from
      // "every scroll" to "the pointer enters the body").
      moveMouseTo(420, 250);

      expect(shouldShowNow()).toBe(true);
      expect(barOnScreen()).toBe(true);
      const rect = anchorRectOf(editor, { x: 420, y: 250 });
      expect(rect?.top).toBe(242);
      expect(rect?.left).toBe(420);
    });

    it('does not budge as the pointer leaves and re-enters once it is up', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      await expectBarTop(242);

      // Out and back in: the bar is already up, and this entry must not move
      // it to the new place (which would read 292).
      moveMouseTo(420, 50);
      moveMouseTo(700, 300);

      await expectBarTop(242);
    });

    it('does nothing when the pointer enters and the selection is not a select-all', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // The selection is a short run and the pointer comes in from outside:
      // this tier follows the selection and never looks at the pointer.
      moveMouseTo(420, 50);
      editor.view.coordsAtPos = () => ({ top: 200, bottom: 220, left: 40, right: 60 });
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 4 });
      });
      moveMouseTo(420, 250);

      // Anchored to the line (200 less 8), not to the pointer (which would
      // read 242).
      await expectBarTop(192);
    });

    it('does not let the pointer path skip the conditions: no focus, no bar', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // Pointer outside the body, select-all: no bar, and nothing pinned.
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(false);

      // The editor loses focus — the reader is typing somewhere else.
      act(() => {
        editor.view.dom.blur();
      });

      // The pointer comes back into the body. This path has to ask "does the
      // editor hold the focus" too, through the same `isWarranted` rather than
      // a list of its own: it used to carry a shorter list, and the bar would
      // float over the body while the reader typed in another field.
      moveMouseTo(420, 250);

      expect(barOnScreen()).toBe(false);
    });

    it('shows nothing for a select-all over a document with no text in it', async () => {
      const editor = open('<p></p>');
      mount(editor);
      // An empty document has no selection to make and the bar never appears,
      // so `selectWithFocus` cannot be used here.
      act(() => {
        editor.view.dom.focus();
      });
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });

      // None of the eight commands can run, and a carrier of dead buttons is
      // just noise — the same reason §3.3.1 renders no bar at all for a
      // viewer.
      expect(shouldShowNow()).toBe(false);
    });

    it('does not re-pin on a later local transaction once it is a select-all', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      await expectBarTop(242);

      // Move the pointer elsewhere, then make a transaction. The selection is
      // still a select-all and the pin must not move. What stops it is
      // `became` inside `follow`: the selection was already a select-all on
      // the previous transaction, so this one is not "the moment", and
      // `pinToPointer` is never reached.
      //
      // `pinToPointer`'s opening `if (pinnedPoint()) return true` guards the
      // same thing, but it is the third line of defence: measured, deleting it
      // alone turns nothing in this file red. It stays as that function's own
      // invariant (never overwrite an existing pin when called), not as this
      // rule's implementation.
      moveMouseTo(700, 300);
      act(() => {
        editor.view.dispatch(editor.state.tr.insertText('x', 1, 1));
      });

      // The transaction makes the bar recompute its place, so this number
      // comes from a recomputation rather than from nobody touching it.
      await expectBarTop(242);
    });

    it('is not moved to the current pointer by a co-editor typing after it is pinned', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);
      act(() => {
        editor.commands.selectAll();
      });
      await expectBarTop(242);

      // Really over the wire: a character typed into another Y.Doc, with the
      // update applied back. The local dispatch above is no substitute —
      // y-prosemirror delivers every remote change as a replacement of the
      // whole document, and the selection along that path is not the one a
      // local transaction carries.
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const paragraph = documentBodyFragment(remote).get(0) as Y.XmlElement;
      (paragraph.get(0) as Y.XmlText).insert(0, 'x');

      moveMouseTo(700, 300);
      act(() => {
        Y.applyUpdate(
          doc,
          Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)),
        );
      });
      remote.destroy();

      await expectBarTop(242);
    });

    it('comes up on the next mouse event when the body grows around a pointer that never moved', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);

      // The body starts narrow, with the pointer resting outside its right
      // edge.
      pinViewport(new DOMRect(0, 100, 400, 400));
      moveMouseTo(600, 250);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(false);

      // The window widens, the body grows with it, and the same coordinate is
      // now inside. The pointer never moved, so a test of "inside now, outside
      // before" could never fire: both readings are the same point, and
      // against the grown area both are inside.
      pinViewport(new DOMRect(0, 100, 800, 400));
      moveMouseTo(600, 250);

      expect(shouldShowNow()).toBe(true);
      expect(
        anchorRectOf(editor, { x: 600, y: 250 })?.left,
      ).toBe(600);
    });

    it('comes up on a wheel gesture when the pointer has not moved since the page loaded', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // Not one `mousemove` has been dispatched: the position is unknown, and
      // a keyboard select-all raises no bar.
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(false);

      // A wheel gesture is a mouse event and carries clientX/clientY, which
      // `scroll` does not. It is the only way to learn where a pointer that
      // never moved is. Delete the `wheel` listener and this goes red.
      act(() => {
        document.dispatchEvent(
          new MouseEvent('wheel', { clientX: 420, clientY: 250, bubbles: true }),
        );
      });

      expect(shouldShowNow()).toBe(true);
      await expectBarTop(242);
    });

    it('pins nothing for a select-all made without focus, and raises nothing when focus returns', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // The pointer is inside the body, but the reader is elsewhere and the
      // editor holds no focus.
      moveMouseTo(420, 250);
      act(() => {
        editor.view.dom.blur();
      });
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(false);

      // Focus returns. "The moment of the select-all" has passed, and the
      // conditions did not hold then; this instant is not one of the deciding
      // moments, so no bar should appear from nowhere. Delete `follow`'s
      // `isWarranted` and this goes red — the pin is made at the select-all
      // and the bar springs up the moment focus comes back.
      act(() => {
        editor.view.dom.focus();
      });
      expect(shouldShowNow()).toBe(false);
    });

    it('does not let a co-editor transaction pin a position on the pointer behalf while focus is away', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      // Select-all with the pointer outside the body: no bar, nothing pinned.
      moveMouseTo(420, 50);
      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(false);

      // The reader switches away and the editor loses focus while the pointer
      // crosses the body. `isWarranted` stops `remember` from pinning.
      act(() => {
        editor.view.dom.blur();
      });
      moveMouseTo(420, 250);
      expect(shouldShowNow()).toBe(false);

      // A co-editor types a character. The selection is still a select-all so
      // `follow` runs — and if it did not ask about focus it would pin
      // wherever the pointer last passed through.
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
      const paragraph = documentBodyFragment(remote).get(0) as Y.XmlElement;
      (paragraph.get(0) as Y.XmlText).insert(0, 'x');
      act(() => {
        Y.applyUpdate(
          doc,
          Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)),
        );
      });
      remote.destroy();

      // The pointer has long since left and the reader is back (focus
      // returns, the selection is unchanged). The bar must not come up on that
      // stale point.
      moveMouseTo(700, 380);
      act(() => {
        editor.view.dom.focus();
      });

      expect(shouldShowNow()).toBe(false);
    });

    it('forgets the pointer once it leaves the page, so a keyboard select-all raises nothing', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);

      // The pointer leaves the page: `mouseout` bubbles to the document and
      // its `relatedTarget` is null — it entered nothing, which is to say it
      // left the browser.
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }),
        );
      });

      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(false);
    });

    it('does not count a mouseout inside the page as leaving it', async () => {
      const editor = open('<p>one</p><p>two</p><p>three</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 4);
      pinViewport(VIEWPORT);

      moveMouseTo(420, 250);

      // The pointer moves from one element to another, which the page fires
      // on every such crossing. `relatedTarget` names the element being
      // entered, so this is not a departure.
      act(() => {
        document.dispatchEvent(
          new MouseEvent('mouseout', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });

      act(() => {
        editor.commands.selectAll();
      });
      expect(shouldShowNow()).toBe(true);
    });

    it('ignores where the pointer is for a partial selection: that tier follows the selection', async () => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      pinViewport(VIEWPORT);

      // The pointer rests outside the body while the selection is a short
      // run: this tier shows as usual, anchored to a line.
      moveMouseTo(420, 50);
      editor.view.coordsAtPos = () => ({
        top: 200,
        bottom: 220,
        left: 40,
        right: 60,
      });
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 4 });
      });

      expect(shouldShowNow()).toBe(true);
      // That line's top is 200, with 8 either side. The pointer's 50 plays no
      // part.
      await expectBarTop(192);
    });
  });

  // Confirmed in the eighth adversarial round: `tabIndex = -1` stops the Tab
  // key, not the mouse. Pressing the bar's padding or a disabled button put
  // focus inside the bar and cleared the body's selection highlight.
  it('takes no focus, not even from a press on its padding', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector<HTMLElement>(
      '[data-testid="doc-selection-bubble-bar"]',
    );
    expect(bar).not.toBeNull();
    // A div with no tabindex attribute is not focusable at all, which closes
    // both the keyboard and the mouse route; `tabIndex = -1` closes only the
    // first.
    expect(bar?.hasAttribute('tabindex')).toBe(false);

    act(() => {
      bar?.focus();
    });
    expect(document.activeElement).not.toBe(bar);
  });

  /**
   * The select-all tier's remapping rule: where a pinned point lands once the
   * body area has changed.
   *
   * Put straight to the function that computes it. The whole rule lives in
   * `pinnedScreenPoint`, which knows only three things — the point, the area
   * it was pinned in, and the area now — and nothing about the editor or where
   * the bar is mounted. Going through the component would also run into jsdom
   * measuring no element sizes, which distorts the horizontal coordinate.
   */
  describe('remapping a pinned point as the body area changes', () => {
    const AREA = new DOMRect(0, 100, 800, 400);

    it('leaves the pinned point out of the arithmetic when the area reads as zero', () => {
      const pin = { x: 420, y: 250, area: AREA };

      // Not aimed at any particular scenario — the ninth adversarial round
      // disproved both the draft named (switching Space, collapsing a panel).
      // This is the ratio's own domain. A zero NEW box yields `0` (the ratio
      // times zero width) rather than NaN — measured; the bar would jump to
      // the area's top left corner.
      expect(pinnedScreenPoint(pin, new DOMRect(0, 100, 0, 0))).toEqual({
        x: 420,
        y: 250,
      });

      // Once the size is back the coordinate has to be the original one.
      // Reading never writes back, so the zero reading in between leaves no
      // mark on the pin.
      expect(pinnedScreenPoint(pin, AREA)).toEqual({ x: 420, y: 250 });
    });

    // The test above guards a zero NEW reading; the denominator is really the
    // OLD box, the one the point was placed in. That one can be zero too:
    // `isInside` accepts a rectangle collapsed to a point (`x >= left && x <=
    // right` both hold when the two are equal), so a single 0 by 0 reading can
    // still let a coordinate be recorded. Delete that half of the test and
    // this goes red.
    it('never uses a zero area as the denominator, even when pinned in one', () => {
      // The area collapses to the single point (420,250) with the pointer
      // resting exactly there, which `isInside` lets through.
      const pin = { x: 420, y: 250, area: new DOMRect(420, 250, 0, 0) };

      // The area comes back to a normal size. The denominator is the zero
      // width it was pinned in, and the numerator is zero too — only a pointer
      // exactly on that point gets through `isInside` — so without the guard
      // this computes `0 / 0` and yields NaN.
      const point = pinnedScreenPoint(pin, AREA);

      expect(point).toEqual({ x: 420, y: 250 });
      expect(Number.isFinite(point?.x)).toBe(true);
      expect(Number.isFinite(point?.y)).toBe(true);
    });

    // Two changes in a row must land the bar where one change straight to the
    // final size would: A17's "follows along" cannot drift because a few steps
    // were taken on the way.
    //
    // This CANNOT tell whether the remapping writes intermediate results back:
    // both spellings satisfy the property (a linear map composes), and putting
    // those two write-back lines in leaves it green — measured. So it guards
    // the property, not that rewrite.
    it('lands on the same point through two changes as through one', () => {
      const pin = { x: 420, y: 250, area: AREA };

      // Two steps: 800 to 600 to 400.
      pinnedScreenPoint(pin, new DOMRect(0, 100, 600, 400));
      const twoSteps = pinnedScreenPoint(pin, new DOMRect(0, 100, 400, 400));

      // Straight there: 800 to 400.
      expect(pinnedScreenPoint(pin, AREA)).toEqual({ x: 420, y: 250 });
      const direct = pinnedScreenPoint(pin, new DOMRect(0, 100, 400, 400));

      expect(twoSteps).toEqual(direct);
    });

    // "Has the area changed" compares all four numbers. Comparing only the
    // sizes would judge an area that moved without resizing as unchanged,
    // while the formula reads left/top — and the bar would stay where the body
    // used to be.
    it('moves the pinned point with an area that shifts without resizing', () => {
      const pin = { x: 420, y: 250, area: AREA };

      // Same size, moved 100 right and 50 down. The point keeps its place
      // within the area, so its screen coordinates follow by +100 / +50.
      expect(pinnedScreenPoint(pin, new DOMRect(100, 150, 800, 400))).toEqual({
        x: 520,
        y: 300,
      });
    });

    // The vertical axis gets its own pass: height only, width untouched. The
    // test above changes position, this one changes size — and only this one
    // catches writing `area.width` where `moved.y` needs `area.height`, the
    // two axes being near-identical code and so the easiest place to leave one
    // word unchanged.
    it('moves the pinned point in proportion when the area height changes', () => {
      const pin = { x: 420, y: 300, area: AREA };

      // The point sits at (300 - 100) / 400 = 0.5 down the area. Halve the
      // height and it belongs at 100 + 0.5 * 200 = 200; the width did not
      // change, so the horizontal coordinate must not move.
      expect(pinnedScreenPoint(pin, new DOMRect(0, 100, 800, 200))).toEqual({
        x: 420,
        y: 200,
      });
    });
  });

  // Confirmed in the ninth adversarial round: removing the tabindex changed
  // where focus LANDS, not whether it LEAVES the body. After a press on the
  // bar's padding, focus was in neither the editor nor the bar and the body's
  // selection highlight was gone.
  //
  // The move is Slate's official hovering-toolbar example
  // (`site/examples/ts/hovering-toolbar.tsx`, whose comment reads "prevent
  // toolbar from taking focus away from editor"): refuse mousedown's default
  // on the bar and focus does not move at all.
  //
  // Only "the default was prevented" is checked here; THAT FOCUS REALLY STAYS
  // cannot be checked at this layer, since jsdom's mousedown does not move
  // focus either way. Focus is counted in
  // `tests/smoke/selection-bubble-bar.spec.ts` — 0 blurs from pressing the
  // bar, 2 from pressing Tab.
  it('refuses the default action of a press on it', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector<HTMLElement>(
      '[data-testid="doc-selection-bubble-bar"]',
    );
    expect(bar).not.toBeNull();

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      bar?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  // Two more tests are gone from here — hiding once the anchor leaves the
  // visible area, and clamping sideways through `shift` — both of which
  // asserted the configuration passed to the BubbleMenu plugin. That object
  // does not exist now that positioning goes through `useFloating`. The
  // behaviours belong to acceptance items G2 / E5 and G1, whose verification
  // is written in §7 of the design record.

  // With no selection the eight buttons are not built at all.
  //
  // Why they must not be: each of them runs its command's dry run (`canRun`)
  // on every transaction, and the bar spends almost all of its life away —
  // leaving them mounted costs eight extra dry runs per keystroke for a
  // carrier nobody can see.
  it('builds none of the buttons while there is no selection', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).toHaveLength(6);

    act(() => {
      editor.commands.setTextSelection(3);
    });

    // Queried across the document rather than inside the bar element caught
    // earlier: when the bar does not belong on screen the component renders
    // nothing, and that earlier node has left the document with its own
    // subtree, buttons and all, intact.
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
      ).toHaveLength(0);
    });
  });

  // "recomputing on scroll is not debounced" is gone for the same reason: it
  // asserted the plugin's configuration. That behaviour belongs to acceptance
  // item G1, verified as written in §7 of the design record.

  // The half of G2 that jsdom can answer: the bar mounts INSIDE the body's
  // scroller, in the same place the link panel does.
  //
  // This assertion turned around on 2026-08-26. It used to hold that the bar
  // hung outside the scroller, with a `hide` middleware to take it away once
  // the anchor left the visible area. User measured the link panel — it opens
  // below when the target is near the top, above when it is near the bottom,
  // and travels with the text and out of sight as the body scrolls, all three
  // without trouble — so the bar follows it: mounted inside, clipped by the
  // scroller's own overflow, with that whole home-grown hiding mechanism gone.
  //
  // Where it lands and what clips it need a browser; "what is it mounted
  // under" is a DOM structure question jsdom answers fully.
  it('mounts inside the scroller, where the link panel mounts', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const bar = document.querySelector('[data-testid="doc-selection-bubble-bar"]');
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    );

    expect(bar).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(bar?.closest('.doc-body-scroller')).not.toBeNull();
    // Inside a container of the portal's own, which is a child of that
    // viewport — the link panel mounts exactly this way. The extra layer is
    // load-bearing: `index.css:970` makes every direct child div of the
    // viewport a full-height column flex container, and a bar mounted as a
    // direct child came out 74 wide and 870 tall with its controls stacked
    // (measured in a browser).
    expect(bar?.parentElement?.parentElement).toBe(viewport);
  });

  // A9: the whole bar stays out of the tab order (ruling §5.2, user
  // 2026-08-19).
  //
  // The reason is layering: a toolbar sits beside the body and stays there,
  // while this bar floats ON TOP of it, and anything on top that takes focus
  // collides with the body's own. The buttons are native `<button>`s and
  // focusable by birth, so each is set to -1 explicitly.
  //
  // The container's half is not here: it carries no tabindex attribute at all
  // rather than a -1 (which stays focusable and merely leaves the Tab order,
  // so the mouse still reaches it), pinned by `hasAttribute('tabindex')` in
  // the focusability test above. Reading `bar.tabIndex` here would tell
  // nothing apart — a div with no attribute answers -1 anyway.
  it('keeps its six buttons out of the tab order', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 6);

    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="doc-bubble-tool-"]'),
    );

    // Six: B I S U plus inline code plus the link. With the three block
    // commands moved into the block type menu, this counts what is left on the
    // bar; the four dropdown openers are pinned by
    // `selection-bubble-shell.test.tsx`'s "keeps the four new openers out of
    // the tab order".
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.tabIndex).toBe(-1);
    }
  });

  // A8: whether a button is lit has to be exactly its command's `canRun`.
  //
  // This used to read "the same button is lit the same way in both carriers",
  // which lost its subject when the toolbar went. What it uniquely covers is
  // the wiring rather than the agreement: `document-tools-availability.test.ts`
  // pins what the pure `canRun` answers across selection shapes, and cannot
  // reach whether that answer arrives at the DOM's `disabled`. So it compares
  // those two directly.
  it.each([
    ['a run of plain text, everything available', '<p>hello world</p>', 1, 6, false],
    ['inside a code block, the mark commands cannot run', '<pre><code>hello</code></pre>', 1, 6, true],
  ])('%s: the buttons agree with canRun', async (_name, body, from, to, hasDark) => {
    const editor = open(body);
    mount(editor);
    await selectWithFocus(editor, from, to);

    // First confirm the selection really builds the situation under test: with
    // all eight buttons lit, or all eight dark, the loop below still reports
    // "they agree" while saying nothing at all.
    const dark = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid^="doc-bubble-tool-"]'),
    ).filter((b) => b.disabled).length;
    expect(dark > 0).toBe(hasDark);

    // Only what is left on the bar. The three in `BLOCK_TOOLS` live in the
    // block type menu since 2026-08-26, and whether those items are lit
    // belongs to `selection-bubble-shell.test.tsx`.
    for (const tool of [...MARK_TOOLS, ...INLINE_TOOLS]) {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-testid="doc-bubble-tool-${tool.id}"]`,
      );
      expect(button).not.toBeNull();
      expect(`${tool.id}:${String(button?.disabled)}`).toBe(
        `${tool.id}:${String(!tool.canRun(editor))}`,
      );
    }
  });

  // A7: no bar at all for a viewer (ruling §3.3.1).
  it('renders no bar at all when the editor is read-only', async () => {
    const editor = open('<p>hello world</p>');
    mount(editor, true);
    // `selectWithFocus` cannot be used here — it waits for the bar to appear,
    // which is what this test has to disprove. The selection is made and given
    // time, then the absence is asserted.
    act(() => {
      editor.view.dom.focus();
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });

    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]'),
    ).toHaveLength(0);
  });
});
