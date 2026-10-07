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

import { documentBodyFragment } from '@breatic/shared';

const download = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock('@web/lib/download', () => ({ triggerDownload: download.trigger }));

const { buildDocumentEditor } = await import('@web/spaces/document/build-document-editor');
const { DocumentMediaViews } = await import('@web/spaces/document/DocumentMediaViews');
const { TooltipProvider } = await import('@web/components/ui/tooltip');

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
const roots: HTMLElement[] = [];

beforeEach(() => {
  download.trigger.mockReset();
});

afterEach(() => {
  // React takes its own portals down first; only then the editors go.
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  roots.splice(0).forEach((root) => {
    root.remove();
  });
  document.body.removeAttribute('data-radix-scroll-area-viewport');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
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

    fireEvent.pointerEnter(within(element(editor)).getByTestId('doc-media-box'));

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

    fireEvent.pointerEnter(within(element(editor)).getByTestId('doc-media-box'));

    expect(toolbar(editor).getAttribute('data-side')).toBe('inside');
  });
});

/**
 * Node-selects the media block, the way a click on it does.
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
  });
}

describe('a caption written through an input method (A16)', () => {
  it('is kept when the block is selected while the words are composed', () => {
    const editor = open('image');
    selectMedia(editor);
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-caption-button'));
    const input = within(element(editor)).getByTestId('doc-media-caption-input');

    fireEvent.compositionStart(input, { data: '' });
    fireEvent.change(input, { target: { value: '说明' } });
    fireEvent.compositionEnd(input, { data: '说明' });
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

  it('is drawn while the pointer is on the block, the same way as when selected', () => {
    const editor = open('video');
    const box = within(element(editor)).getByTestId('doc-media-box');
    expect(box.getAttribute('data-hovered')).toBeNull();

    fireEvent.pointerEnter(box);
    expect(box.getAttribute('data-hovered')).toBe('true');

    fireEvent.pointerLeave(box);
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

describe('a press beside a media block', () => {
  it('leaves the press to the browser and answers the click: it selects nothing and puts the caret on the line under it', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    });

    // The press itself goes on: a drag or a shift-press from here is the
    // browser's, as it is anywhere else.
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      element(editor).dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(false);

    // A click there — any button — is answered before the block is picked.
    for (const button of [0, 2]) {
      const click = new MouseEvent('mouseup', { bubbles: true, button });
      Object.defineProperty(click, 'target', { value: element(editor) });
      let answered = false;
      act(() => {
        answered = view.someProp('handleClick', (f) => f(view, 0, click)) === true;
      });
      expect(answered).toBe(true);
      expect(view.state.selection).toBeInstanceOf(TextSelection);
      expect(view.state.selection.$from.parent.textContent).toBe('Below');
    }
  });

  it('leaves a click on the media itself to the editor, which selects it', () => {
    const editor = open('image', { previewWidth: 200 });
    const view = editor.prosemirrorView!;
    const click = new MouseEvent('mouseup', { bubbles: true, button: 0 });
    Object.defineProperty(click, 'target', { value: element(editor).querySelector('img') });

    expect(view.someProp('handleClick', (f) => f(view, 0, click)) === true).toBe(false);
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

  it('lets go of the block when it leaves the body from the caption field', () => {
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

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    outside.remove();
  });

  it('goes back to the body when the full-screen picture closes', async () => {
    const editor = open('image', { previewWidth: 200 });
    selectMedia(editor);
    fireEvent.click(within(toolbar(editor)).getByTestId('doc-media-fullscreen'));
    const picture = await screen.findByTestId('doc-media-fullscreen-image');

    fireEvent.keyDown(picture, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('doc-media-fullscreen-image')).toBeNull();
    });
    expect(document.activeElement).toBe(editor.prosemirrorView!.dom);
  });
});
