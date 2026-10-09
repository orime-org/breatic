// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A7–A10, A16, A17, A19: a media block in the body — what it
 * shows, and what its toolbar does.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { DOCUMENT_SCHEMA, documentBodyFragment } from '@breatic/shared';
import { resetPreviewRecords } from '@web/lib/preview-src';

import { BODY_PART } from '@web/spaces/document/document-body-focus';

const download = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock('@web/lib/download', () => ({ triggerDownload: download.trigger }));

const { buildDocumentEditor } = await import('@web/spaces/document/build-document-editor');
const { DocumentMediaViews } = await import('@web/spaces/document/DocumentMediaViews');
const { TooltipProvider } = await import('@web/components/ui/tooltip');
const { attachBodyScroller } = await import('@web/spaces/document/document-body-press');
const { bodyHolds } = await import('@web/spaces/document/document-body-focus');

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
const roots: HTMLElement[] = [];
const detach: (() => void)[] = [];

beforeEach(() => {
  download.trigger.mockReset();
});

afterEach(() => {
  // React takes its own portals down first; only then the editors go.
  cleanup();
  detach.splice(0).forEach((stop) => {
    stop();
  });
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  roots.splice(0).forEach((root) => {
    root.remove();
  });
  document.body.removeAttribute('data-radix-scroll-area-viewport');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPreviewRecords();
});

const URL_OF = 'https://cdn.example/image/2026-10-07/a.png';

/** A block as this file reads it. */
interface Seen {
  id: string;
  type: string;
  props: Record<string, unknown>;
}

/**
 * Opens an editor holding one media block between two lines.
 * @param type - The media block's type.
 * @param props - Its props.
 * @returns The editor.
 */
function open(type: 'image' | 'video' | 'audio', props: Record<string, unknown> = {}): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  // The body scroller, where a press on blank space leaves the focus, around
  // the element the editor mounts on.
  const scroller = document.createElement('div');
  const root = document.createElement('div');
  scroller.appendChild(root);
  document.body.appendChild(scroller);
  roots.push(scroller);
  act(() => {
    editor.mount(root);
  });
  mounted.push(editor);
  // The page's tree, which the blocks are rendered from.
  render(
    <TooltipProvider>
      <DocumentMediaViews editor={editor} />
    </TooltipProvider>,
  );
  act(() => {
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'Above' },
      { type, props: { url: URL_OF, name: 'a.png', ...props } },
      { type: 'paragraph', content: 'Below' },
    ] as never);
  });
  detach.push(attachBodyScroller(editor.prosemirrorView!, scroller, editor));
  return editor;
}

/**
 * The media block.
 * @param editor - The editor.
 * @returns It, as the document holds it now.
 */
function media(editor: Editor): Seen {
  return (editor.document as Seen[])[1]!;
}

/**
 * The media block's element in the body.
 * @param editor - The editor.
 * @returns The `blockContent` element.
 */
function element(editor: Editor): HTMLElement {
  return editor.prosemirrorView!.dom.querySelector<HTMLElement>(
    `[data-content-type="${media(editor).type}"]`,
  )!;
}

/**
 * The media block's toolbar.
 * @param editor - The editor.
 * @returns It.
 */
function toolbar(editor: Editor): HTMLElement {
  return within(element(editor)).getByTestId('doc-media-toolbar');
}

/** An address shaped like one our storage writes, so it has a preview beside it. */
const STORED = 'https://cdn.example/2026-10-07/1765_12345678-1234-1234-1234-123456789abc.png';

