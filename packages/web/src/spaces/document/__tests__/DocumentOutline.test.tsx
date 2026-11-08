// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1149: the heading outline beside the document body, driven through the
 * real editor chrome. jsdom lays nothing out, so the Space width reaches the
 * outline through a ResizeObserver the test fires, and the few rectangles a
 * jump reads are given to the elements it reads them from.
 */

import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import * as Y from 'yjs';

import { Awareness } from 'y-protocols/awareness';

import { documentBodyFragment } from '@breatic/shared';


import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  _resetDocumentEditorCacheForTests,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { readUserPreferences } from '@web/lib/user-preferences-storage';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import { useDocumentViewStore } from '@web/stores/document-view';

const USER = 'user-1';

/** Collaborator editors a test mounted, unmounted after it. */
const collaborators: ReturnType<typeof buildDocumentEditor>[] = [];

/** Every ResizeObserver the chrome made, with what it watches. */
const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

/** A ResizeObserver the test fires by hand. */
class ManualResizeObserver {
  private readonly record: { callback: ResizeObserverCallback; targets: Element[] };

  /**
   * Records the callback.
   * @param callback - What the chrome runs on a change of size.
   */
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, targets: [] };
    observers.push(this.record);
  }

  /**
   * Starts watching an element.
   * @param target - The element.
   */
  observe(target: Element): void {
    this.record.targets.push(target);
  }

  /**
   * Stops watching an element.
   * @param target - The element.
   */
  unobserve(target: Element): void {
    this.record.targets = this.record.targets.filter((t) => t !== target);
  }

  /** Stops watching everything. */
  disconnect(): void {
    this.record.targets = [];
  }
}

/**
 * Tells every observer that everything it watches is now this wide.
 * @param width - The width in px.
 */
function resizeTo(width: number): void {
  act(() => {
    for (const { callback, targets } of [...observers]) {
      if (targets.length === 0) continue;
      const entries = targets.map((target) => ({
        target,
        contentRect: { width, height: 800, top: 0, left: 0, right: width, bottom: 800, x: 0, y: 0 },
        borderBoxSize: [{ inlineSize: width, blockSize: 800 }],
        contentBoxSize: [{ inlineSize: width, blockSize: 800 }],
      })) as unknown as ResizeObserverEntry[];
      callback(entries, {} as ResizeObserver);
    }
  });
}

/**
 * A handle on a fresh document, read by an editor.
 * @param name - The document's name.
 * @returns The handle and its Yjs document.
 */
async function openHandle(name: string): Promise<{ handle: DocumentEditorHandle; doc: Y.Doc; awareness: Awareness }> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const { result } = renderHook(() =>
    useDocumentEditor({ doc, name, caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: USER }) }),
  );
  await waitFor(() => expect(result.current).not.toBeNull());
  return { handle: result.current!, doc, awareness };
}

/**
 * Replaces a mounted editor's document.
 * @param handle - The editor's handle.
 * @param blocks - The document, in block JSON.
 */
function fill(handle: DocumentEditorHandle, blocks: readonly unknown[]): void {
  act(() => handle.editor.replaceBlocks(handle.editor.document, blocks as never));
}

/**
 * A heading block.
 * @param id - The block id.
 * @param level - 1, 2 or 3.
 * @param text - Its words.
 * @returns The block JSON.
 */
function h(id: string, level: number, text: string): Record<string, unknown> {
  return { id, type: 'heading', props: { level }, content: text };
}

/**
 * The outline rows on screen, as their words.
 * @returns The rows' words, top to bottom.
 */
function rowTexts(): string[] {
  return screen.queryAllByTestId('doc-outline-row').map((row) => row.textContent ?? '');
}

/**
 * The outline row for one heading.
 * @param text - The heading's words.
 * @returns The row's jump button.
 * @throws {Error} When no row shows these words.
 */
function row(text: string): HTMLElement {
  const found = screen.getAllByTestId('doc-outline-row').find((r) => r.textContent === text);
  if (found === undefined) throw new Error(`no outline row for ${text}`);
  return found;
}

