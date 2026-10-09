// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A20, A21 (inner#1319, inner#1327): whether the body holds the
 * focus, what that changes on screen, and how presses and focus moves around
 * the body are sorted (design 3.5.1, 3.5.2).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import { NodeSelection, TextSelection, type EditorState } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

const { buildDocumentEditor } = await import('@web/spaces/document/build-document-editor');
const { DocumentMediaViews } = await import('@web/spaces/document/DocumentMediaViews');
const { TooltipProvider } = await import('@web/components/ui/tooltip');
const focus = await import('@web/spaces/document/document-body-focus');
const { placeOnBlock } = await import('@web/spaces/document/document-block-place');
const { attachBodyScroller, pressTargetOf } = await import('@web/spaces/document/document-body-press');

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
const roots: HTMLElement[] = [];
const detach: (() => void)[] = [];

afterEach(() => {
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
  vi.restoreAllMocks();
});

/** An editor inside a body scroller, the way `DocumentEditor` lays it out. */
interface Opened {
  editor: Editor;
  scroller: HTMLElement;
}

/**
 * Opens an editor holding the given blocks inside a body scroller.
 * @param blocks - The blocks.
 * @returns The editor and its scroller.
 */
function open(blocks: unknown[]): Opened {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const scroller = document.createElement('div');
  scroller.tabIndex = -1;
  const column = document.createElement('div');
  scroller.appendChild(column);
  document.body.appendChild(scroller);
  roots.push(scroller);
  act(() => {
    editor.mount(column);
  });
  mounted.push(editor);
  render(
    <TooltipProvider>
      <DocumentMediaViews editor={editor} />
    </TooltipProvider>,
  );
  act(() => {
    editor.replaceBlocks(editor.document, blocks as never);
  });
  detach.push(attachBodyScroller(editor.prosemirrorView!, scroller, editor));
  return { editor, scroller };
}

const TEXT = [
  { type: 'paragraph', content: 'Above words' },
  { type: 'paragraph', content: 'Below words' },
];

/**
 * Selects a range of words in the first paragraph and gives the body the focus.
 * @param editor - The editor.
 */
function selectWords(editor: Editor): void {
  const view = editor.prosemirrorView!;
  act(() => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 8)));
    view.focus();
  });
}

/**
 * Presses and releases on an element.
 * @param target - Where.
 * @param init - Which button and keys.
 * @returns The press event.
 */
function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    target.dispatchEvent(press);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...init }));
  });
  return press;
}

/**
 * The id of the block at an index.
 * @param editor - The editor.
 * @param index - Which block.
 * @returns Its id.
 */
function idAt(editor: Editor, index: number): string {
  return (editor.document as { id: string }[])[index]!.id;
}