describe('the loading state and the preview (A23)', () => {
  let screens: { query: string; cb: () => void }[] = [];

  /**
   * Puts the screen at a ratio, its resolution queries recorded.
   * @param ratio - Device pixels per CSS pixel.
   */
  function screenAt(ratio: number): void {
    vi.stubGlobal('devicePixelRatio', ratio);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: (_: string, cb: () => void) => screens.push({ query, cb }),
      removeEventListener: (_: string, cb: () => void) => {
        screens = screens.filter((l) => l.query !== query || l.cb !== cb);
      },
    }));
  }

  /**
   * Moves the window onto a screen with another ratio.
   * @param from - The ratio it had.
   * @param to - The ratio it has now.
   */
  function moveScreen(from: number, to: number): void {
    vi.stubGlobal('devicePixelRatio', to);
    for (const l of screens.filter((x) => x.query === `(resolution: ${String(from)}dppx)`)) l.cb();
  }

  let boxWidth = 0;
  let observed: (() => void)[] = [];

  /**
   * Lays the media box out this wide, the width the picture is shown at.
   * @param width - CSS pixels.
   */
  function shownAt(width: number): void {
    boxWidth = width;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'doc-media-box' ? boxWidth : 0;
    });
  }

  /**
   * Lays the box out at a new width and tells its resize observers.
   * @param width - CSS pixels.
   */
  function resizeTo(width: number): void {
    boxWidth = width;
    act(() => {
      for (const cb of observed) cb();
    });
  }

  beforeEach(() => {
    screens = [];
    observed = [];
    screenAt(1);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed.push(cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  it('reserves the image\'s final size and covers it with a skeleton until it loads', () => {
    const editor = open('image', { mediaWidth: 800, mediaHeight: 400 });
    const img = element(editor).querySelector('img')!;

    expect(img.getAttribute('width')).toBe('800');
    expect(img.getAttribute('height')).toBe('400');
    expect(within(element(editor)).getByTestId('doc-media-skeleton')).toBeTruthy();

    act(() => {
      img.dispatchEvent(new Event('load'));
    });

    expect(within(element(editor)).queryByTestId('doc-media-skeleton')).toBeNull();
  });

  it('keeps the stored shape after it loads, whatever shape the preview has', () => {
    const editor = open('image', { mediaWidth: 800, mediaHeight: 400 });
    const img = element(editor).querySelector('img')!;

    expect(img.style.aspectRatio).toBe('800 / 400');
    act(() => {
      img.dispatchEvent(new Event('load'));
    });
    expect(img.style.aspectRatio).toBe('800 / 400');
  });

  it('holds the width the picture will be shown at before it loads, when no width was set', () => {
    const editor = open('image', { mediaWidth: 800, mediaHeight: 400 });

    expect(within(element(editor)).getByTestId('doc-media-box').style.width).toBe('800px');
  });

  it('keeps the width the block was set to over the picture\'s own', () => {
    const editor = open('image', { mediaWidth: 800, mediaHeight: 400, previewWidth: 300 });

    expect(within(element(editor)).getByTestId('doc-media-box').style.width).toBe('300px');
  });

  it('draws a 3:2 skeleton across the row while a picture with no size loads, then its own width', () => {
    const editor = open('image', {});
    const box = within(element(editor)).getByTestId('doc-media-box');
    const img = box.querySelector('img')!;

    expect(box.classList.contains('w-full')).toBe(true);
    expect(img.style.aspectRatio).toBe('3 / 2');

    act(() => {
      img.dispatchEvent(new Event('load'));
    });

    expect(img.style.aspectRatio).toBe('');
    expect(within(element(editor)).getByTestId('doc-media-box').classList.contains('w-full')).toBe(false);
  });

  /**
   * Loads the picture as it is drawn now, at a natural width.
   * @param editor - The editor.
   * @param naturalWidth - How wide the loaded file is.
   */
  function loadAt(editor: Editor, naturalWidth: number): void {
    const img = element(editor).querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
    act(() => {
      img.dispatchEvent(new Event('load'));
    });
  }

  it('starts a stored picture on its preview', () => {
    const editor = open('image', { url: STORED, mediaWidth: 1600, mediaHeight: 900 });

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(`${STORED}.preview.webp`);
  });

  it('keeps the preview when it is wide enough for the width shown', () => {
    screenAt(2);
    shownAt(240);
    const editor = open('image', { url: STORED, mediaWidth: 1600, mediaHeight: 900 });

    loadAt(editor, 576);

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(`${STORED}.preview.webp`);
  });

  it('moves to the original once the preview is narrower than the width shown needs', () => {
    screenAt(2);
    shownAt(400);
    const editor = open('image', { url: STORED, mediaWidth: 1600, mediaHeight: 900 });

    loadAt(editor, 576);

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(STORED);
  });

  it('moves to the original when the window goes onto a screen that needs more pixels', () => {
    shownAt(400);
    const editor = open('image', { url: STORED, mediaWidth: 1600, mediaHeight: 900 });
    loadAt(editor, 576);
    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(`${STORED}.preview.webp`);

    act(() => {
      moveScreen(1, 2);
    });

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(STORED);
  });

  it('shows a stored picture with no stored size from its original, as the canvas does', () => {
    shownAt(720);
    const editor = open('image', { url: STORED });

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(STORED);
  });

  it('keeps the original once it has been shown, when the picture is made narrower', () => {
    screenAt(2);
    shownAt(400);
    const editor = open('image', { url: STORED, mediaWidth: 1600, mediaHeight: 900 });
    loadAt(editor, 576);
    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(STORED);

    resizeTo(200);

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(STORED);
  });

  it('moves a picture no wider than its preview to the original too, the preview being a lossy copy', () => {
    screenAt(2);
    shownAt(400);
    const editor = open('image', { url: STORED, mediaWidth: 400, mediaHeight: 300 });

    loadAt(editor, 400);

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(STORED);
  });

  it('falls back to the original when the preview does not load', () => {
    const editor = open('image', { url: `${STORED.slice(0, -4)}.webp`, mediaWidth: 1600, mediaHeight: 900, previewWidth: 200 });
    const img = element(editor).querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/\.preview\.webp$/);

    act(() => {
      img.dispatchEvent(new Event('error'));
    });

    expect(element(editor).querySelector('img')!.getAttribute('src')).toBe(`${STORED.slice(0, -4)}.webp`);
  });

  it.each(['image', 'video'] as const)('stores the %s\'s size in the shared document', (type) => {
    expect(DOCUMENT_SCHEMA.nodes[type]).toEqual(expect.arrayContaining(['mediaWidth', 'mediaHeight']));
  });

  it('hands the video\'s size to the player, which reserves it before anything loads', () => {
    const editor = open('video', { mediaWidth: 1280, mediaHeight: 720 });
    const video = element(editor).querySelector('video')!;

    expect(video.getAttribute('width')).toBe('1280');
    expect(video.getAttribute('height')).toBe('720');
  });
});

