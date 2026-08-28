// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bubble bar's shell (task #915).
 *
 * Once #912 put the buttons on `--btn-inline` the bar's dimensions were right
 * and its slots were not: the demo
 * (`2026-08-21-editor-command-surface.html`, the `.bubble` block and the note
 * under it)
 * draws five groups split by four rules — block type dropdown | alignment
 * dropdown | bold italic strike underline | link inline-code colour comment |
 * AI. The bar carried four groups, with the block type spread over three flat
 * buttons and no alignment or colour slot at all.
 *
 * What this file pins is the SHELL: the slots, the shape of each, what each of
 * the four dropdowns holds, and the treatment carried by the items with no
 * command behind them (user 2026-08-23's rule, implemented in
 * `document-coming-tool.tsx`, kept by user 2026-08-26). Whether a command is
 * wired is a separate question — three of them reach a function today: bullet
 * list, ordered list, quote.
 *
 * The bar's position, when it appears and how it follows a scroll belong to
 * `selection-bubble-bar.test.tsx`, which already holds them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';

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
  // Set after construction rather than through the `content` option: the
  // editor is bound to a Y.Doc, and content given at construction collides
  // with the collaboration extension's initial sync — the body never lands and
  // the selection falls on an empty document.
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
 * Render the editor, carrier and all, into the document.
 * @param editor - An editor with its body already in place.
 */
function mount(editor: Editor): void {
  render(
    <TooltipProvider>
      <DocumentEditor editor={editor} />
    </TooltipProvider>,
  );
}

/** The body with its markup, for telling whether a command really ran. */
function markupOf(): string {
  return documentBodyFragment(doc)
    .toArray()
    .map((n) => n.toString())
    .join('');
}

/**
 * Move the pointer onto one slot and wait for its menu.
 * @param slotId - That slot's test id.
 * @returns The opened menu element.
 */
async function hoverOpen(slotId: string): Promise<HTMLElement> {
  act(() => {
    fireEvent.pointerEnter(screen.getByTestId(slotId));
  });
  return waitFor(() => screen.getByTestId(`${slotId}-menu`));
}