/**
 * The id the editor gave the top-level block holding these words; the
 * editor gives every block its own id, so a fixture's ids never land.
 * @param handle - The editor's handle.
 * @param text - The block's words.
 * @returns The block id.
 * @throws {Error} When no top-level block holds the words.
 */
function idOf(handle: DocumentEditorHandle, text: string): string {
  const words = (content: unknown): string =>
    Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('') : '';
  const blocks = handle.editor.document as readonly { id: string; content?: unknown }[];
  const block = blocks.find((b) => words(b.content) === text);
  if (block === undefined) throw new Error(`no block holds ${text}`);
  return block.id;
}

/**
 * The body's scrolling viewport.
 * @returns The viewport element.
 */
function bodyViewport(): HTMLElement {
  return document.querySelector<HTMLElement>(`.${BODY_SCROLLER_CLASS} [data-radix-scroll-area-viewport]`)!;
}

/**
 * Gives an element a fixed rectangle.
 * @param element - The element.
 * @param top - Its top edge on screen.
 */
function placeAt(element: Element, top: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(0, top, 600, 30),
  });
}

describe('DocumentOutline', () => {
  let opened: { handle: DocumentEditorHandle; doc: Y.Doc; awareness: Awareness };
  let scrollTo: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    observers.length = 0;
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    window.localStorage.clear();
    useDocumentViewStore.setState(useDocumentViewStore.getInitialState());
    useDocumentViewStore.getState().restore(USER);
    scrollTo = vi.fn();
    opened = await openHandle('project-p/outline');
  });

  afterEach(() => {
    for (const editor of collaborators.splice(0)) editor.unmount();
    _resetDocumentEditorCacheForTests();
    opened.awareness.destroy();
    opened.doc.destroy();
  });

  /**
   * Renders the chrome at a wide Space and fills the document; the editor
   * keeps content only once the chrome has mounted it. The chrome sits in an
   * Activity, the way a Space tab is shown and hidden.
   * @param blocks - The document, in block JSON.
   * @param props - Further props for the chrome.
   * @returns A switch that shows or hides the Space.
   */
  function renderWith(blocks: readonly unknown[], props: { readOnly?: boolean } = {}): (mode: 'visible' | 'hidden') => void {
    const ui = (mode: 'visible' | 'hidden'): React.JSX.Element => (
      <React.Activity mode={mode}><DocumentEditor handle={opened.handle} {...props} /></React.Activity>
    );
    const { rerender } = render(ui('visible'));
    fill(opened.handle, blocks);
    resizeTo(1440);
    // On the body's viewport itself: a prototype stub is shadowed by any
    // `scrollTo` another file left on a closer prototype in the shared document.
    Object.defineProperty(bodyViewport(), 'scrollTo', { configurable: true, value: scrollTo });
    return (mode) => rerender(ui(mode));
  }

  describe('A6 — follows the document', () => {
    it('shows a heading as soon as its words change and drops it once deleted', () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Two')]);
      expect(rowTexts()).toEqual(['One', 'Two']);

      act(() => opened.handle.editor.updateBlock(idOf(opened.handle, 'Two'), { content: 'Renamed' } as never));
      expect(rowTexts()).toEqual(['One', 'Renamed']);

      act(() => opened.handle.editor.removeBlocks([idOf(opened.handle, 'One')]));
      expect(rowTexts()).toEqual(['Renamed']);
    });

    it('shows a collaborator’s new heading', async () => {
      renderWith([h('a', 1, 'Mine')]);
      // The peer's edit arrives as a Yjs update, the way the collaboration provider delivers it.
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(opened.doc));
      const theirs = collaboratorOn(remote);
      act(() => theirs.insertBlocks([h('t', 1, 'Theirs')] as never, theirs.document.at(-1)!, 'after'));
      act(() => Y.applyUpdate(opened.doc, Y.encodeStateAsUpdate(remote)));

      await waitFor(() => expect(rowTexts()).toEqual(['Mine', 'Theirs']));
    });

    it('has a collaborator’s heading added while the Space was hidden once it shows again', async () => {
      const show = renderWith([h('a', 1, 'Mine')]);
      show('hidden');

      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(opened.doc));
      const theirs = collaboratorOn(remote);
      act(() => theirs.insertBlocks([h('t', 2, 'While hidden')] as never, theirs.document.at(-1)!, 'after'));
      act(() => Y.applyUpdate(opened.doc, Y.encodeStateAsUpdate(remote)));

      show('visible');
      await waitFor(() => expect(rowTexts()).toEqual(['Mine', 'While hidden']));
    });
  });

  describe('A7, A8, A14 — a click jumps to the heading', () => {
    /**
     * Gives the body and the heading "Two" the rectangles a jump reads: the
     * heading's own line at 700, its block (with the space above the line) at 670.
     */
    function layOut(): void {
      const viewport = bodyViewport();
      placeAt(viewport, 100);
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 5000 });
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 800 });
      viewport.scrollTop = 0;
      const block = document.querySelector(`.bn-block-outer[data-id="${idOf(opened.handle, 'Two')}"]`)!;
      placeAt(block, 670);
      placeAt(block.querySelector(':scope > .bn-block > .bn-block-content')!, 700);
    }

    it('scrolls smoothly so the heading’s line lands 16px under the top of the body', () => {
      renderWith([h('a', 1, 'One'), { type: 'paragraph', content: 'words' }, h('b', 2, 'Two')]);
      layOut();

      fireEvent.click(row('Two'));

      expect(scrollTo).toHaveBeenCalledWith({ top: 700 - 100 - 16, behavior: 'smooth' });
    });

    it('puts an editor’s caret at the start of the heading', () => {
      renderWith([h('a', 1, 'One'), { type: 'paragraph', content: 'words' }, h('b', 2, 'Two')]);
      layOut();

      fireEvent.click(row('Two'));

      const editor = opened.handle.editor;
      expect((editor.getTextCursorPosition().block as { id: string }).id).toBe(idOf(opened.handle, 'Two'));
      expect(editor.prosemirrorState.selection.empty).toBe(true);
      expect(editor.prosemirrorState.selection.$from.parentOffset).toBe(0);
    });

    it('sets the caret and focuses the body before the scroll starts', () => {
      renderWith([h('a', 1, 'One'), { type: 'paragraph', content: 'words' }, h('b', 2, 'Two')]);
      layOut();
      const editor = opened.handle.editor;
      const atScroll: { block?: string; focused?: boolean } = {};
      scrollTo.mockImplementation(() => {
        atScroll.block = (editor.getTextCursorPosition().block as { id: string }).id;
        atScroll.focused = editor.prosemirrorView!.dom.contains(document.activeElement);
      });

      fireEvent.click(row('Two'));

      expect(atScroll).toEqual({ block: idOf(opened.handle, 'Two'), focused: true });
    });

    it('only scrolls for a viewer, leaving the selection where it was', () => {
      renderWith([h('a', 1, 'One'), { type: 'paragraph', content: 'words' }, h('b', 2, 'Two')], { readOnly: true });
      layOut();
      const before = opened.handle.editor.prosemirrorState.selection.toJSON();

      fireEvent.click(row('Two'));

      expect(scrollTo).toHaveBeenCalledWith({ top: 700 - 100 - 16, behavior: 'smooth' });
      expect(opened.handle.editor.prosemirrorState.selection.toJSON()).toEqual(before);
      expect(opened.handle.editor.prosemirrorView!.dom.contains(document.activeElement)).toBe(false);
    });

    /**
     * The line of a top-level heading.
     * @param text - The heading's words.
     * @returns Its `.bn-block-content`.
     */
    function lineOf(text: string): Element {
      return document.querySelector(`.bn-block-outer[data-id="${idOf(opened.handle, text)}"] > .bn-block > .bn-block-content`)!;
    }

    /**
     * Lays out "One" above the reading line and "Two" and "Three" below it, so
     * the reading rule picks "One", or "Three" at the bottom; `scrollTo` moves
     * the viewport straight to where a smooth scroll ends.
     * @param scrollHeight - The body's scroll height; 1000 leaves only 200px of scroll.
     * @returns The body's viewport.
     */
    function layOutForPin(scrollHeight: number): HTMLElement {
      layOut();
      const viewport = bodyViewport();
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: scrollHeight });
      scrollTo.mockImplementation(({ top }: { top: number }) => {
        viewport.scrollTop = Math.min(top, scrollHeight - 800);
      });
      placeAt(lineOf('One'), 40);
      placeAt(lineOf('Three'), 800);
      return viewport;
    }

    /** Runs the frame the highlight is computed in. */
    async function nextFrame(): Promise<void> {
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }

    /**
     * Scrolls the body and runs the frame the highlight is computed in.
     * @param viewport - The body's viewport.
     * @returns Once the frame has run.
     */
    async function scrolled(viewport: HTMLElement): Promise<void> {
      fireEvent.scroll(viewport);
      await nextFrame();
    }

    const itemOf = (text: string): Element => row(text).closest('[data-outline-item]')!;
    const DOC = [h('a', 1, 'One'), { type: 'paragraph', content: 'words' }, h('b', 2, 'Two'), h('c', 2, 'Three')];

    it('keeps the clicked heading while the body stays at its end, and lets go once the user leaves it', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(1000);

      fireEvent.click(row('Two'));
      expect(scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'smooth' });
      await scrolled(viewport);
      expect(itemOf('Two')).toHaveClass('bg-accent-strong');

      viewport.scrollTop = 198;
      await scrolled(viewport);
      expect(itemOf('Two')).toHaveClass('bg-accent-strong');

      viewport.scrollTop = 197;
      await scrolled(viewport);
      expect(itemOf('One')).toHaveClass('bg-accent-strong');
    });

    it('keeps the clicked heading when its landing is within 2px of the end', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(1386);

      fireEvent.click(row('Two'));
      expect(scrollTo).toHaveBeenCalledWith({ top: 584, behavior: 'smooth' });
      await scrolled(viewport);
      expect(itemOf('Two')).toHaveClass('bg-accent-strong');
    });

    it('keeps the clicked heading when content above grows and the browser keeps the view in place', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(1000);
      fireEvent.click(row('Two'));
      await scrolled(viewport);

      // Scroll anchoring moves scrollTop by the growth, so the body is still at its end.
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1300 });
      viewport.scrollTop = 500;
      await scrolled(viewport);
      expect(itemOf('Two')).toHaveClass('bg-accent-strong');
    });

    it('lets go once a rewrap leaves the body short of its end, without a scroll', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(1000);
      fireEvent.click(row('Two'));
      await scrolled(viewport);

      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1300 });
      resizeTo(1440);
      await nextFrame();
      expect(itemOf('One')).toHaveClass('bg-accent-strong');
    });

    it('highlights the clicked heading at once when the jump does not move the body', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(1000);
      viewport.scrollTop = 200;
      await scrolled(viewport);
      expect(itemOf('Three')).toHaveClass('bg-accent-strong');

      fireEvent.click(row('Two'));
      expect(scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'smooth' });
      expect(itemOf('Two')).toHaveClass('bg-accent-strong');
      await nextFrame();
      expect(itemOf('Two')).toHaveClass('bg-accent-strong');
    });

    it('pins nothing for a jump that ends short of the end, even without a scroll', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(5000);
      viewport.scrollTop = 584;
      placeAt(lineOf('Two'), 100 + 16);
      fireEvent.click(row('Two'));
      expect(scrollTo).toHaveBeenCalledWith({ top: 584, behavior: 'smooth' });

      viewport.scrollTop = 4200;
      await scrolled(viewport);
      expect(itemOf('Three')).toHaveClass('bg-accent-strong');
    });

    it('keeps the clicked heading in a body too short to scroll', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(800);
      fireEvent.click(row('Three'));
      await nextFrame();

      act(() => opened.handle.editor.updateBlock(idOf(opened.handle, 'Three'), { content: 'Three more' } as never));
      await nextFrame();
      expect(itemOf('Three more')).toHaveClass('bg-accent-strong');
      expect(viewport.scrollTop).toBe(0);
    });

    it('lets go once the clicked heading is deleted', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(1000);
      fireEvent.click(row('Two'));
      await scrolled(viewport);

      act(() => opened.handle.editor.removeBlocks([idOf(opened.handle, 'Two')]));
      await nextFrame();
      expect(itemOf('Three')).toHaveClass('bg-accent-strong');
    });

    it('lands the heading above the reading line, and follows the reading line after a jump that reached its landing', async () => {
      renderWith(DOC);
      const viewport = layOutForPin(5000);

      fireEvent.click(row('Two'));
      placeAt(lineOf('Two'), 100 + 16);
      await scrolled(viewport);
      expect(itemOf('Two')).toHaveClass('bg-accent-strong');

      placeAt(lineOf('Two'), 300);
      await scrolled(viewport);
      expect(itemOf('One')).toHaveClass('bg-accent-strong');
    });

    describe('while the body scrolls smoothly to a heading', () => {
      const FOUR = [h('a', 1, 'One'), h('m', 2, 'Mid'), h('b', 2, 'Two'), h('c', 2, 'Three')];
      // Each heading's line at scrollTop 0; the body can scroll 200px, and
      // "Two" lands at 200, its end, so "Three" stays below it in view.
      const LINES = { One: 40, Mid: 220, Two: 700, Three: 800 } as const;

      /**
       * Gives the body a 200px scroll; `scrollTo` records only, so the test
       * moves the body frame by frame as a smooth scroll would.
       * @returns The body's viewport.
       */
      function layOutFour(): HTMLElement {
        layOut();
        const viewport = bodyViewport();
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
        for (const [text, top] of Object.entries(LINES)) placeAt(lineOf(text), top);
        return viewport;
      }

      /**
       * Moves the body to a scroll position and runs that frame.
       * @param viewport - The body's viewport.
       * @param top - The new scrollTop.
       * @param grown - How much the content above the headings has grown.
       * @returns Once the frame has run.
       */
      async function frameAt(viewport: HTMLElement, top: number, grown = 0): Promise<void> {
        viewport.scrollTop = top;
        for (const [text, line] of Object.entries(LINES)) placeAt(lineOf(text), line + grown - top);
        await scrolled(viewport);
      }

      /**
       * Grows the content above the headings mid-jump, the way an image without
       * a stored size does once it loads: the body gets taller, scroll anchoring
       * moves scrollTop by the growth, and the size observers fire.
       * @param viewport - The body's viewport.
       * @param top - scrollTop before the growth.
       * @param growth - How much taller the content gets.
       * @param anchored - Whether scroll anchoring moves scrollTop by the growth;
       *   Chrome's running smooth scroll takes it back the next frame.
       * @returns Once the frame after the growth has run.
       */
      async function growAbove(viewport: HTMLElement, top: number, growth: number, anchored = true): Promise<void> {
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 + growth });
        viewport.scrollTop = anchored ? top + growth : top;
        for (const [text, line] of Object.entries(LINES)) placeAt(lineOf(text), line + growth - viewport.scrollTop);
        resizeTo(1440);
        await scrolled(viewport);
      }

      it('aims again when content above grows mid-jump, and pins the clicked heading at the new end', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Two'));
        await frameAt(viewport, 100);
        await growAbove(viewport, 100, 300);
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'smooth' });

        await frameAt(viewport, 450, 300);
        await frameAt(viewport, 500, 300);
        expect(itemOf('Two')).toHaveClass('bg-accent-strong');
      });

      it('measures the closing in afresh from a new aim, so growth the scroll does not absorb keeps the jump', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Two'));
        await frameAt(viewport, 100);
        await growAbove(viewport, 100, 300, false);
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'smooth' });

        await frameAt(viewport, 300, 300);
        await frameAt(viewport, 500, 300);
        expect(itemOf('Two')).toHaveClass('bg-accent-strong');
      });

      it('aims again at a heading short of the end when content above grows mid-jump', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Mid'));
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 104, behavior: 'smooth' });
        await frameAt(viewport, 50);
        await growAbove(viewport, 50, 300);
        expect(scrollTo).toHaveBeenLastCalledWith({ top: 404, behavior: 'smooth' });
      });

      it('lets a jump run on when the body changes size without moving its heading', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Two'));
        await frameAt(viewport, 100);
        resizeTo(1440);
        expect(scrollTo).toHaveBeenCalledTimes(1);
      });

      it('ends a jump the body stops short of, so later growth leaves the scroll alone', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Two'));
        await frameAt(viewport, 100);
        // Typing scrolls the caret into view, which stops the smooth scroll here.
        act(() => fireEvent(viewport, new Event('scrollend')));
        await growAbove(viewport, 100, 300);
        expect(scrollTo).toHaveBeenCalledTimes(1);
      });

      it('pins the clicked heading on the frame the scroll stops at the end', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();
        await frameAt(viewport, 0);

        fireEvent.click(row('Two'));
        viewport.scrollTop = 200;
        for (const [text, line] of Object.entries(LINES)) placeAt(lineOf(text), line - 200);
        act(() => fireEvent(viewport, new Event('scrollend')));
        expect(itemOf('Two')).toHaveClass('bg-accent-strong');
      });

      it('leaves the scroll alone when the body changes height after a jump has arrived', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Mid'));
        await frameAt(viewport, 104);
        scrollTo.mockClear();
        await growAbove(viewport, 104, 300);
        expect(scrollTo).not.toHaveBeenCalled();
      });

      it('follows the body while it scrolls and settles on the clicked heading at the end', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();
        await frameAt(viewport, 0);
        expect(itemOf('One')).toHaveClass('bg-accent-strong');

        fireEvent.click(row('Two'));
        expect(scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'smooth' });
        await nextFrame();
        expect(itemOf('One')).toHaveClass('bg-accent-strong');

        await frameAt(viewport, 100);
        expect(itemOf('Mid')).toHaveClass('bg-accent-strong');

        await frameAt(viewport, 200);
        expect(itemOf('Two')).toHaveClass('bg-accent-strong');
      });

      it('keeps waiting through first frames that carry the body away from the landing', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();
        await frameAt(viewport, 50);

        fireEvent.click(row('Two'));
        await frameAt(viewport, 30);
        await frameAt(viewport, 120);
        await frameAt(viewport, 200);
        expect(itemOf('Two')).toHaveClass('bg-accent-strong');
      });

      it('stops waiting once the body, having closed in, moves away from the landing', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Two'));
        await frameAt(viewport, 100);
        await frameAt(viewport, 50);
        await frameAt(viewport, 200);
        expect(itemOf('Three')).toHaveClass('bg-accent-strong');
      });

      it('stops waiting once another heading is clicked', async () => {
        renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Two'));
        await frameAt(viewport, 100);
        fireEvent.click(row('Mid'));
        await frameAt(viewport, 104);
        await frameAt(viewport, 200);
        expect(itemOf('Three')).toHaveClass('bg-accent-strong');
      });

      it('stops waiting once the Space is hidden', async () => {
        const show = renderWith(FOUR);
        const viewport = layOutFour();

        fireEvent.click(row('Two'));
        await frameAt(viewport, 100);
        show('hidden');
        show('visible');
        await frameAt(viewport, 200);
        expect(itemOf('Three')).toHaveClass('bg-accent-strong');
      });
    });
  });

  describe('A9 — the heading being read', () => {
    it('is shown by its nearest visible ancestor once a fold hides it', async () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Under'), h('c', 1, 'Two')]);
      const viewport = bodyViewport();
      placeAt(viewport, 100);
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 5000 });
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 800 });
      const lineOf = (text: string): Element =>
        document.querySelector(`.bn-block-outer[data-id="${idOf(opened.handle, text)}"] > .bn-block > .bn-block-content`)!;
      placeAt(lineOf('One'), 40);
      placeAt(lineOf('Under'), 110);
      placeAt(lineOf('Two'), 600);
      fireEvent.scroll(viewport);
      const itemOf = (text: string): Element => row(text).closest('[data-outline-item]')!;
      await waitFor(() => expect(itemOf('Under')).toHaveClass('bg-accent-strong'));

      fireEvent.click(within(itemOf('One') as HTMLElement).getByTestId('doc-outline-fold'));

      expect(itemOf('One')).toHaveClass('bg-accent-strong');
    });

    it('changes a row’s words in the same frame as its fill, with no colour transition', () => {
      renderWith([h('a', 1, 'One'), h('b', 1, 'Two')]);
      expect(row('One')).toHaveClass('transition-none');
      expect(row('One')).not.toHaveClass('transition-colors');
    });
  });

  describe('A5 — numbers on a highlighted row', () => {
    it('draws the number of the row being read, and of a hovered row, in the secondary colour', () => {
      renderWith([
        { type: 'heading', props: { level: 1, numbered: true }, content: 'One' },
        { type: 'heading', props: { level: 1, numbered: true }, content: 'Two' },
      ]);
      const numbered = (text: string): HTMLElement =>
        screen.getAllByTestId('doc-outline-row').find((r) => r.lastElementChild?.textContent === text)!;
      fireEvent.click(numbered('Two'));

      const numberOf = (text: string): Element => numbered(text).querySelector('.tabular-nums')!;
      expect(numberOf('Two')).toHaveClass('text-foreground-secondary');
      expect(numberOf('Two')).not.toHaveClass('text-muted-foreground');
      expect(numberOf('One')).toHaveClass('text-muted-foreground', 'group-hover:text-foreground-secondary');
    });
  });

  describe('A10 — folding', () => {
    it('hides the headings under a folded one, and the arrow does not jump', () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Under'), h('c', 3, 'Deeper'), h('d', 1, 'Two')]);

      fireEvent.click(within(row('One').closest('[data-outline-item]') as HTMLElement).getByTestId('doc-outline-fold'));

      expect(rowTexts()).toEqual(['One', 'Two']);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it('lets go of a folded heading once it is deleted, so undoing brings it back unfolded', async () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Under'), h('d', 1, 'Two')]);
      // Past the undo manager's 500ms capture, so the undo below takes back
      // the deletion alone and leaves the document that was filled in.
      await new Promise((resolve) => setTimeout(resolve, 600));
      fireEvent.click(within(row('One').closest('[data-outline-item]') as HTMLElement).getByTestId('doc-outline-fold'));
      expect(rowTexts()).toEqual(['One', 'Two']);

      act(() => opened.handle.editor.removeBlocks([idOf(opened.handle, 'One')]));
      expect(rowTexts()).toEqual(['Under', 'Two']);
      act(() => opened.handle.editor.undo());

      expect(rowTexts()).toEqual(['One', 'Under', 'Two']);
    });

    it('keeps a fold when the Space narrows past the point where the outline floats', () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Under'), h('d', 1, 'Two')]);
      fireEvent.click(within(row('One').closest('[data-outline-item]') as HTMLElement).getByTestId('doc-outline-fold'));

      resizeTo(600);
      expect(screen.getByTestId('doc-outline-column')).toHaveAttribute('data-layout', 'floating');
      expect(rowTexts()).toEqual(['One', 'Two']);

      resizeTo(1440);
      expect(screen.getByTestId('doc-outline-column')).toHaveAttribute('data-layout', 'tiled');
      expect(rowTexts()).toEqual(['One', 'Two']);
    });
  });

  describe('A11 — the icon opens and shuts it', () => {
    it('shuts and opens the outline and remembers it for the account', () => {
      renderWith([h('a', 1, 'One')]);
      expect(rowTexts()).toEqual(['One']);

      fireEvent.click(screen.getByTestId('doc-outline-toggle'));
      expect(rowTexts()).toEqual([]);
      expect(readUserPreferences(USER).documentOutlineVisible).toBe(false);

      fireEvent.click(screen.getByTestId('doc-outline-toggle'));
      expect(rowTexts()).toEqual(['One']);
      expect(readUserPreferences(USER).documentOutlineVisible).toBe(true);
    });

    it('shuts the outline in every open document at once', async () => {
      const second = await openHandle('project-p/outline-second');
      render(
        <>
          <div data-testid='first'><DocumentEditor handle={opened.handle} /></div>
          <div data-testid='second'><DocumentEditor handle={second.handle} /></div>
        </>,
      );
      fill(opened.handle, [h('a', 1, 'First doc')]);
      fill(second.handle, [h('z', 1, 'Second doc')]);
      resizeTo(1440);

      fireEvent.click(within(screen.getByTestId('first')).getByTestId('doc-outline-toggle'));

      expect(within(screen.getByTestId('second')).queryAllByTestId('doc-outline-row')).toHaveLength(0);
      second.awareness.destroy();
      second.doc.destroy();
    });
  });

  describe('A12 — a document with no headings', () => {
    it('says there are no headings yet, which holds for a viewer too', () => {
      renderWith([{ type: 'paragraph', content: 'words only' }]);

      expect(within(screen.getByTestId('doc-outline')).getByText('No headings yet')).toBeInTheDocument();
    });
  });

  describe('A17 — floating when the Space is narrow', () => {
    it('floats under 304px of text, tucks away after a jump, and comes back from the icon', () => {
      renderWith([h('a', 1, 'One'), { type: 'paragraph', content: 'words' }, h('b', 2, 'Two')]);
      resizeTo(639);
      expect(screen.getByTestId('doc-outline-column')).toHaveAttribute('data-layout', 'floating');

      fireEvent.click(row('Two'));
      expect(rowTexts()).toEqual([]);
      expect(useDocumentViewStore.getState().outlineVisible).toBe(true);
      expect(readUserPreferences(USER).documentOutlineVisible).toBe(true);

      fireEvent.click(screen.getByTestId('doc-outline-toggle'));
      expect(rowTexts()).toEqual(['One', 'Two']);
    });

    it('drops the tuck once the Space is wide enough to tile again', () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Two')]);
      resizeTo(639);
      fireEvent.click(row('Two'));
      expect(rowTexts()).toEqual([]);

      resizeTo(1440);
      expect(screen.getByTestId('doc-outline-column')).toHaveAttribute('data-layout', 'tiled');
      expect(rowTexts()).toEqual(['One', 'Two']);
    });

    it('opens with one click after another document shut the outline while this one was tucked', () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Two')]);
      resizeTo(639);
      fireEvent.click(row('Two'));
      expect(rowTexts()).toEqual([]);

      act(() => useDocumentViewStore.getState().setOutlineVisible(false));
      fireEvent.click(screen.getByTestId('doc-outline-toggle'));

      expect(rowTexts()).toEqual(['One', 'Two']);
      expect(useDocumentViewStore.getState().outlineVisible).toBe(true);
    });

    it('keeps a tiled jump from tucking the outline away', () => {
      renderWith([h('a', 1, 'One'), h('b', 2, 'Two')]);

      fireEvent.click(row('Two'));

      expect(rowTexts()).toEqual(['One', 'Two']);
    });
  });
});

/**
 * A mounted editor over another copy of the document, standing in for a
 * collaborator; an editor keeps what it is given only once it is mounted.
 * @param doc - The collaborator's Yjs document.
 * @returns The editor.
 */
function collaboratorOn(doc: Y.Doc): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  collaborators.push(editor);
  return editor;
}