describe('what a media block shows (A7)', () => {
  it('draws an image lazily from its address', () => {
    const editor = open('image');

    const img = element(editor).querySelector('img')!;
    expect(img.getAttribute('src')).toBe(URL_OF);
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it.each(['video', 'audio'] as const)('plays a %s with the product player', (type) => {
    const editor = open(type);

    expect(within(element(editor)).getByTestId('media-player')).toBeTruthy();
  });

  it('shows its caption under it, and nothing when it has none (A16)', () => {
    const editor = open('image', { caption: 'Dusk' });
    expect(within(element(editor)).getByTestId('doc-media-caption').textContent).toBe('Dusk');

    act(() => {
      editor.updateBlock(media(editor).id, { props: { caption: '' } } as never);
    });
    expect(within(element(editor)).queryByTestId('doc-media-caption')).toBeNull();
  });
});

describe('a change to its props (A8, A9)', () => {
  it('redraws in place: the element stays the one it was', () => {
    const editor = open('video');
    const before = element(editor);

    act(() => {
      editor.updateBlock(media(editor).id, { props: { previewWidth: 320 } } as never);
    });

    expect(element(editor)).toBe(before);
    expect(within(before).getByTestId('doc-media-box').style.width).toBe('320px');
  });

  it('keeps the block\'s own attributes current, alignment and quote', () => {
    const editor = open('image');

    act(() => {
      editor.updateBlock(media(editor).id, {
        props: { textAlignment: 'right', quoted: true },
      } as never);
    });

    expect(element(editor).getAttribute('data-text-alignment')).toBe('right');
    expect(element(editor).getAttribute('data-quoted')).toBe('true');
  });
});

describe('the toolbar', () => {
  it.each([
    ['image', ['caption', 'fullscreen', 'download', 'delete']],
    ['video', ['caption', 'download', 'delete']],
    ['audio', ['caption', 'download', 'delete']],
  ] as const)('offers on %s: %j, and alignment only when narrower than the body', (type, rows) => {
    const editor = open(type);

    const buttons = within(toolbar(editor))
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-action'));
    expect(buttons).toEqual(rows);
  });

  it('offers alignment on an image narrower than the body (A9)', () => {
    // What the browser does when the block or its row changes size.
    const resized: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        /** @param callback - Called on a resize. */
        constructor(callback: () => void) {
          resized.push(callback);
        }
        /** Unused. */
        observe(): void {}
        /** Unused. */
        disconnect(): void {}
      },
    );
    const editor = open('image', { previewWidth: 200 });
    const box = within(element(editor)).getByTestId('doc-media-box');
    vi.spyOn(box, 'offsetWidth', 'get').mockReturnValue(200);
    vi.spyOn(box.parentElement!, 'clientWidth', 'get').mockReturnValue(600);
    act(() => {
      resized.forEach((callback) => {
        callback();
      });
    });

    // The one the picture has reads as chosen, in the fill every chosen
    // option in the product uses.
    act(() => {
      editor.updateBlock(media(editor).id, { props: { textAlignment: 'center' } } as never);
    });
    expect(within(toolbar(editor)).getByTestId('doc-media-align-center').className).toContain('bg-accent-strong');
    expect(within(toolbar(editor)).getByTestId('doc-media-align-left').className).not.toContain('bg-accent-strong');

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-align-left'));

    expect(media(editor).props['textAlignment']).toBe('left');
    expect(within(toolbar(editor)).getByTestId('doc-media-align-left').className).toContain('bg-accent-strong');
    expect(within(toolbar(editor)).getByTestId('doc-media-align-center').className).not.toContain('bg-accent-strong');
  });

  it('never offers alignment on audio, which is as wide as the body', () => {
    const editor = open('audio');

    expect(within(toolbar(editor)).queryByTestId('doc-media-align-left')).toBeNull();
  });

  it('downloads through the same address the canvas uses (A19)', () => {
    const editor = open('audio');

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-download'));

    expect(download.trigger).toHaveBeenCalledWith(
      `/api/v1/assets/download?url=${encodeURIComponent(URL_OF)}`,
    );
  });

  it('deletes the block', () => {
    const editor = open('video');

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-delete'));

    expect((editor.document as Seen[]).map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('writes a caption on Enter (A16)', () => {
    const editor = open('image');

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const input = within(element(editor)).getByTestId('doc-media-caption-input');
    fireEvent.change(input, { target: { value: 'Dusk' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(media(editor).props['caption']).toBe('Dusk');
  });

  it.each(['Enter', 'Escape'])('leaves the caption open on %s pressed while an input method composes', (key) => {
    const editor = open('image');

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const input = within(element(editor)).getByTestId('doc-media-caption-input');
    fireEvent.change(input, { target: { value: 'せつめい' } });
    fireEvent.keyDown(input, { key, isComposing: true });

    expect(within(element(editor)).getByTestId('doc-media-caption-input')).toBeTruthy();
    expect(media(editor).props['caption']).toBe('');
  });

  it('keeps the block when a key is pressed in its caption while it is selected', () => {
    const editor = open('image', { caption: 'Dusk' });
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const input = within(element(editor)).getByTestId('doc-media-caption-input');
    const view = editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') at = pos;
      return at < 0;
    });
    act(() => {
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    });

    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.keyPress(input, { key: 'x', charCode: 120 });

    expect((editor.document as Seen[]).map((b) => b.type)).toEqual([
      'paragraph',
      'image',
      'paragraph',
    ]);
  });

  it('opens an image full screen, from the toolbar and on a double click (A17)', () => {
    const editor = open('image');

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-fullscreen'));
    expect(screen.getByTestId('doc-media-fullscreen-image').getAttribute('src')).toBe(URL_OF);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.doubleClick(element(editor).querySelector('img')!);
    expect(screen.getByTestId('doc-media-fullscreen-image')).toBeTruthy();
  });
});

describe('where the toolbar goes', () => {
  /**
   * Places the media block and the scroller it is shown in.
   * @param editor - The editor.
   * @param mediaTop - Where the media's top edge is.
   * @param scrollerTop - Where the scroller's top edge is.
   */
  function place(editor: Editor, mediaTop: number, scrollerTop: number): void {
    const frame = within(element(editor)).getByTestId('doc-media-box');
    // The body stands in for the scroller the block is shown in.
    const scroller = document.body;
    scroller.setAttribute('data-radix-scroll-area-viewport', '');
    vi.spyOn(toolbar(editor), 'offsetHeight', 'get').mockReturnValue(34);
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(
      { top: mediaTop, bottom: mediaTop + 200, left: 0, right: 400, width: 400, height: 200 } as DOMRect,
    );
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(
      { top: scrollerTop, bottom: scrollerTop + 800, left: 0, right: 1000, width: 1000, height: 800 } as DOMRect,
    );
  }

  it('stays above the media when there is room above it', () => {
    const editor = open('image');
    place(editor, 300, 100);

    fireEvent.pointerEnter(within(element(editor)).getByTestId('doc-media-frame'));

    expect(toolbar(editor).getAttribute('data-side')).toBe('top');
  });

  it('moves onto the media when the scroller is scrolled until there is no room above', () => {
    const editor = open('image');
    place(editor, 300, 100);
    selectMedia(editor);
    expect(toolbar(editor).getAttribute('data-side')).toBe('top');

    place(editor, 110, 100);
    act(() => {
      document.body.dispatchEvent(new Event('scroll'));
    });

    expect(toolbar(editor).getAttribute('data-side')).toBe('inside');
  });

  it('sits on the media, at its top, when the scroller has no room above it', () => {
    const editor = open('image');
    place(editor, 110, 100);

    fireEvent.pointerEnter(within(element(editor)).getByTestId('doc-media-frame'));

    expect(toolbar(editor).getAttribute('data-side')).toBe('inside');
  });
});

/**
 * Node-selects the media block and gives the body the focus, the way a
 * press on it does.
 * @param editor - The editor.
 */
function selectMedia(editor: Editor): void {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (['image', 'video', 'audio'].includes(node.type.name)) at = pos;
    return at < 0;
  });
  act(() => {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    // A press on the media gives the body the focus as it selects it; the
    // block is drawn selected only while the body holds the focus.
    view.focus();
  });
}

describe('a caption written through an input method (A16)', () => {
  it('is kept when the block is selected while the words are composed', async () => {
    const editor = open('image');
    selectMedia(editor);
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const input = within(element(editor)).getByTestId('doc-media-caption-input');

    fireEvent.compositionStart(input, { data: '' });
    fireEvent.change(input, { target: { value: '说明' } });
    fireEvent.compositionEnd(input, { data: '说明' });
    // The Enter that confirms the candidate is the input method's; the
    // reader's own Enter afterwards commits.
    await new Promise((done) => setTimeout(done, 0));
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(media(editor).props['caption']).toBe('说明');
  });
});

describe('the toolbar looks like the selection bubble bar', () => {
  it('takes the bar\'s frame and the bar\'s button size', async () => {
    const { BUBBLE_BAR_CLASS, BUBBLE_ICON_BUTTON_SIZE } = await import(
      '@web/spaces/document/document-tool-button'
    );
    const editor = open('image');

    for (const name of BUBBLE_BAR_CLASS.split(' ')) {
      expect(toolbar(editor).classList).toContain(name);
    }
    for (const button of within(toolbar(editor)).getAllByRole('button')) {
      for (const name of BUBBLE_ICON_BUTTON_SIZE.split(' ')) {
        expect(button.classList).toContain(name);
      }
    }
  });
});

describe('resizing (A8)', () => {
  it('offers a knob on each corner of a selected picture or video, and none before', () => {
    const editor = open('image', { previewWidth: 200 });
    expect(within(element(editor)).queryByTestId('doc-media-resize-se')).toBeNull();

    selectMedia(editor);

    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      expect(within(element(editor)).getByTestId(`doc-media-resize-${corner}`)).toBeTruthy();
    }
  });

  it('writes the width once, when the corner is let go', () => {
    const editor = open('image', { previewWidth: 200, textAlignment: 'left' });
    selectMedia(editor);
    vi.spyOn(within(element(editor)).getByTestId('doc-media-box'), 'offsetWidth', 'get').mockReturnValue(200);
    const handle = within(element(editor)).getByTestId('doc-media-resize-se');

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    expect(media(editor).props['previewWidth']).toBe(200);
    fireEvent.pointerUp(handle, { clientX: 150, pointerId: 1 });

    expect(media(editor).props['previewWidth']).toBe(250);
  });

  it('shrinks from a left corner when it is dragged inwards', () => {
    const editor = open('video', { previewWidth: 300, textAlignment: 'left' });
    selectMedia(editor);
    vi.spyOn(within(element(editor)).getByTestId('doc-media-box'), 'offsetWidth', 'get').mockReturnValue(300);
    const handle = within(element(editor)).getByTestId('doc-media-resize-nw');

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 });

    expect(media(editor).props['previewWidth']).toBe(260);
  });

  it('starts from the width on screen when the body is narrower than the stored width', () => {
    const editor = open('image', { previewWidth: 900, textAlignment: 'left' });
    selectMedia(editor);
    const box = within(element(editor)).getByTestId('doc-media-box');
    vi.spyOn(box, 'offsetWidth', 'get').mockReturnValue(700);
    vi.spyOn(within(element(editor)).getByTestId('doc-media-row'), 'clientWidth', 'get').mockReturnValue(700);
    const handle = within(element(editor)).getByTestId('doc-media-resize-se');

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 50, pointerId: 1 });

    expect(media(editor).props['previewWidth']).toBe(650);
  });

  it('writes nothing when a corner is pressed and let go without moving', () => {
    const editor = open('image', { textAlignment: 'left' });
    selectMedia(editor);
    const before = media(editor).props['previewWidth'];
    const handle = within(element(editor)).getByTestId('doc-media-resize-se');

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });

    expect(media(editor).props['previewWidth']).toBe(before);
  });

  it.each([
    ['image', 48],
    ['video', 128],
  ] as const)('stops a %s at %ipx, however far the corner is pulled in', (type, floor) => {
    const editor = open(type, { previewWidth: 300, textAlignment: 'left' });
    selectMedia(editor);
    vi.spyOn(within(element(editor)).getByTestId('doc-media-box'), 'offsetWidth', 'get').mockReturnValue(300);
    const handle = within(element(editor)).getByTestId('doc-media-resize-se');

    fireEvent.pointerDown(handle, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 0, pointerId: 1 });

    expect(media(editor).props['previewWidth']).toBe(floor);
  });

  it('gives audio no knobs', () => {
    const editor = open('audio');
    selectMedia(editor);

    expect(within(element(editor)).queryByTestId('doc-media-resize-se')).toBeNull();
  });
});