describe('the bubble bar shell', () => {
  describe('slots', () => {
    // Every block the schema has, one at a time. `task-list` is the ninth row
    // and has no schema node to put a selection in (#13), so it cannot appear
    // here.
    it.each([
      ['paragraph', '<p>the quick brown fox</p>'],
      ['heading-1', '<h1>the quick brown fox</h1>'],
      ['heading-2', '<h2>the quick brown fox</h2>'],
      ['heading-3', '<h3>the quick brown fox</h3>'],
      ['bullet-list', '<ul><li><p>the quick brown fox</p></li></ul>'],
      ['ordered-list', '<ol><li><p>the quick brown fox</p></li></ol>'],
      ['quote', '<blockquote><p>the quick brown fox</p></blockquote>'],
      ['code-block', '<pre><code>the quick brown fox</code></pre>'],
    ])('reads %s off the block the selection sits in', async (blockType, body) => {
      const editor = open(body);
      mount(editor);
      await selectWithFocus(editor, 3, 8);

      const slot = screen.getByTestId('doc-bubble-block-type');
      expect(slot.getAttribute('data-block-type')).toBe(blockType);

      // The icon, not just the attribute the icon is chosen from: both are
      // read off the same answer, so the attribute alone says nothing about
      // what is drawn. The row for this block type is drawn from the same
      // list, and every other row has a different shape.
      const menu = await hoverOpen('doc-bubble-block-type');
      const drawn = slot.querySelector('svg')?.innerHTML;
      const own = menu
        .querySelector(`[data-testid="doc-bubble-block-type-item-${blockType}"] svg`)
        ?.innerHTML;
      expect(drawn).toBe(own);

      const others = Array.from(
        menu.querySelectorAll('[data-testid^="doc-bubble-block-type-item-"]'),
      )
        .filter((n) => n.getAttribute('data-testid') !== `doc-bubble-block-type-item-${blockType}`)
        .map((n) => n.querySelector('svg')?.innerHTML);
      expect(others).not.toContain(drawn);
    });

    it('switches as the selection moves from one block to another', async () => {
      const editor = open('<h1>a heading</h1><p>a paragraph</p>');
      mount(editor);

      await selectWithFocus(editor, 2, 6);
      expect(
        screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
      ).toBe('heading-1');

      await act(async () => {
        editor.commands.setTextSelection({ from: 14, to: 20 });
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
        ).toBe('paragraph');
      });
    });

    // A7's second half, from the note under the demo's `对齐下拉` column: "对齐只作用在段落
    // 和 H1 / H2 / H3 上。选区落在引用、列表、代码块里时，这个下拉整个变灰。"
    // The first half — the greyed task list row — is `greys the task list row,
    // and only that one` further down.
    it.each([
      ['<p>the quick brown fox</p>', false],
      ['<h1>the quick brown fox</h1>', false],
      ['<h2>the quick brown fox</h2>', false],
      ['<h3>the quick brown fox</h3>', false],
      ['<blockquote><p>the quick brown fox</p></blockquote>', true],
      ['<ul><li><p>the quick brown fox</p></li></ul>', true],
      ['<ol><li><p>the quick brown fox</p></li></ol>', true],
      ['<pre><code>the quick brown fox</code></pre>', true],
    ])('greys the alignment slot in %s: %s', async (body, greyed) => {
      const editor = open(body);
      mount(editor);
      await selectWithFocus(editor, 3, 8);

      const slot = screen.getByTestId('doc-bubble-align');
      const classes = slot.className.split(/\s+/);
      expect(slot.getAttribute('aria-disabled')).toBe(greyed ? 'true' : null);
      expect(classes.includes('opacity-50')).toBe(greyed);
      expect(classes.includes('cursor-not-allowed')).toBe(greyed);
    });

    // A7 greys the slot where the command would reach nothing. One alignable
    // block inside the selection is enough for it to reach something, whatever
    // the anchor end happens to be sitting in.
    it('leaves the alignment slot lit when only part of the selection can align', async () => {
      const editor = open('<h1>a heading</h1><pre><code>some code</code></pre>');
      mount(editor);
      // Anchored in the code block, reaching back into the heading.
      await selectWithFocus(editor, 20, 2);

      expect(
        screen.getByTestId('doc-bubble-align').getAttribute('aria-disabled'),
      ).toBeNull();
    });

    // A selection over two block types shows the type of the end the reader
    // started from, so the face answers "what am I in" rather than going blank
    // (user 2026-08-27).
    it('shows the anchor end block type when the selection spans two', async () => {
      const editor = open('<h1>a heading</h1><p>a paragraph</p>');
      mount(editor);
      // From inside the heading through into the paragraph: two block types.
      await selectWithFocus(editor, 2, 20);

      expect(
        screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
      ).toBe('heading-1');
    });

    it('shows the anchor end block type when the selection runs backwards', async () => {
      const editor = open('<p>a paragraph</p><h1>a heading</h1>');
      mount(editor);
      // Dragged from the heading back up into the paragraph: the anchor is
      // the heading end.
      await selectWithFocus(editor, 20, 2);

      expect(
        screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
      ).toBe('heading-1');
    });

    // A list item holds a paragraph, and the list is what the reader is in.
    // The face has to say so wherever the other end of the selection reaches:
    // pressing the bullet list row here turns that list OFF, and a face
    // reading "text" would have just said the reader was not in one.
    it.each([
      ['bullet-list', '<h1>a heading</h1><ul><li><p>an item</p></li></ul>', 16],
      ['ordered-list', '<h1>a heading</h1><ol><li><p>an item</p></li></ol>', 16],
      ['quote', '<h1>a heading</h1><blockquote><p>a line</p></blockquote>', 15],
    ])('shows %s at the anchor end when the selection leaves it', async (
      blockType,
      body,
      anchor,
    ) => {
      const editor = open(body);
      mount(editor);
      // Anchored inside the wrapper, reaching back into the heading.
      await selectWithFocus(editor, anchor, 3);

      expect(
        screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
      ).toBe(blockType);
    });

    // A7 greys the slot over a list or a quote. Two of them side by side is
    // still every block wrapped, so the answer cannot turn on whether one
    // wrapper happens to cover the whole selection.
    it('greys the alignment slot when the selection spans two wrappers', async () => {
      const editor = open(
        '<ul><li><p>an item</p></li></ul><blockquote><p>a line</p></blockquote>',
      );
      mount(editor);
      await selectWithFocus(editor, 5, 17);

      expect(
        screen.getByTestId('doc-bubble-align').getAttribute('aria-disabled'),
      ).toBe('true');
    });
  });

  // None of these menus take the keyboard (user 2026-08-26), so none of them
  // takes the focus either: typing while one is open goes on reaching the body.
  describe('focus', () => {
    it('leaves focus in the body while a menu is open', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      expect(document.activeElement).toBe(editor.view.dom);
    });

    // Moving along the bar opens each slot in turn. The one being left behind
    // must not take the focus away from the one arriving.
    it('leaves the second menu open when the pointer moves between slots', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-align');
      const second = await hoverOpen('doc-bubble-block-type');

      // Long enough for a menu closing behind it to have run its own teardown.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(second.isConnected).toBe(true);
      expect(document.activeElement).toBe(editor.view.dom);
    });
  });

  // A slot that has just greyed out cannot be left with a live menu hanging
  // under it: the selection moved, and what the menu acts on moved with it.
  it('takes the alignment menu away when the slot greys out under it', async () => {
    const editor = open('<pre><code>some code</code></pre><p>a paragraph</p>');
    mount(editor);
    await selectWithFocus(editor, 3, 18);
    expect(
      screen.getByTestId('doc-bubble-align').getAttribute('aria-disabled'),
    ).toBeNull();
    await hoverOpen('doc-bubble-align');

    await act(async () => {
      editor.commands.setTextSelection({ from: 3, to: 8 });
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('doc-bubble-align').getAttribute('aria-disabled'),
      ).toBe('true');
    });
    expect(screen.queryByTestId('doc-bubble-align-menu')).toBeNull();
  });

  // And the bar's record of which menu is open goes with it: `overlayOpenRef`
  // reads that record to decide whether the editor losing the focus should
  // take the bar away, so a record left standing over no menu keeps the bar on
  // screen after the reader has gone.
  it('leaves no menu recorded as open once the alignment slot greys out', async () => {
    const editor = open('<pre><code>some code</code></pre><p>a paragraph</p>');
    mount(editor);
    await selectWithFocus(editor, 3, 18);
    await hoverOpen('doc-bubble-align');

    await act(async () => {
      editor.commands.setTextSelection({ from: 3, to: 8 });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-bubble-align-menu')).toBeNull();
    });

    act(() => {
      editor.view.dom.blur();
      editor.emit('blur', {
        editor,
        event: new FocusEvent('blur'),
        transaction: editor.state.tr,
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-selection-bubble-bar')).toBeNull();
    });
  });

  // An open menu is why the bar stays through a blur — the reader is working
  // in it, not gone. Once it closes that reason is spent, and nothing else
  // arrives to say so: a blur carries no transaction, and the reader who left
  // sends no further events.
  it('takes the bar away once the last menu closes after a blur', async () => {
    const editor = open('<p>the quick brown fox</p>');
    mount(editor);
    await selectWithFocus(editor, 1, 10);
    await hoverOpen('doc-bubble-block-type');

    act(() => {
      editor.view.dom.blur();
      editor.emit('blur', {
        editor,
        event: new FocusEvent('blur'),
        transaction: editor.state.tr,
      });
    });
    expect(screen.queryByTestId('doc-selection-bubble-bar')).not.toBeNull();

    act(() => {
      fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type-zone'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-selection-bubble-bar')).toBeNull();
    });
  });

  describe('controls whose command nobody has written yet', () => {
    /**
     * They look and behave the way the demo draws them — the alignment rows,
     * the colour cells, the AI commands all read as available — and a press
     * reaches the console rather than the reader (user 2026-08-26). The
     * product is not launched; whoever has the browser open is the one who
     * needs to know which command they reached.
     */
    it.each([
      ['doc-bubble-align'],
      ['doc-bubble-color'],
      ['doc-bubble-ai'],
    ])('draws %s as an ordinary control', async (id) => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      const slot = screen.getByTestId(id);
      expect(slot.getAttribute('aria-disabled')).toBeNull();
      // The classes are read one by one: `Button`'s own base carries
      // `disabled:opacity-50`, which a substring test would match.
      const classes = slot.className.split(/\s+/);
      expect(classes).not.toContain('opacity-50');
      expect(classes).not.toContain('cursor-not-allowed');
    });

    it.each([
      ['doc-bubble-align', 'doc-bubble-align-item-center'],
      ['doc-bubble-color', 'doc-bubble-color-text-red'],
      ['doc-bubble-color', 'doc-bubble-color-reset'],
      ['doc-bubble-ai', 'doc-bubble-ai-item-translate'],
      ['doc-bubble-block-type', 'doc-bubble-block-type-item-heading-1'],
    ])('says on the console that %s / %s reached no command', async (slot, item) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      const before = markupOf();

      const menu = await hoverOpen(slot);
      act(() => {
        (menu.querySelector(`[data-testid="${item}"]`) as HTMLElement).click();
      });

      // Counted among our own lines. `console.warn` carries other traffic:
      // ProseMirror writes "TextSelection endpoint not pointing into a node
      // with inline content" from the setup above whenever the Y.Doc's content
      // has not landed by the time the selection is set, and a count of every
      // call made that warning decide whether this case passed.
      const ours = warn.mock.calls.filter((call) =>
        String(call[0]).startsWith('not implemented yet'));
      expect(ours).toHaveLength(1);
      // The document is what it was: the console is the only thing that
      // happened.
      expect(markupOf()).toBe(before);
      // C2 ends "菜单照常关闭", and it says so for every row alike — the ones
      // that reach a command and the ones that reach the console.
      await waitFor(() => {
        expect(screen.queryByTestId(`${slot}-menu`)).toBeNull();
      });
    });

    // The task list is the one row the demo greys, because it has
    // no schema node to turn a paragraph into. The rest of the block type menu
    // reads as available.
    it('greys the task list row, and only that one', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      const greyed = Array.from(
        menu.querySelectorAll('[data-testid^="doc-bubble-block-type-item-"]'),
      ).filter((n) => n.getAttribute('aria-disabled') === 'true');

      expect(greyed.map((n) => n.getAttribute('data-testid'))).toEqual([
        'doc-bubble-block-type-item-task-list',
      ]);
    });
  });

  describe('the tab order', () => {
    /**
     * The second half of ruling R4 (user 2026-08-19): the whole bar stays out
     * of the tab order. The four new dropdowns open from Radix's
     * `PopoverTrigger`, which carries no `tabIndex={-1}` of its own
     * (`tabIndex` has zero hits in `components/ui/popover.tsx`).
     */
    it('keeps the four new openers out of the tab order', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      for (const id of [
        'doc-bubble-block-type',
        'doc-bubble-align',
        'doc-bubble-color',
        'doc-bubble-ai',
      ]) {
        expect(screen.getByTestId(id).getAttribute('tabindex')).toBe('-1');
      }
    });
  });
  describe('the menus', () => {
    it('opens on hover, and again on click', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      await hoverOpen('doc-bubble-block-type');

      // The pointer leaves the whole zone: the menu goes, the slot stays (B4).
      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type-zone'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
      });
      expect(screen.queryByTestId('doc-bubble-block-type')).not.toBeNull();
      // Closing hands the focus back to the body, so the bar has no reason to
      // judge focus-has-left and take itself away.
      expect(editor.view.hasFocus()).toBe(true);

      // R4 again: the opener also answers a click.
      act(() => {
        fireEvent.click(screen.getByTestId('doc-bubble-block-type'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).not.toBeNull();
      });
    });

    // A real pointer cannot produce "resting on the slot while the menu is
    // shut": hovering opened it. So the click a reader makes always lands on
    // an open menu, and it has to leave the menu standing.
    it('keeps the menu up when the slot is clicked while already open', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      act(() => {
        // Both events a real press produces. Radix has two routes that would
        // shut the menu — the trigger's own toggle, and the dismissable
        // layer's document-level `pointerdown` — and only one of them reads
        // the click.
        fireEvent.pointerDown(screen.getByTestId('doc-bubble-block-type'));
        fireEvent.click(screen.getByTestId('doc-bubble-block-type'));
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      expect(screen.queryByTestId('doc-bubble-block-type-menu')).not.toBeNull();
    });

    it('keeps the menu up while the pointer crosses the gap onto it', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      // Leaving the ZONE is what starts the close: the pointer is in the gap
      // between slot and menu, inside neither. This used to fire on the slot
      // itself, where nothing listens — the menu was never going to close, and
      // the assertion held whatever the code did (proved by mutation: the
      // whole `cancelClose()` could go and 25 tests stayed green).
      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type-zone'));
      });
      // The pointer lands on the menu before the countdown runs out.
      act(() => {
        fireEvent.pointerEnter(menu);
      });

      // Past the grace period the menu is still there (WCAG 2.1 SC 1.4.13
      // Hoverable).
      await new Promise((resolve) => {
        setTimeout(resolve, 240);
      });
      expect(screen.queryByTestId('doc-bubble-block-type-menu')).not.toBeNull();
    });

    it('takes the menu away when the pointer stops in the gap', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      // The other half of the same countdown: nothing cancels it, so it runs
      // out. Without this, a grace period that never expired would pass the
      // test above.
      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type-zone'));
      });

      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
      });
    });

    it('hands the open menu over when the pointer moves to another slot', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      act(() => {
        fireEvent.pointerEnter(screen.getByTestId('doc-bubble-align'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-align-menu')).not.toBeNull();
      });
      expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
    });

    it('leaves the bar on screen while a menu is up', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      await hoverOpen('doc-bubble-block-type');

      const bar = screen.getByTestId('doc-selection-bubble-bar');
      expect(bar.className).not.toContain('invisible');
    });

    it('keeps the bar and the selection through open and close', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const before = editor.state.selection;
      await hoverOpen('doc-bubble-block-type');

      // One of the bar's conditions is that the editor holds the focus, and
      // the menu refuses it in both directions so that stays true. An open
      // overlay also counts as the focus being where it should, which is what
      // the link panel needs — so the bar stays on screen either way, and the
      // selection is untouched.
      expect(screen.getByTestId('doc-selection-bubble-bar').className).not.toContain('invisible');
      expect(editor.state.selection.eq(before)).toBe(true);

      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type-zone'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
      });
      expect(screen.getByTestId('doc-selection-bubble-bar').className).not.toContain('invisible');
      expect(editor.state.selection.eq(before)).toBe(true);
    });

    it('swallows the wheel over the menu, and closes once the body really scrolls', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      // With the pointer resting on the menu the body does not scroll (B5).
      // The assertion is on `preventDefault` being called: jsdom implements no
      // scrolling, so `scrollTop` would not move either way.
      const wheel = new WheelEvent('wheel', {
        deltaY: 40,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        menu.dispatchEvent(wheel);
      });
      expect(wheel.defaultPrevented).toBe(true);

      // Once the body really scrolls, the menu must go (B6).
      const scroller = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      ) as HTMLElement;
      act(() => {
        fireEvent.scroll(scroller);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).toBeNull();
      });
    });
  });

  describe('what the menus hold', () => {
    it('lists the nine block types the demo draws, with their shortcuts', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      const items = Array.from(menu.querySelectorAll('[data-testid^="doc-bubble-block-type-item-"]'));
      expect(items.map((n) => n.getAttribute('data-testid'))).toEqual([
        'doc-bubble-block-type-item-paragraph',
        'doc-bubble-block-type-item-heading-1',
        'doc-bubble-block-type-item-heading-2',
        'doc-bubble-block-type-item-heading-3',
        'doc-bubble-block-type-item-bullet-list',
        'doc-bubble-block-type-item-ordered-list',
        'doc-bubble-block-type-item-quote',
        'doc-bubble-block-type-item-code-block',
        'doc-bubble-block-type-item-task-list',
      ]);

      // The demo draws a shortcut column on seven of the items. This
      // environment reports a non-Mac platform, so they read in the Windows
      // spelling; the Mac one is asserted below.
      const shortcuts = items.map(
        (n) => n.querySelector('[data-testid^="doc-bubble-block-type-shortcut-"]')?.textContent?.trim() ?? null,
      );
      expect(shortcuts).toEqual([
        null,
        'Ctrl+Alt+1',
        'Ctrl+Alt+2',
        'Ctrl+Alt+3',
        'Ctrl+Shift+8',
        'Ctrl+Shift+7',
        'Ctrl+Shift+B',
        'Ctrl+Alt+C',
        null,
      ]);
    });

    // `packages/web/CLAUDE.md` makes carrying both platforms mandatory, and a
    // hardcoded glyph reads as a chord Windows readers cannot press.
    it('spells the shortcuts the Mac way on a Mac', async () => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      expect(
        menu.querySelector('[data-testid="doc-bubble-block-type-shortcut-heading-1"]')?.textContent?.trim(),
      ).toBe('⌘⌥1');
      expect(
        menu.querySelector('[data-testid="doc-bubble-block-type-shortcut-bullet-list"]')?.textContent?.trim(),
      ).toBe('⌘⇧8');
    });

    // The demo marks the row the selection is already in with
    // `data-active="true"`, which takes `--color-muted`.
    it('marks the row the selection is already in', async () => {
      const editor = open('<h1>a heading</h1><p>a paragraph</p>');
      mount(editor);
      await selectWithFocus(editor, 2, 6);
      const menu = await hoverOpen('doc-bubble-block-type');

      const active = Array.from(
        menu.querySelectorAll('[data-testid^="doc-bubble-block-type-item-"]'),
      ).filter((n) => n.getAttribute('data-active') === 'true');

      expect(active.map((n) => n.getAttribute('data-testid'))).toEqual([
        'doc-bubble-block-type-item-heading-1',
      ]);
      // The same fill the language menu marks its picked row with.
      expect(active[0].className).toContain('bg-accent');
    });

    // The demo's `.menu-sep` rules the headings off from the lists below them.
    it('rules the headings off from the lists', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      const rows = Array.from(
        menu.querySelectorAll(
          '[data-testid^="doc-bubble-block-type-item-"], [data-testid="doc-bubble-rule"]',
        ),
      );
      const separators = rows.filter(
        (n) => n.getAttribute('data-testid') === 'doc-bubble-rule',
      );
      expect(separators).toHaveLength(1);
      // Between heading 3 and the bulleted list, nowhere else.
      expect(rows.indexOf(separators[0])).toBe(4);
    });

    // Every row of the demo's alignment menu carries a 16px icon, the way the
    // block type menu's rows do.
    it('gives each alignment row an icon', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-align');

      const rows = Array.from(
        menu.querySelectorAll('[data-testid^="doc-bubble-align-item-"]'),
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.querySelectorAll('svg')).toHaveLength(1);
      }
      // Three different icons, not the same one three times.
      const shapes = rows.map((r) => r.querySelector('svg')?.innerHTML);
      expect(new Set(shapes).size).toBe(3);
    });

    it('greys the task list item out, the way the demo draws it', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      const taskList = menu.querySelector(
        '[data-testid="doc-bubble-block-type-item-task-list"]',
      ) as HTMLElement;
      expect(taskList.getAttribute('aria-disabled')).toBe('true');
    });

    it('lists the three alignments the demo draws', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-align');

      expect(
        Array.from(menu.querySelectorAll('[data-testid^="doc-bubble-align-item-"]')).map((n) =>
          n.getAttribute('data-testid'),
        ),
      ).toEqual([
        'doc-bubble-align-item-left',
        'doc-bubble-align-item-center',
        'doc-bubble-align-item-right',
      ]);
    });

    it('lays the colour panel out in two rows of eight with a reset, the way the demo draws it', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-color');

      // Eight, not seven: the demo puts a default in front of the seven
      // hues on the text row and a "none" in front of them on the background
      // row, each marked as the one in force.
      expect(menu.querySelectorAll('[data-testid^="doc-bubble-color-text-"]')).toHaveLength(8);
      expect(menu.querySelectorAll('[data-testid^="doc-bubble-color-fill-"]')).toHaveLength(8);
      expect(
        menu.querySelector('[data-testid="doc-bubble-color-text-default"]')?.getAttribute('data-selected'),
      ).toBe('true');
      expect(
        menu.querySelector('[data-testid="doc-bubble-color-fill-none"]')?.getAttribute('data-selected'),
      ).toBe('true');
      // The demo's `.color-reset`: one full-width button under both rows.
      expect(menu.querySelector('[data-testid="doc-bubble-color-reset"]')).not.toBeNull();

      // demo 3.5 gives each row a heading of its own, and A6 names that as part
      // of the structure. Counting swatches alone leaves it untested: strip
      // both headings out and two unlabelled strips still pass.
      const headings = [...menu.children]
        .filter(
          (n) =>
            !n.matches('[data-testid^="doc-bubble-color-"]')
            && !n.querySelector('[data-testid^="doc-bubble-color-"]'),
        )
        .map((n) => n.textContent?.trim() ?? '')
        .filter((text) => text.length > 0);
      expect(headings).toHaveLength(2);
      for (const text of headings) {
        expect(text).not.toContain('spaces.document.commands');
      }
    });

    it('lists the eight AI commands the ruling draws', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-ai');

      expect(
        menu.querySelectorAll('[data-testid^="doc-bubble-ai-item-"]'),
      ).toHaveLength(8);

      // A6 asks for "三组八项", and the three come from the ruling's own table
      // (§3.2.1). Counting the rows alone leaves the grouping untested: strip
      // every label out and eight ungrouped rows still pass.
      //
      // Read as the order the reader meets them in, with the count each one
      // introduces — five rewrites, two that produce something new, one other.
      const groups: { label: string; rows: number }[] = [];
      for (const node of menu.children) {
        const row = node.getAttribute('data-testid');
        if (row?.startsWith('doc-bubble-ai-item-')) {
          if (groups.length > 0) groups[groups.length - 1]!.rows += 1;
          continue;
        }
        if (node.textContent) {
          groups.push({ label: node.textContent.trim(), rows: 0 });
        }
      }
      expect(groups.map((g) => g.rows)).toEqual([5, 2, 1]);
      // Each heading resolved to a catalog entry: `t()` hands the key back
      // when it finds nothing (`shared/src/i18n/index.ts:131`).
      for (const g of groups) {
        expect(g.label).not.toContain('spaces.document.commands');
        expect(g.label.length).toBeGreaterThan(0);
      }
    });
  });

  describe('which commands are wired', () => {
    // These three moved off the bar into this menu, and they really change
    // the document from there (C1).
    it.each([
      ['bullet-list', '<bulletlist>'],
      ['ordered-list', '<orderedlist'],
      ['quote', '<blockquote>'],
    ])('running %s from the menu still changes the document', async (id, marker) => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      expect(markupOf()).not.toContain(marker);

      const menu = await hoverOpen('doc-bubble-block-type');
      act(() => {
        (menu.querySelector(`[data-testid="doc-bubble-block-type-item-${id}"]`) as HTMLElement).click();
      });

      expect(markupOf()).toContain(marker);
    });

    // Every other item leaves the document untouched (C2).
    it.each([
      ['doc-bubble-block-type', 'paragraph'],
      ['doc-bubble-block-type', 'heading-1'],
      ['doc-bubble-block-type', 'code-block'],
      ['doc-bubble-block-type', 'task-list'],
    ])('clicking %s / %s leaves the document alone', async (slot, item) => {
      const editor = open('<p>hello world</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 6);
      const before = markupOf();

      const menu = await hoverOpen(slot);
      act(() => {
        (menu.querySelector(`[data-testid="${slot}-item-${item}"]`) as HTMLElement).click();
      });

      expect(markupOf()).toBe(before);
    });
  });

  describe('what a row can do', () => {
    // The three block commands moved off the bar and into this menu, and the
    // judgement of whether each can run where the selection is has to travel
    // with them: inside a code block a list command reaches nothing, and a row
    // that reads as available and does nothing tells the reader it is broken.
    it('dims the block commands where they cannot run', async () => {
      const editor = open('<pre><code>hello world</code></pre>');
      mount(editor);
      await selectWithFocus(editor, 2, 7);
      const menu = await hoverOpen('doc-bubble-block-type');

      // The two list commands reach nothing inside a code block. Quote does
      // reach something — it wraps the code block — which
      // `document-tools-availability.test.ts` measured for each of six
      // placements.
      const dimmed = (id: string): string | null | undefined =>
        menu
          .querySelector(`[data-testid="doc-bubble-block-type-item-${id}"]`)
          ?.getAttribute('aria-disabled');
      expect(dimmed('bullet-list')).toBe('true');
      expect(dimmed('ordered-list')).toBe('true');
      expect(dimmed('quote')).toBeNull();
    });

    it('leaves them available in a plain paragraph', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      for (const id of ['bullet-list', 'ordered-list', 'quote']) {
        const row = menu.querySelector(`[data-testid="doc-bubble-block-type-item-${id}"]`);
        expect(`${id}=${row?.getAttribute('aria-disabled')}`).toBe(`${id}=null`);
      }
    });
  });

  describe('when it appears', () => {
    /**
     * tiptap's `updateDelay` defaults to 250ms and asks "has the selection
     * held still that long", which a pause mid-drag satisfies — which is why
     * the bar used to jump. The industry answer is a pointer gate: BlockNote's
     * `FormattingToolbar.ts:52-103` (away on `pointerdown`, back on
     * `pointerup`, `setTimeout` with zero hits) and Plate's
     * `useFloatingToolbar.ts:111-136`.
     */
    it('stays away while the pointer is down, and comes back when it lifts', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      // The bar steps aside the same way it does while the link panel is up:
      // the element stays in the DOM, carrying `invisible` and
      // `pointer-events-none`. The gate is on visibility rather than on the
      // bar's own show/hide question, which a transaction that alters nothing
      // would not re-ask.
      act(() => {
        fireEvent.pointerDown(editor.view.dom);
      });
      await waitFor(() => {
        expect(screen.getByTestId('doc-selection-bubble-bar').className).toContain('invisible');
      });

      // Held down while the selection keeps changing: the bar must not appear
      // once.
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 14 });
        editor.commands.setTextSelection({ from: 1, to: 18 });
      });
      expect(screen.getByTestId('doc-selection-bubble-bar').className).toContain('invisible');

      act(() => {
        fireEvent.pointerUp(editor.view.root as unknown as Element);
      });
      await waitFor(() => {
        expect(screen.getByTestId('doc-selection-bubble-bar').className).not.toContain('invisible');
      });
    });

    it('shows for a keyboard selection without waiting for any pointer', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      // The selection changes with no pointer event at all — the shift-arrow
      // route.
      await selectWithFocus(editor, 1, 10);
      expect(screen.queryByTestId('doc-selection-bubble-bar')).not.toBeNull();
    });

    it('shows the bar the moment the pointer lifts, with nothing to wait out', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      // A real drag-select starts from NO selection: the press collapses it to
      // a caret and the bar is not in the document. The tests above all start
      // from a selection that is already there, so the bar never goes away and
      // "when does it come back" cannot be measured in them.
      act(() => {
        editor.view.dom.focus();
        editor.commands.setTextSelection({ from: 1, to: 1 });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-selection-bubble-bar')).toBeNull();
      });

      act(() => {
        fireEvent.pointerDown(editor.view.dom);
      });
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 10 });
      });
      act(() => {
        fireEvent.pointerUp(editor.view.root as unknown as Element);
      });

      // Microtasks flushed and nothing else: user 2026-08-26 asked for the bar
      // the moment the pointer lifts, with no delay to sit through. floating-ui
      // resolves its first computation in a microtask — before the frame is
      // painted — and the bar stays invisible until it lands so its entry is
      // never drawn at the offsets the previous computation left. A timer of
      // any length outlives this, so the requirement still bites; `waitFor`
      // would swallow it whole, waiting up to a second.
      await act(async () => {});
      const bar = screen.getByTestId('doc-selection-bubble-bar');
      expect(bar.className).not.toContain('invisible');
    });
  });
});