describe('whether the body holds the focus', () => {
  it('holds while the editable element has the focus, and says so on the element', () => {
    const { editor } = open(TEXT);
    const view = editor.prosemirrorView!;

    selectWords(editor);

    expect(focus.bodyHolds(view.state)).toBe(true);
    expect(view.dom.hasAttribute('data-body-holds')).toBe(true);
  });

  it('lets go when the focus leaves the body, and leaves the selection where it was', () => {
    const { editor } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    act(() => {
      outside.focus();
    });

    expect(focus.bodyHolds(view.state)).toBe(false);
    expect(view.dom.hasAttribute('data-body-holds')).toBe(false);
    expect([view.state.selection.from, view.state.selection.to]).toEqual([3, 8]);
    outside.remove();
  });

  it('puts its own selection back when the focus returns after the page selection left the body', () => {
    const { editor } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    const outside = document.createElement('div');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    const button = document.createElement('button');
    document.body.appendChild(button);
    act(() => {
      button.focus();
      const away = document.createRange();
      away.selectNodeContents(outside);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(away);
      document.dispatchEvent(new Event('selectionchange'));
    });
    // What the browser does as the focus comes back to an editable element
    // whose page selection left it: a caret at its very start.
    const first = view.dom.querySelector('p')!.firstChild as Text;
    const caret = document.createRange();
    caret.setStart(first, 0);

    const writes = vi.spyOn(view, 'focus');

    act(() => {
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(caret);
      view.dom.focus();
    });

    // `view.focus()` is what writes the editor's selection onto the page.
    expect(writes).toHaveBeenCalled();
    expect([view.state.selection.from, view.state.selection.to]).toEqual([3, 8]);
    outside.remove();
    button.remove();
  });

  it('puts its own selection back when the page selection went into a control of the body before it let go', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    // A control a block draws inside the editable element, as a caption
    // field is: the page selection goes there while the body still holds.
    const control = document.createElement('div');
    control.setAttribute('contenteditable', 'false');
    control.textContent = 'caption';
    view.dom.querySelector('p')!.after(control);
    act(() => {
      const inside = document.createRange();
      inside.selectNodeContents(control);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(inside);
      document.dispatchEvent(new Event('selectionchange'));
    });
    act(() => {
      scroller.focus();
    });
    const first = view.dom.querySelector('p')!.firstChild as Text;
    const caret = document.createRange();
    caret.setStart(first, 0);
    const writes = vi.spyOn(view, 'focus');

    act(() => {
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(caret);
      view.dom.focus();
    });

    expect(writes).toHaveBeenCalled();
    control.remove();
  });

  it('leaves the page selection alone when the focus returns and it never left the body', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    act(() => {
      scroller.focus();
    });
    const writes = vi.spyOn(view, 'focus');

    act(() => {
      view.dom.focus();
    });

    expect(focus.bodyHolds(view.state)).toBe(true);
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps holding while the window itself is in the background', () => {
    const { editor } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    act(() => {
      view.dom.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    });

    expect(focus.bodyHolds(view.state)).toBe(true);
  });

  it('has no reader selection while it does not hold', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    expect(focus.readerSelection(view.state)?.from).toBe(3);

    act(() => {
      scroller.focus();
    });

    expect(focus.readerSelection(view.state)).toBeNull();
  });

  it('tells the page each time it changes, for the parts drawn outside the editor', () => {
    const { editor, scroller } = open(TEXT);
    const heard = vi.fn();
    const stop = focus.bodyFocusStore.subscribe(editor, heard);
    selectWords(editor);
    act(() => {
      scroller.focus();
    });
    stop();

    expect(heard).toHaveBeenCalled();
    expect(focus.bodyFocusStore.get(editor).holds).toBe(false);
  });
});

describe('a press on blank space in the body (A20)', () => {
  it('gives the focus to the body scroller and keeps the selection', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);

    const press = click(scroller);

    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(scroller);
    expect(focus.bodyHolds(view.state)).toBe(false);
    expect([view.state.selection.from, view.state.selection.to]).toEqual([3, 8]);
  });

  it('gives up the focus as the right button goes down', () => {
    const { editor, scroller } = open(TEXT);
    selectWords(editor);
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });

    act(() => {
      scroller.dispatchEvent(press);
    });

    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(scroller);
  });

  it('leaves a middle press to the browser', () => {
    const { editor, scroller } = open(TEXT);
    selectWords(editor);
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });

    act(() => {
      scroller.dispatchEvent(press);
    });

    expect(press.defaultPrevented).toBe(false);
  });
});