describe('the frame around a media block', () => {
  it('goes around the media and leaves the caption out', () => {
    const editor = open('image', { caption: 'A note' });

    const frame = element(editor).querySelector('[data-media-frame]')!;
    expect(frame.querySelector('img')).not.toBeNull();
    expect(frame.contains(within(element(editor)).getByTestId('doc-media-caption'))).toBe(false);
  });

  it('is drawn while the pointer is on the media, the same way as when selected', () => {
    const editor = open('video');
    const box = within(element(editor)).getByTestId('doc-media-box');
    const frame = within(element(editor)).getByTestId('doc-media-frame');
    expect(box.getAttribute('data-hovered')).toBeNull();

    fireEvent.pointerEnter(frame);
    expect(box.getAttribute('data-hovered')).toBe('true');

    fireEvent.pointerLeave(frame);
    expect(box.getAttribute('data-hovered')).toBeNull();
  });

  it('stays while the pointer goes from the media up to its toolbar', () => {
    const editor = open('video');
    const box = within(element(editor)).getByTestId('doc-media-box');
    const frame = within(element(editor)).getByTestId('doc-media-frame');
    const layer = toolbar(editor).parentElement!;

    fireEvent.pointerEnter(frame);
    fireEvent.pointerLeave(frame);
    fireEvent.pointerEnter(layer);
    expect(box.getAttribute('data-hovered')).toBe('true');

    fireEvent.pointerLeave(layer);
    expect(box.getAttribute('data-hovered')).toBeNull();
  });

  it('is not drawn while the pointer is on the caption', () => {
    const editor = open('audio', { caption: 'A note' });
    const box = within(element(editor)).getByTestId('doc-media-box');

    fireEvent.pointerEnter(box);
    fireEvent.pointerEnter(within(element(editor)).getByTestId('doc-media-caption'));
    expect(box.getAttribute('data-hovered')).toBeNull();
  });
});

describe('the delete button', () => {
  it('is drawn in the error red, the colour every delete row in the body uses', () => {
    const editor = open('image');

    const remove = within(toolbar(editor)).getByTestId('doc-media-delete');
    expect(remove.className).toContain('text-status-error-foreground');
    expect(remove.className).toContain('hover:text-status-error-foreground');
  });
});

describe('a file dragged onto the controls of a media block (A2)', () => {
  it.each(['dragover', 'drop'] as const)('has its %s taken, so the browser does not open the file', (type) => {
    const editor = open('image');
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })] },
    });

    within(toolbar(editor)).getByTestId('doc-media-delete').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});

