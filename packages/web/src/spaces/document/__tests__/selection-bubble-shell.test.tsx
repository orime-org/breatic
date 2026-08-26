// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bubble bar's shell (task #915).
 *
 * Once #912 put the buttons on `--btn-inline` the bar's dimensions were right
 * and its slots were not: the demo
 * (`2026-08-21-editor-command-surface.html:477-519`, captioned on line 521)
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
    it('gives the block type slot the icon of the block the cursor sits in', async () => {
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

    it('falls back to the paragraph icon when the selection spans two block types', async () => {
      const editor = open('<h1>a heading</h1><p>a paragraph</p>');
      mount(editor);
      // From inside the heading through into the paragraph: two block types.
      await selectWithFocus(editor, 2, 20);

      expect(
        screen.getByTestId('doc-bubble-block-type').getAttribute('data-block-type'),
      ).toBe('paragraph');
    });
  });

  describe('items not open yet', () => {
    /**
     * User 2026-08-23's rule, quoted in `document-coming-tool.tsx:4-33`: "even
     * with no function behind it, leave the shell there", and right after it
     * "What it must not do is look usable: a control that reads as available
     * and answers a click with nothing tells the reader it is broken".
     */
    it('marks the two slots with nothing behind them as not open yet', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      for (const id of ['doc-bubble-align', 'doc-bubble-color']) {
        const slot = screen.getByTestId(id);
        expect(slot.getAttribute('aria-disabled')).toBe('true');
        expect(slot.className).toContain('opacity-50');
        expect(slot.className).toContain('cursor-not-allowed');
      }
    });

    it('keeps the treatment the AI slot already carries', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      const ai = screen.getByTestId('doc-bubble-coming-ai');
      expect(ai.getAttribute('aria-disabled')).toBe('true');
      expect(ai.className).toContain('opacity-50');
    });
  });

  describe('the tab order', () => {
    /**
     * The second half of ruling R4 (user 2026-08-19): the whole bar stays out
     * of the tab order. The four new dropdowns open from Radix's
     * `DropdownMenuTrigger`, which carries no `tabIndex={-1}` of its own
     * (`tabIndex` has zero hits in `components/ui/dropdown-menu.tsx`).
     */
    it('keeps the four new openers out of the tab order', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);

      for (const id of [
        'doc-bubble-block-type',
        'doc-bubble-align',
        'doc-bubble-color',
        'doc-bubble-coming-ai',
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

      // R4 again: the opener also answers a click. Radix's trigger opens on
      // `pointerdown` rather than on `click`.
      act(() => {
        fireEvent.pointerDown(screen.getByTestId('doc-bubble-block-type'));
      });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-bubble-block-type-menu')).not.toBeNull();
      });
    });

    it('keeps the menu up while the pointer crosses from the slot onto it', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      // The pointer leaves the slot itself and lands on the menu — the gap
      // between them counts as inside, and the menu must not go (WCAG 2.1 SC
      // 1.4.13 Hoverable).
      act(() => {
        fireEvent.pointerLeave(screen.getByTestId('doc-bubble-block-type'));
        fireEvent.pointerEnter(menu);
      });
      expect(screen.queryByTestId('doc-bubble-block-type-menu')).not.toBeNull();
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

      // Radix moves focus into the menu content when it opens
      // (`@radix-ui/react-menu:266-268`), and one of the bar's conditions is
      // that the editor holds the focus. An open menu counts as the focus
      // being where it should, so the bar stays on screen and the selection is
      // untouched.
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

      // demo:566-585 draws a shortcut column on seven of the items. This
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

    // demo:560 marks the row the selection is already in with
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
      expect(active[0].className).toContain('bg-muted');
    });

    // demo:571 rules the headings off from the lists below them.
    it('rules the headings off from the lists', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-block-type');

      const rows = Array.from(
        menu.querySelectorAll(
          '[data-testid^="doc-bubble-block-type-item-"], [role="separator"]',
        ),
      );
      const separators = rows.filter((n) => n.getAttribute('role') === 'separator');
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

      // Eight, not seven: demo:693-694 puts a default in front of the seven
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
      // demo:695: one full-width button under both rows.
      expect(menu.querySelector('[data-testid="doc-bubble-color-reset"]')).not.toBeNull();
    });

    it('lists the eight AI commands the ruling draws', async () => {
      const editor = open('<p>the quick brown fox</p>');
      mount(editor);
      await selectWithFocus(editor, 1, 10);
      const menu = await hoverOpen('doc-bubble-coming-ai');

      expect(
        menu.querySelectorAll('[data-testid^="doc-bubble-ai-item-"]'),
      ).toHaveLength(8);
    });
  });

  describe('which commands are wired', () => {
    // These three are flat buttons on the bar today and really change the
    // document. Moving them into the menu changes nothing (C1).
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

      // Asserted synchronously, without `waitFor`: user 2026-08-26 asked for
      // the bar the moment the pointer lifts, with no delay to sit through.
      // `waitFor` would swallow the requirement whole — it waits up to a
      // second, and any delay of a few hundred milliseconds fits inside that.
      const bar = screen.getByTestId('doc-selection-bubble-bar');
      expect(bar.className).not.toContain('invisible');
    });
  });
});