describe('what a press is on', () => {
  it.each([
    ['the scroller itself', (o: Opened) => o.scroller, 'blank'],
    ['the words of a paragraph', (o: Opened) => o.editor.prosemirrorView!.dom.querySelector('p')!, 'text'],
  ] as const)('reads %s', (_what, pick, kind) => {
    const opened = open(TEXT);
    const target = pick(opened);
    const event = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(event, 'target', { value: target });

    expect(pressTargetOf(opened.editor.prosemirrorView!, event).kind).toBe(kind);
  });

  it('reads a divider as wordless, a media display, a media control, a body layer and a scrollbar', () => {
    const opened = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'divider' },
      { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a.png' } },
    ]);
    const view = opened.editor.prosemirrorView!;
    const at = (target: Element): string => {
      const event = new MouseEvent('mousedown', { bubbles: true });
      Object.defineProperty(event, 'target', { value: target });
      return pressTargetOf(view, event).kind;
    };
    const layer = document.createElement('div');
    Object.entries(focus.bodyLayerMark(view, { block: idAt(opened.editor, 0) })).forEach(([name, value]) => {
      layer.setAttribute(name, value);
    });
    const inLayer = document.createElement('button');
    layer.appendChild(inLayer);
    opened.scroller.appendChild(layer);
    const scrollbar = document.createElement('div');
    scrollbar.setAttribute('data-orientation', 'vertical');
    scrollbar.setAttribute('data-scroll-area-scrollbar', '');
    opened.scroller.appendChild(scrollbar);

    expect(at(view.dom.querySelector('[data-content-type="divider"]')!)).toBe('wordless');
    expect(at(view.dom.querySelector('p')!)).toBe('text');
    expect(at(view.dom.querySelector('img')!)).toBe('media');
    expect(at(within(view.dom as HTMLElement).getByTestId('doc-media-download'))).toBe('control');
    expect(at(inLayer)).toBe('layer');
    expect(at(scrollbar)).toBe('scrollbar');
  });

  it('reads a block this build does not know as wordless', () => {
    const opened = open(TEXT);
    const view = opened.editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.isTextblock) at = pos;
    });
    const fallback = view.state.schema.nodes['unsupportedBlock']!;
    view.dispatch(
      view.state.tr.replaceWith(at, at + view.state.doc.nodeAt(at)!.nodeSize, fallback.create({ originalName: 'x' })),
    );
    const event = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(event, 'target', { value: view.dom.querySelector('[data-unsupported-block]') });

    expect(pressTargetOf(view, event).kind).toBe('wordless');
  });

  it('passes through a press on anything it does not know', () => {
    const opened = open(TEXT);
    const stranger = document.createElement('span');
    document.body.appendChild(stranger);
    const event = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(event, 'target', { value: stranger });

    expect(pressTargetOf(opened.editor.prosemirrorView!, event).kind).toBe('none');
    stranger.remove();
  });
});

describe('where a block puts the selection when one of its controls is entered', () => {
  /**
   * The state of an editor holding the blocks.
   * @param blocks - The blocks.
   * @returns Its state and the editor.
   */
  const stateOf = (blocks: unknown[]): { state: EditorState; editor: Editor } => {
    const { editor } = open(blocks);
    return { state: editor.prosemirrorView!.state, editor };
  };

  it('selects a picture whole', () => {
    const { state, editor } = stateOf([
      { type: 'paragraph', content: 'Above' },
      { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a.png' } },
    ]);

    const placed = placeOnBlock(state, idAt(editor, 1));

    expect(placed).toBeInstanceOf(NodeSelection);
    expect((placed as NodeSelection).node.type.name).toBe('image');
  });

  it('selects a divider whole', () => {
    const { state, editor } = stateOf([{ type: 'paragraph', content: 'Above' }, { type: 'divider' }]);

    const placed = placeOnBlock(state, idAt(editor, 1));

    expect(placed).toBeInstanceOf(NodeSelection);
    expect((placed as NodeSelection).node.type.name).toBe('divider');
  });

  it('puts the caret at the start of a line of text', () => {
    const { state, editor } = stateOf(TEXT);

    const placed = placeOnBlock(state, idAt(editor, 1));

    expect(placed).toBeInstanceOf(TextSelection);
    expect(placed.empty).toBe(true);
    expect(placed.$from.parent.textContent).toBe('Below words');
    expect(placed.$from.parentOffset).toBe(0);
  });
});

describe('the focus going into a body layer from a body that does not hold it', () => {
  it('puts the selection at the layer’s block first, and clears the page selection', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    act(() => {
      scroller.focus();
    });
    const layer = document.createElement('div');
    Object.entries(focus.bodyLayerMark(view, { block: idAt(editor, 1) })).forEach(([name, value]) => {
      layer.setAttribute(name, value);
    });
    const button = document.createElement('button');
    layer.appendChild(button);
    scroller.appendChild(layer);

    act(() => {
      button.focus();
    });

    expect(focus.bodyHolds(view.state)).toBe(true);
    expect(view.state.selection.empty).toBe(true);
    expect(view.state.selection.$from.parent.textContent).toBe('Below words');
  });

  it('takes the old range off the page as it puts the selection, which the editor does not do while the focus is elsewhere', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    const layer = document.createElement('div');
    Object.entries(focus.bodyLayerMark(view, { block: idAt(editor, 1) })).forEach(([name, value]) => {
      layer.setAttribute(name, value);
    });
    const button = document.createElement('button');
    layer.appendChild(button);
    scroller.appendChild(layer);
    const words = view.dom.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(words, 4);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);

    act(() => {
      focus.placeAtLayerAnchor(view, button);
    });

    const anchor = document.getSelection()?.anchorNode ?? null;
    expect(anchor !== null && view.dom.contains(anchor)).toBe(false);
  });

  it('puts the selection at the layer’s block when it is pressed, even with no focus following', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    act(() => {
      scroller.focus();
    });
    const layer = document.createElement('div');
    Object.entries(focus.bodyLayerMark(view, { block: idAt(editor, 1) })).forEach(([name, value]) => {
      layer.setAttribute(name, value);
    });
    const handle = document.createElement('span');
    layer.appendChild(handle);
    scroller.appendChild(layer);

    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(view.state.selection.$from.parent.textContent).toBe('Below words');
  });
});