describe('dragging a media block by its media (A10)', () => {
  /**
   * A `dragstart` from inside the block, as the browser fires it.
   * @param target - Where the press started.
   * @returns The event.
   */
  function dragFrom(target: Element): Event {
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: [],
        getData: () => '',
        setData: vi.fn(),
        clearData: vi.fn(),
        setDragImage: vi.fn(),
        effectAllowed: 'all',
      },
    });
    Object.defineProperty(event, 'clientY', { value: 0 });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it('moves the row the way its handle does', async () => {
    const editor = open('image');
    const { SideMenuExtension } = await import('@blocknote/core/extensions');
    const start = vi.spyOn(editor.getExtension(SideMenuExtension)!, 'blockDragStart').mockImplementation(() => undefined);
    const frame = within(element(editor)).getByTestId('doc-media-frame');

    expect(frame.getAttribute('draggable')).toBe('true');
    dragFrom(element(editor).querySelector('img')!);

    expect(start).toHaveBeenCalledOnce();
    expect((start.mock.calls[0]![1] as { id: string }).id).toBe(media(editor).id);
    vi.spyOn(editor.getExtension(SideMenuExtension)!, 'blockDragEnd').mockImplementation(() => undefined);
    fireEvent.dragEnd(frame);
  });

  it('turns the drag off as a press lands on a corner, so the resize keeps its pointer', () => {
    const editor = open('image', { previewWidth: 200 });
    selectMedia(editor);
    const frame = within(element(editor)).getByTestId('doc-media-frame');

    fireEvent.pointerDown(within(element(editor)).getByTestId('doc-media-resize-se'), { pointerId: 1 });
    expect(frame.draggable).toBe(false);

    fireEvent.pointerDown(element(editor).querySelector('img')!, { pointerId: 2 });
    expect(frame.draggable).toBe(true);
  });

  it('turns the drag off as a press lands on the player controls, so they keep their pointer', () => {
    const editor = open('video', { previewWidth: 320 });
    const frame = within(element(editor)).getByTestId('doc-media-frame');

    fireEvent.pointerDown(within(element(editor)).getByTestId('seek'), { pointerId: 1 });
    expect(frame.draggable).toBe(false);
  });

  it('ends on a drop in the page, though the element it started from never sees its dragend', async () => {
    vi.useFakeTimers();
    try {
      const editor = open('image');
      const { SideMenuExtension } = await import('@blocknote/core/extensions');
      const menu = editor.getExtension(SideMenuExtension)!;
      vi.spyOn(menu, 'blockDragStart').mockImplementation(() => undefined);
      const end = vi.spyOn(menu, 'blockDragEnd').mockImplementation(() => undefined);
      const frame = within(element(editor)).getByTestId('doc-media-frame');
      const removed = vi.spyOn(document, 'removeEventListener');
      dragFrom(element(editor).querySelector('img')!);

      document.body.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      expect(end).not.toHaveBeenCalled();
      act(() => {
        vi.runAllTimers();
      });
      expect(end).toHaveBeenCalledOnce();
      // The page is left as it was: no drop listener outlives the drag.
      expect(removed).toHaveBeenCalledWith('drop', expect.any(Function), true);

      fireEvent.dragEnd(frame);
      document.body.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      act(() => {
        vi.runAllTimers();
      });
      expect(end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a media block whose neighbour goes away', () => {
  it('keeps its own player, so a video playing below a deleted picture keeps playing', () => {
    const editor = open('image');
    act(() => {
      editor.insertBlocks(
        [{ type: 'video', props: { url: URL_OF, name: 'v.mp4' } }] as never,
        (editor.document as { id: string }[]).at(-1)!.id,
        'after',
      );
    });
    const video = (): HTMLVideoElement => editor.prosemirrorView!.dom.querySelector('[data-content-type="video"] video')!;
    const before = video();
    expect(before).not.toBeNull();

    act(() => {
      editor.removeBlocks([media(editor).id]);
    });

    expect(video()).toBe(before);
  });
});

/**
 * A press and release beside the media, the way the browser fires them.
 * @param target - Where both land.
 * @param detail - How many clicks in a row this one is.
 * @param keys - Modifier keys held.
 * @param button - Which button.
 * @returns The press.
 */
function clickBeside(target: Element, detail: number, keys: MouseEventInit = {}, button = 0): MouseEvent {
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, detail, ...keys });
  act(() => {
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button, ...keys }));
    target.dispatchEvent(press);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button, detail, ...keys }));
  });
  // The browser fires `click` for the main button and `auxclick` for the others.
  act(() => {
    target.dispatchEvent(
      new MouseEvent(button === 0 ? 'click' : 'auxclick', { bubbles: true, cancelable: true, button, detail, ...keys }),
    );
  });
  return press;
}

/**
 * The body scroller an open editor sits in.
 * @param editor - The editor.
 * @returns It.
 */
function scrollerOf(editor: Editor): HTMLElement {
  return roots.find((root) => root.contains(editor.prosemirrorView!.dom))!;
}

describe('a press beside a media block', () => {
  it('lets the body go on a press beside the media or on its caption: the media stays the selection, drawn as not selected', () => {
    const editor = open('image', { previewWidth: 200, caption: 'A note' });
    const view = editor.prosemirrorView!;
    const caption = within(element(editor)).getByTestId('doc-media-caption');
    for (const target of [element(editor), caption]) {
      for (const detail of [1, 2, 3]) {
        selectMedia(editor);
        // ProseMirror's own answers to the click pick nothing here.
        const up = new MouseEvent('mouseup', { bubbles: true, button: 0 });
        Object.defineProperty(up, 'target', { value: target });
        const props = ['handleClick', 'handleDoubleClick', 'handleTripleClick'] as const;
        for (const prop of props) {
          expect(view.someProp(prop, (f) => f(view, 0, up))).toBe(true);
        }

        const press = clickBeside(target, detail);

        expect(press.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(scrollerOf(editor));
        expect(bodyHolds(view.state)).toBe(false);
        expect(view.state.selection).toBeInstanceOf(NodeSelection);
        expect(within(element(editor)).getByTestId('doc-media-box').getAttribute('data-selected')).toBeNull();
      }
    }
  });

  it('extends the selection from a Shift press beside a selected picture, the body keeping the focus', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    selectMedia(editor);

    const press = clickBeside(element(editor), 1, { shiftKey: true });

    expect(press.defaultPrevented).toBe(true);
    expect(bodyHolds(view.state)).toBe(true);
    expect(view.dom.contains(document.activeElement)).toBe(true);
  });

  it('answers a right press beside a selected picture the way it answers the main one, as it goes down', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    selectMedia(editor);

    const press = clickBeside(element(editor), 1, {}, 2);

    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(scrollerOf(editor));
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it('leaves a middle press beside a selected picture to the browser', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    selectMedia(editor);

    const press = clickBeside(element(editor), 1, {}, 1);

    expect(press.defaultPrevented).toBe(false);
    expect(bodyHolds(view.state)).toBe(true);
  });

  it('keeps the picture selected through a press and click on its own controls, a toolbar button and a corner', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    selectMedia(editor);
    act(() => {
      view.focus();
    });

    for (const control of [within(toolbar(editor)).getByTestId('doc-media-download'), within(element(editor)).getByTestId('doc-media-resize-se')]) {
      clickBeside(control, 1);
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
    }
  });

  it('keeps the picture selected when the press landed on it and the pointer was let go beside it', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    act(() => {
      element(editor).querySelector('img')!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    act(() => {
      element(editor).dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
    });

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it('selects the media as the press on it lands, and gives the body the focus with it selected', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    });
    expect(view.dom.contains(document.activeElement)).toBe(false);

    const press = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      element(editor).querySelector('img')!.dispatchEvent(press);
    });

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect((view.state.selection as NodeSelection).node.type.name).toBe('image');
    // Focused only once the media is selected: ProseMirror writes the
    // selection to the page as it takes the focus, so the caret the body kept
    // while it had none is never drawn.
    expect(document.activeElement).toBe(view.dom);
    // The press goes on to the browser, which starts a drag from it.
    expect(press.defaultPrevented).toBe(false);
  });

  it('selects a video on a press on its seek bar, which keeps the press from becoming a mousedown', () => {
    const editor = open('video', { previewWidth: 320 });
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    });
    const seek = within(element(editor)).getByTestId('seek');
    // The slider cancels the press, as Radix does, so no mousedown follows.
    seek.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });

    act(() => {
      seek.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect((view.state.selection as NodeSelection).node.type.name).toBe('video');
  });

  it('answers a click held with the node modifier the way it answers a plain one', () => {
    const editor = open('image', { previewWidth: 200, caption: 'A note' });
    const view = editor.prosemirrorView!;
    const caption = within(element(editor)).getByTestId('doc-media-caption');
    const img = element(editor).querySelector('img')!;
    /**
     * Clicks with Cmd and Ctrl held, through every handler the editor asks.
     * @param target - Where the click lands.
     * @returns Whether a handler answered it.
     */
    const modifierClick = (target: Element): boolean => {
      const click = new MouseEvent('mouseup', { bubbles: true, button: 0, metaKey: true, ctrlKey: true });
      Object.defineProperty(click, 'target', { value: target });
      let answered = false;
      act(() => {
        answered = view.someProp('handleClick', (f) => f(view, view.posAtDOM(element(editor), 0), click)) === true;
      });
      return answered;
    };

    // Beside the media and on its caption: the body lets go, as on a plain click.
    for (const target of [element(editor), caption]) {
      selectMedia(editor);
      expect(modifierClick(target)).toBe(true);
      clickBeside(target, 1, { metaKey: true });
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
      expect(bodyHolds(view.state)).toBe(false);
      expect(document.activeElement).toBe(scrollerOf(editor));
    }

    // On the media the press selected: it stays the media that is selected.
    selectMedia(editor);
    expect(modifierClick(img)).toBe(true);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect((view.state.selection as NodeSelection).node.type.name).toBe('image');
  });

  it.each([1, 2])('selects the media as a press with button %i on it lands, with no caret before', (button) => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    });

    act(() => {
      element(editor)
        .querySelector('img')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button }));
    });

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(view.dom.contains(document.activeElement)).toBe(true);
  });

  it('leaves a Shift press on the media to the editor, which extends the selection', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    });

    act(() => {
      element(editor)
        .querySelector('img')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    });

    expect(view.state.selection).toBeInstanceOf(TextSelection);
  });

  it.each([0, 1, 2])('selects the media on a click on it with button %i', (button) => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    });
    const click = new MouseEvent('mouseup', { bubbles: true, button });
    Object.defineProperty(click, 'target', { value: element(editor).querySelector('img') });

    act(() => {
      view.someProp('handleClick', (f) => f(view, 0, click));
    });

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect((view.state.selection as NodeSelection).node.type.name).toBe('image');
  });
});