describe('what acts on a selection the body does not hold', () => {
  it.each(['copy', 'cut', 'paste'])('stops %s', (type) => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    act(() => {
      scroller.focus();
    });
    const event = new Event(type, { bubbles: true, cancelable: true });

    act(() => {
      view.dom.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.textContent).toBe('Above wordsBelow words');
  });

  it('stops the browser’s own undo', () => {
    const { editor, scroller } = open(TEXT);
    const view = editor.prosemirrorView!;
    selectWords(editor);
    act(() => {
      scroller.focus();
    });
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' });

    act(() => {
      view.dom.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});

describe('keys on the body scroller', () => {
  it('undoes in the editor when the scroller itself has the focus', () => {
    const { editor, scroller } = open(TEXT);
    const undo = vi.spyOn(editor, 'undo');
    act(() => {
      scroller.focus();
    });
    const key = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', metaKey: true });

    act(() => {
      scroller.dispatchEvent(key);
    });

    expect(undo).toHaveBeenCalledTimes(1);
    expect(key.defaultPrevented).toBe(true);
  });

  it('leaves a key that comes up from inside alone', () => {
    const { editor, scroller } = open(TEXT);
    const undo = vi.spyOn(editor, 'undo');
    const field = document.createElement('textarea');
    scroller.appendChild(field);
    const key = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', metaKey: true });

    act(() => {
      field.dispatchEvent(key);
    });

    expect(undo).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);
  });
});

describe('a selected media block while the body does not hold the focus (A21)', () => {
  it('draws no frame, no corners and no toolbar', () => {
    const { editor, scroller } = open([
      { type: 'paragraph', content: 'Above' },
      { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a.png', previewWidth: 200 } },
    ]);
    const view = editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') at = pos;
      return at < 0;
    });
    act(() => {
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
      view.focus();
    });
    const block = view.dom.querySelector<HTMLElement>('[data-content-type="image"]')!;
    expect(within(block).getByTestId('doc-media-box').getAttribute('data-selected')).toBe('true');

    act(() => {
      scroller.focus();
    });

    expect(within(block).getByTestId('doc-media-box').getAttribute('data-selected')).toBeNull();
    expect(within(block).getByTestId('doc-media-toolbar').getAttribute('data-shown')).toBeNull();
  });
});