describe('the focus around a media block', () => {
  it('stays in the body when its toolbar is pressed', () => {
    const editor = open('image', { previewWidth: 200 });
    selectMedia(editor);
    const align = within(toolbar(editor)).getByTestId('doc-media-download');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });

    act(() => {
      align.dispatchEvent(press);
    });

    expect(press.defaultPrevented).toBe(true);
    expect(align.getAttribute('tabindex')).toBe('-1');
  });

  it.each(['Enter', 'Escape'])('goes back to the body when the caption closes with %s', (key) => {
    const editor = open('image', { previewWidth: 200 });
    selectMedia(editor);
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const field = within(element(editor)).getByTestId('doc-media-caption-input');
    act(() => {
      field.focus();
    });

    fireEvent.keyDown(field, { key });

    expect(document.activeElement).toBe(editor.prosemirrorView!.dom);
  });

  it('lets the body go, the block still selected but not drawn so, when the focus leaves from the caption field', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    selectMedia(editor);
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const field = within(element(editor)).getByTestId('doc-media-caption-input');
    act(() => {
      field.focus();
    });
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    act(() => {
      outside.focus();
    });

    expect(bodyHolds(view.state)).toBe(false);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(within(element(editor)).getByTestId('doc-media-box').getAttribute('data-selected')).toBeNull();
    outside.remove();
  });

  it.each(['toolbar', 'double click'] as const)(
    'comes back to the picture, selected, when the full-screen picture opened from the %s closes',
    async (from) => {
      // The focus moving into the dialog is the focus leaving the body, which
      // lets go of a selected block only while the window itself is focused.
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const editor = open('image', { previewWidth: 200 });
      const view = editor.prosemirrorView!;
      selectMedia(editor);
      act(() => {
        view.focus();
      });
      if (from === 'toolbar') {
        fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-fullscreen'));
      } else {
        fireEvent.doubleClick(element(editor).querySelector('img')!);
      }
      const picture = await screen.findByTestId('doc-media-fullscreen-image');
      // The full-screen picture is the block's own: the body is not left.
      expect(view.state.selection).toBeInstanceOf(NodeSelection);

      fireEvent.keyDown(picture, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByTestId('doc-media-fullscreen-image')).toBeNull();
      });
      expect(document.activeElement).toBe(view.dom);
      expect(view.state.selection).toBeInstanceOf(NodeSelection);
      expect((view.state.selection as NodeSelection).node.type.name).toBe('image');
    },
  );

  it.each([
    ['a caret', 2, 2],
    ['a range of words', 1, 4],
  ] as const)(
    'gives the body back %s it held when the full-screen picture opened from the toolbar of an unselected picture',
    async (_what, from, to) => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const editor = open('image', { previewWidth: 200 });
      const view = editor.prosemirrorView!;
      const below = view.state.doc.content.size - 'Below'.length - 2;
      act(() => {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, below + from, below + to)));
        view.focus();
      });

      fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-fullscreen'));
      const picture = await screen.findByTestId('doc-media-fullscreen-image');
      fireEvent.keyDown(picture, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByTestId('doc-media-fullscreen-image')).toBeNull();
      });

      expect(document.activeElement).toBe(view.dom);
      expect(view.state.selection).toBeInstanceOf(TextSelection);
      expect([view.state.selection.from, view.state.selection.to]).toEqual([below + from, below + to]);
    },
  );

  it('leaves the body without the keyboard when what had it outside the body is gone by the time the picture closes', async () => {
    const editor = open('image', { previewWidth: 200 });
    const menu = document.createElement('div');
    const item = document.createElement('button');
    menu.appendChild(item);
    document.body.appendChild(menu);
    act(() => {
      item.focus();
    });

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-fullscreen'));
    const picture = await screen.findByTestId('doc-media-fullscreen-image');
    // The menu the keyboard was in closes while the picture is open.
    menu.remove();
    fireEvent.keyDown(picture, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-media-fullscreen-image')).toBeNull();
    });

    expect(editor.prosemirrorView!.dom.contains(document.activeElement)).toBe(false);
  });

  it('leaves the focus nowhere when nothing had it as the full-screen picture opened', async () => {
    const editor = open('image', { previewWidth: 200 });
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-fullscreen'));
    const picture = await screen.findByTestId('doc-media-fullscreen-image');
    fireEvent.keyDown(picture, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-media-fullscreen-image')).toBeNull();
    });

    expect(editor.prosemirrorView!.dom.contains(document.activeElement)).toBe(false);
  });
});

describe('a document with no line for text', () => {
  /**
   * Opens an editor whose only block is a picture.
   * @returns The editor.
   */
  function onlyPicture(): Editor {
    const editor = open('image', { previewWidth: 200 });
    act(() => {
      editor.replaceBlocks(editor.document, [
        { type: 'image', props: { url: URL_OF, name: 'a.png', previewWidth: 200 } },
      ] as never);
    });
    return editor;
  }

  /**
   * The picture's box, which carries whether it is drawn as selected.
   * @param editor - The editor.
   * @returns It.
   */
  function box(editor: Editor): HTMLElement {
    return within(editor.prosemirrorView!.dom).getByTestId('doc-media-box');
  }

  it('draws the picture as not selected once the focus leaves the body, and as selected when it comes back', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const editor = onlyPicture();
    const view = editor.prosemirrorView!;
    selectMedia(editor);
    act(() => {
      view.focus();
    });
    expect(box(editor).getAttribute('data-selected')).toBe('true');
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    act(() => {
      outside.focus();
    });
    expect(box(editor).getAttribute('data-selected')).toBeNull();

    act(() => {
      view.focus();
    });
    expect(box(editor).getAttribute('data-selected')).toBe('true');
    outside.remove();
  });

  /**
   * Opens the picture alone, selected, then moves the focus out of the body.
   * @returns The editor and the element now holding the focus.
   */
  function letGoOfOnlyPicture(): { editor: Editor; outside: HTMLElement } {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const editor = onlyPicture();
    selectMedia(editor);
    act(() => {
      editor.prosemirrorView!.focus();
    });
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
    });
    expect(box(editor).getAttribute('data-selected')).toBeNull();
    return { editor, outside };
  }

  it('keeps the picture drawn as not selected when a collaborator\'s change or an undo sets the same selection again', () => {
    const { editor, outside } = letGoOfOnlyPicture();
    const view = editor.prosemirrorView!;

    act(() => {
      view.dispatch(view.state.tr.setSelection(view.state.selection));
    });

    expect(box(editor).getAttribute('data-selected')).toBeNull();
    outside.remove();
  });

  it('keeps the picture drawn as not selected when the focus moves into the body of another Space', () => {
    const { editor, outside } = letGoOfOnlyPicture();
    const other = document.createElement('div');
    other.setAttribute(BODY_PART, '');
    const field = document.createElement('button');
    other.appendChild(field);
    document.body.appendChild(other);

    act(() => {
      field.focus();
    });

    expect(box(editor).getAttribute('data-selected')).toBeNull();
    other.remove();
    outside.remove();
  });

  it('draws the picture selected again when the focus moves into a layer the picture opened, which is the body\'s own', () => {
    const { editor, outside } = letGoOfOnlyPicture();
    const layer = document.createElement('div');
    layer.id = 'picture-layer';
    const inside = document.createElement('button');
    layer.appendChild(inside);
    document.body.appendChild(layer);
    const opener = document.createElement('span');
    opener.setAttribute('aria-controls', layer.id);
    editor.prosemirrorView!.dom.querySelector('[data-content-type="image"]')!.appendChild(opener);

    act(() => {
      inside.focus();
    });

    expect(box(editor).getAttribute('data-selected')).toBe('true');
    layer.remove();
    outside.remove();
  });

  it('draws the picture selected while its caption field, opened from the toolbar, has the keyboard', () => {
    const { editor, outside } = letGoOfOnlyPicture();
    const view = editor.prosemirrorView!;
    const row = view.dom.querySelector<HTMLElement>('[data-content-type="image"]')!;

    act(() => {
      fireEvent.click(within(row).getByTestId('doc-media-caption-button'));
    });

    expect(document.activeElement).toBe(within(row).getByTestId('doc-media-caption-input'));
    expect(box(editor).getAttribute('data-selected')).toBe('true');
    outside.remove();
  });

  it('draws the picture as not selected after a click beside it', () => {
    const editor = onlyPicture();
    const view = editor.prosemirrorView!;
    selectMedia(editor);
    act(() => {
      view.focus();
    });
    expect(box(editor).getAttribute('data-selected')).toBe('true');
    clickBeside(view.dom.querySelector('[data-content-type="image"]')!, 1);

    expect(box(editor).getAttribute('data-selected')).toBeNull();
    expect(view.dom.contains(document.activeElement)).toBe(false);
  });
});

describe('a picture with a table right under it', () => {
  /**
   * Opens Above, a selected picture, then a table, with the body focused.
   * @returns The editor.
   */
  function overTable(): Editor {
    const editor = open('image', { previewWidth: 200 });
    act(() => {
      editor.replaceBlocks(editor.document, [
        { type: 'paragraph', content: 'Above' },
        { type: 'image', props: { url: URL_OF, name: 'a.png', previewWidth: 200 } },
        { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['x', 'y'] }] } },
      ] as never);
    });
    selectMedia(editor);
    act(() => {
      editor.prosemirrorView!.focus();
    });
    return editor;
  }

  /**
   * Whether the selection sits in a table cell.
   * @param editor - The editor.
   * @returns True inside a cell.
   */
  function inCell(editor: Editor): boolean {
    const { $from } = editor.prosemirrorView!.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.spec.tableRole === 'cell') return true;
    }
    return false;
  }

  /**
   * The picture's box, which carries whether it is drawn as selected.
   * @param editor - The editor.
   * @returns It.
   */
  function box(editor: Editor): HTMLElement {
    return within(editor.prosemirrorView!.dom).getByTestId('doc-media-box');
  }

  it('puts no caret in the table when the focus leaves the body, and draws the picture as not selected', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const editor = overTable();
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    act(() => {
      outside.focus();
    });

    expect(inCell(editor)).toBe(false);
    expect(box(editor).getAttribute('data-selected')).toBeNull();
    outside.remove();
  });

  it('puts no caret in the table after a click beside the picture', () => {
    const editor = overTable();

    clickBeside(editor.prosemirrorView!.dom.querySelector('[data-content-type="image"]')!, 1);

    expect(inCell(editor)).toBe(false);
    expect(box(editor).getAttribute('data-selected')).toBeNull();
    expect(editor.prosemirrorView!.dom.contains(document.activeElement)).toBe(false);
  });
});

describe('keys pressed on a control inside a media block', () => {
  it.each(['Enter', ' ', 'Tab', 'ArrowRight', 'z'])('leave %j to the control, not to the body', (key) => {
    const editor = open('video');
    const view = editor.prosemirrorView!;
    selectMedia(editor);
    const control = element(editor).querySelector<HTMLElement>('[data-media-frame] button')!;
    act(() => {
      control.focus();
    });
    const before = view.state.doc.toJSON();

    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      control.dispatchEvent(event);
    });

    expect(view.state.doc.toJSON()).toEqual(before);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('a click beside a picture when another kind of selection is in the body', () => {
  /**
   * Opens Above, a picture, then a two-cell table.
   * @param withAbove - Whether a line of text sits above the picture.
   * @returns The editor.
   */
  function overTable(withAbove: boolean): Editor {
    const editor = open('image', { previewWidth: 200 });
    act(() => {
      editor.replaceBlocks(editor.document, [
        ...(withAbove ? [{ type: 'paragraph', content: 'Above' }] : []),
        { type: 'image', props: { url: URL_OF, name: 'a.png', previewWidth: 200 } },
        { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['x', 'y'] }] } },
      ] as never);
    });
    return editor;
  }

  /**
   * Selects both cells of the table.
   * @param editor - The editor.
   */
  function selectCells(editor: Editor): void {
    const view = editor.prosemirrorView!;
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === 'cell') cells.push(pos);
      return true;
    });
    act(() => {
      view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0]!, cells[1]!)));
      view.focus();
    });
    expect(view.state.selection).toBeInstanceOf(CellSelection);
  }

  it.each([true, false])(
    'leaves the cell selection where it was and lets the body go (a line above the picture: %s)',
    (withAbove) => {
      const editor = overTable(withAbove);
      selectCells(editor);
      const view = editor.prosemirrorView!;

      clickBeside(view.dom.querySelector('[data-content-type="image"]')!, 1);

      expect(view.state.selection).toBeInstanceOf(CellSelection);
      expect(bodyHolds(view.state)).toBe(false);
      expect(view.dom.contains(document.activeElement)).toBe(false);
    },
  );
});

describe('the caption field and the keyboard', () => {
  /**
   * Opens a selected picture's caption field with the focus in it.
   * @returns The editor and the field.
   */
  function openCaption(): { editor: Editor; field: HTMLElement } {
    const editor = open('image', { previewWidth: 200 });
    selectMedia(editor);
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const field = within(element(editor)).getByTestId('doc-media-caption-input');
    act(() => {
      field.focus();
    });
    return { editor, field };
  }

  it('stays open on the key an input method reports as 229', () => {
    const { editor, field } = openCaption();

    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });

    expect(within(element(editor)).queryByTestId('doc-media-caption-input')).not.toBeNull();
  });

  it('stays open on the Enter that follows the end of a composition', () => {
    const { editor, field } = openCaption();

    fireEvent.compositionStart(field);
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 });

    expect(within(element(editor)).queryByTestId('doc-media-caption-input')).not.toBeNull();
  });

  it.each(['Enter', 'Escape'])('hands the keyboard to the body before the field goes on %s', (key) => {
    const { editor, field } = openCaption();
    const view = editor.prosemirrorView!;
    // The body takes the keyboard while the field is still on the page, so
    // the field's going is not read as the reader leaving the body.
    let fieldWhenBodyFocused: boolean | null = null;
    view.dom.addEventListener('focus', () => {
      fieldWhenBodyFocused = field.isConnected;
    });

    fireEvent.keyDown(field, { key });

    expect(fieldWhenBodyFocused).toBe(true);
    expect(document.activeElement).toBe(view.dom);
    expect(view.state.selection).toBeInstanceOf(NodeSelection);
  });

  it('closes on an Enter pressed after the composition is over', async () => {
    const { editor, field } = openCaption();
    fireEvent.compositionStart(field);
    fireEvent.compositionEnd(field);
    await new Promise((done) => setTimeout(done, 0));

    fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 });

    expect(within(element(editor)).queryByTestId('doc-media-caption-input')).toBeNull();
  });

  it('stays open when the window itself loses the focus', () => {
    const { editor, field } = openCaption();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    fireEvent.blur(field);

    expect(within(element(editor)).queryByTestId('doc-media-caption-input')).not.toBeNull();
    vi.restoreAllMocks();
  });

  it('hands the keyboard to the body when the block is deleted with the field open', () => {
    const { editor } = openCaption();

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-delete'));

    expect(document.activeElement).toBe(editor.prosemirrorView!.dom);
  });
});

describe('the full-screen picture and where the keyboard was', () => {
  it('hands the keyboard back to the box that held it when the picture opened', async () => {
    const editor = open('image', { previewWidth: 200 });
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    act(() => {
      elsewhere.focus();
    });

    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-fullscreen'));
    const picture = await screen.findByTestId('doc-media-fullscreen-image');
    fireEvent.keyDown(picture, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-media-fullscreen-image')).toBeNull();
    });

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe('the drags a media block lets through', () => {
  /**
   * Sends a dragstart from inside the block.
   * @param target - Where it starts.
   * @returns Whether it was refused.
   */
  function refused(target: Element): boolean {
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: [], getData: () => '', setData: vi.fn(), clearData: vi.fn(), setDragImage: vi.fn(), effectAllowed: 'all' },
    });
    Object.defineProperty(event, 'clientY', { value: 0 });
    act(() => {
      target.dispatchEvent(event);
    });
    return event.defaultPrevented;
  }

  it('refuses one from the empty part of the row, or from the shown caption', async () => {
    const editor = open('image', { previewWidth: 200, caption: 'A note' });
    const { SideMenuExtension } = await import('@blocknote/core/extensions');
    vi.spyOn(editor.getExtension(SideMenuExtension)!, 'blockDragStart').mockImplementation(() => undefined);

    expect(refused(element(editor))).toBe(true);
    expect(refused(within(element(editor)).getByTestId('doc-media-caption'))).toBe(true);
  });

  it('lets the media move its row, and the caption field drag its own words', async () => {
    const editor = open('image', { previewWidth: 200 });
    const { SideMenuExtension } = await import('@blocknote/core/extensions');
    const menu = editor.getExtension(SideMenuExtension)!;
    vi.spyOn(menu, 'blockDragStart').mockImplementation(() => undefined);
    vi.spyOn(menu, 'blockDragEnd').mockImplementation(() => undefined);

    expect(refused(element(editor).querySelector('img')!)).toBe(false);
    fireEvent.dragEnd(within(element(editor)).getByTestId('doc-media-frame'));

    selectMedia(editor);
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    expect(refused(within(element(editor)).getByTestId('doc-media-caption-input'))).toBe(false);
  });
});
