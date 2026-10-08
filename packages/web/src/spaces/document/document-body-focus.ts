// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether the body holds the focus (inner#1127 A20, A21; design 3.5.1).
 *
 * One state decides whether what is selected in the body is drawn: the caret,
 * a text highlight, a cell selection, a whole selected block. It holds while
 * the focus is in an element of this body — the editable element, the area
 * around it, or a layer the body draws — and lets go when the focus goes
 * anywhere else. The window going to the background is not leaving: coming
 * back, the body is as it was. Letting go never moves the selection; the
 * selection is only not drawn, and anything that reads it as "what the reader
 * has selected" reads {@link readerSelection}.
 *
 * Only an editable body has this state. A read-only body cannot take the
 * focus and draws its selection the browser's way.
 */

import { createExtension } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Selection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { keyedStore } from '@web/lib/keyed-store';
import { placeOnBlock } from '@web/spaces/document/document-block-place';

/** The attribute on the area around the editable element. */
export const BODY_PART = 'data-document-body-part';
/** The attribute on the root of every layer the body draws. */
export const BODY_LAYER = 'data-document-body-layer';
/** Where a layer belongs in the document, read when the focus enters it. */
export const BODY_ANCHOR = 'data-document-body-anchor';
/** The attribute the editable element carries while the body holds the focus. */
export const BODY_HOLDS = 'data-body-holds';

/** Where a layer belongs: a block, or a range of the document. */
export type LayerAnchor = { readonly block: string } | { readonly from: number; readonly to: number };

/** What the page outside the editor reads about the body's focus. */
export interface BodyFocus {
  /** Whether the body holds the focus. */
  readonly holds: boolean;
  /** The element the focus is in, as the last focus event named it. */
  readonly focused: Element | null;
}

/** The body's focus per editor, for the parts drawn outside the editor. */
export const bodyFocusStore = keyedStore<object, BodyFocus>(
  () => ({ holds: false, focused: null }),
  (a, b) => a.holds === b.holds && a.focused === b.focused,
);

/** The plugin's state. */
interface FocusState {
  readonly holds: boolean;
  readonly readOnly: boolean;
}

const KEY = new PluginKey<FocusState>('documentBodyFocus');

/** The spec key of the decoration that tells a selected block the body holds. */
const HELD = 'documentBodyHolds';

/** One identity per editor, the value both marks carry. */
const ids = new WeakMap<object, string>();
/** The editor each view belongs to, so either names the same body. */
const editorOfView = new WeakMap<object, object>();
let nextId = 0;

/**
 * The identity a body's marks carry.
 * @param body - The editor, or its view.
 * @returns Its identity.
 */
function idOf(body: object): string {
  const key = editorOfView.get(body) ?? body;
  let id = ids.get(key);
  if (id === undefined) {
    nextId += 1;
    id = `body-${nextId}`;
    ids.set(key, id);
  }
  return id;
}

/**
 * The attributes the area around the editable element carries.
 * @param body - The editor, or its view.
 * @returns The attributes.
 */
export function bodyPartMark(body: object): Record<string, string> {
  return { [BODY_PART]: idOf(body) };
}

/**
 * The attributes the root of a body layer carries. Every layer the body draws
 * is stamped here, with the place it belongs: the focus entering it from a
 * body that does not hold puts the selection there first.
 * @param body - The editor, or its view.
 * @param anchor - Where the layer belongs.
 * @returns The attributes.
 */
export function bodyLayerMark(body: object, anchor: LayerAnchor): Record<string, string> {
  const where = 'block' in anchor ? `block:${anchor.block}` : `range:${anchor.from}:${anchor.to}`;
  return { [BODY_LAYER]: idOf(body), [BODY_ANCHOR]: where };
}

/** A layer something opened, with what opened it. */
interface OpenedLayer {
  readonly layer: Element;
  readonly opener: Element;
}

/**
 * The nearest layer around an element that something opened, read off the
 * opener's `aria-controls`.
 * @param element - An element.
 * @returns The layer and its opener, or null when no element names a layer around it.
 */
function openedAround(element: Element): OpenedLayer | null {
  for (let layer = element.closest('[id]'); layer !== null; layer = layer.parentElement?.closest('[id]') ?? null) {
    // Radix ids carry colons, which a quoted attribute value takes as they are.
    const opener = element.ownerDocument.querySelector(`[aria-controls~="${layer.id}"]`);
    if (opener !== null) return { layer, opener };
  }
  return null;
}

/**
 * What opened the layer an element is in.
 * @param element - An element.
 * @returns The opener, or null.
 */
function openerOf(element: Element): Element | null {
  return openedAround(element)?.opener ?? null;
}

/**
 * The body layer an element is in, directly or through the layers opened from it.
 * @param view - The view.
 * @param element - The element.
 * @returns The layer's root, or null.
 */
export function layerOf(view: EditorView, element: Element | null): Element | null {
  const id = idOf(view);
  const seen = new Set<Element>();
  for (let at = element; at !== null && !seen.has(at); at = openerOf(at)) {
    seen.add(at);
    const layer = at.closest(`[${BODY_LAYER}="${id}"]`);
    if (layer !== null) return layer;
  }
  return null;
}

/**
 * Whether an element is part of this body, directly or through the layers it opened.
 * @param view - The view.
 * @param target - The element.
 * @returns True when it belongs to the body.
 */
export function belongsToBody(view: EditorView, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const id = idOf(view);
  const seen = new Set<Element>();
  for (let at: Element | null = target; at !== null && !seen.has(at); at = openerOf(at)) {
    seen.add(at);
    if (view.dom.contains(at)) return true;
    if (at.closest(`[${BODY_PART}="${id}"], [${BODY_LAYER}="${id}"]`) !== null) return true;
  }
  return false;
}

/**
 * Whether the body holds the focus.
 * @param state - The editor's state.
 * @returns True while it holds.
 */
export function bodyHolds(state: EditorState): boolean {
  return KEY.getState(state)?.holds ?? false;
}

/**
 * What the reader has selected: the editor's selection while the body holds
 * the focus (or the body is read-only), nothing otherwise.
 * @param state - The editor's state.
 * @returns The selection, or null.
 */
export function readerSelection(state: EditorState): Selection | null {
  const focus = KEY.getState(state);
  return focus === undefined || focus.holds || focus.readOnly ? state.selection : null;
}

/**
 * Whether a selected block's decorations say it is drawn as selected.
 * @param decorations - The decorations ProseMirror hands the block's view.
 * @returns True while the body holds the focus (or is read-only).
 */
export function drawnSelected(decorations: readonly Decoration[]): boolean {
  return decorations.some((decoration) => (decoration.spec as Record<string, unknown>)[HELD] === true);
}

/**
 * The selection a layer's anchor stands for.
 * @param state - The editor's state.
 * @param anchor - The anchor, as its root carries it.
 * @returns The selection, or null when the anchor names nothing in the document.
 */
function selectionAt(state: EditorState, anchor: string): Selection | null {
  if (anchor.startsWith('block:')) return placeOnBlock(state, anchor.slice('block:'.length));
  const [, , to] = anchor.split(':');
  const end = Number(to);
  if (!Number.isInteger(end) || end < 0 || end > state.doc.content.size) return null;
  return TextSelection.near(state.doc.resolve(end));
}

/**
 * Puts the selection where the layer an element is in belongs, and clears the
 * page selection, which ProseMirror does not rewrite while the focus is
 * outside the editable element: left there, the old range would be
 * highlighted again once the body holds.
 * @param view - The view.
 * @param element - An element in a body layer.
 * @returns True when a selection was put.
 */
export function placeAtLayerAnchor(view: EditorView, element: Element): boolean {
  const anchor = layerOf(view, element)?.getAttribute(BODY_ANCHOR);
  if (anchor === null || anchor === undefined) return false;
  const selection = selectionAt(view.state, anchor);
  if (selection === null) return false;
  if (!view.state.selection.eq(selection)) {
    view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
  }
  view.dom.ownerDocument.getSelection()?.removeAllRanges();
  return true;
}

/**
 * The decoration that tells a selected block to draw itself selected.
 * @param state - The state.
 * @returns The decorations.
 */
function heldDecorations(state: EditorState): DecorationSet | null {
  const focus = KEY.getState(state);
  const { selection } = state;
  if (focus === undefined || !(focus.holds || focus.readOnly) || !(selection instanceof NodeSelection)) return null;
  return DecorationSet.create(state.doc, [Decoration.node(selection.from, selection.to, {}, { [HELD]: true })]);
}

/**
 * Writes whether the body holds the focus.
 * @param view - The view.
 * @param holds - Whether it holds.
 */
function writeHolds(view: EditorView, holds: boolean): void {
  const now = KEY.getState(view.state);
  if (now === undefined || (now.holds === holds && now.readOnly === !view.editable)) return;
  view.dispatch(view.state.tr.setMeta(KEY, { holds, readOnly: !view.editable }).setMeta('addToHistory', false));
}

/**
 * Decides whether the body holds, from the element the focus is in.
 * @param view - The view.
 * @param focused - The element, or null.
 */
export function judgeFocus(view: EditorView, focused: Element | null): void {
  if (view.isDestroyed) return;
  const holds = view.editable && belongsToBody(view, focused);
  const before = KEY.getState(view.state)?.holds ?? false;
  if (holds && !before && focused !== null && !view.dom.contains(focused)) placeAtLayerAnchor(view, focused);
  writeHolds(view, holds);
}

/**
 * Lets go, as the body's Space is hidden: its layers stay on the page, so
 * nothing waits for them to leave.
 * @param view - The view.
 */
export function releaseBodyFocus(view: EditorView): void {
  if (!view.isDestroyed) writeHolds(view, false);
}

/**
 * Decides again from where the focus is now: on mount, when the Space is
 * shown again, and when the body turns editable.
 * @param view - The view.
 */
export function recomputeBodyFocus(view: EditorView): void {
  const page = view.dom.ownerDocument;
  judgeFocus(view, page.activeElement === page.body ? null : page.activeElement);
}

/** The body scroller of each view and where it stood before its last scroll. */
const scrollers = new WeakMap<EditorView, { readonly scroller: HTMLElement; top: number }>();

/**
 * Keeps where the body scroller stands, for a Tab back into the body to
 * restore: Chrome resets a caret it finds outside the editable element and
 * scrolls it into view before any focus handler runs.
 * @param view - The view.
 * @param scroller - The body scroller.
 * @returns The function that stops it.
 */
export function watchBodyScroll(view: EditorView, scroller: HTMLElement): () => void {
  const record = { scroller, top: scroller.scrollTop };
  scrollers.set(view, record);
  /** Notes the position the scroller has come to. */
  const onScroll = (): void => {
    record.top = scroller.scrollTop;
  };
  scroller.addEventListener('scroll', onScroll);
  return () => {
    scroller.removeEventListener('scroll', onScroll);
    if (scrollers.get(view) === record) scrollers.delete(view);
  };
}

/**
 * Puts the editor's selection back on the page when the focus came into the
 * editable element and the page's selection is somewhere else, and puts the
 * scroller back where it stood.
 * @param view - The view.
 */
function restoreOnReturn(view: EditorView): void {
  const page = view.dom.ownerDocument.getSelection();
  const anchor = page?.anchorNode ?? null;
  if (anchor !== null && view.dom.contains(anchor)) return;
  const record = scrollers.get(view);
  const top = record?.top;
  view.focus();
  if (record !== undefined && top !== undefined && record.scroller.scrollTop !== top) {
    record.scroller.scrollTop = top;
  }
}

/** Events that act on the selection, refused while the body does not hold. */
const SELECTION_ACTIONS = ['copy', 'cut', 'paste', 'beforeinput'] as const;

/**
 * The extension that keeps whether the body holds the focus.
 * @returns The extension, for the assembly to register.
 */
export const documentBodyFocusExtension = createExtension(({ editor }) => {
  /**
   * Refuses an action on a selection the body does not hold.
   * @param view - The view.
   * @param event - The event.
   * @returns True when refused.
   */
  const refuse = (view: EditorView, event: Event): boolean => {
    if (!view.editable || bodyHolds(view.state)) return false;
    event.preventDefault();
    return true;
  };
  return {
    key: 'document-body-focus',
    prosemirrorPlugins: [
      new Plugin<FocusState>({
        key: KEY,
        state: {
          init: () => ({ holds: false, readOnly: false }),
          apply: (tr, value) => {
            const meta: unknown = tr.getMeta(KEY);
            return meta === undefined ? value : (meta as FocusState);
          },
        },
        props: {
          decorations: heldDecorations,
          attributes: (state): Record<string, string> => (bodyHolds(state) ? { [BODY_HOLDS]: '' } : {}),
          handleDOMEvents: Object.fromEntries(SELECTION_ACTIONS.map((type) => [type, refuse])),
        },
        view: (view) => {
          editorOfView.set(view, editor);
          const page = view.dom.ownerDocument;
          let focused: Element | null = null;
          let later: ReturnType<typeof setTimeout> | undefined;
          let leaving: MutationObserver | undefined;
          let editable = view.editable;
          /** Publishes the state for the page. */
          const publish = (): void => {
            bodyFocusStore.set(editor, { holds: bodyHolds(view.state), focused });
          };
          /** Decides by where the focus is once the tasks already queued have run. */
          const decideSoon = (): void => {
            clearTimeout(later);
            later = setTimeout(() => {
              later = setTimeout(() => {
                if (view.isDestroyed || !page.hasFocus()) return;
                focused = page.activeElement === page.body ? null : page.activeElement;
                judgeFocus(view, focused);
                publish();
              }, 0);
            }, 0);
          };
          /**
           * The focus landed somewhere on the page.
           * @param event - The focusin.
           */
          const onFocusIn = (event: FocusEvent): void => {
            clearTimeout(later);
            leaving?.disconnect();
            leaving = undefined;
            focused = event.target instanceof Element ? event.target : null;
            if (focused === view.dom && view.editable) restoreOnReturn(view);
            judgeFocus(view, focused);
            publish();
          };
          /**
           * The focus left an element; with nowhere named, it fell to nothing.
           * @param event - The focusout.
           */
          const onFocusOut = (event: FocusEvent): void => {
            // The window itself went to the background: the body is as it was.
            if (!page.hasFocus()) return;
            if (event.relatedTarget !== null) return;
            leaving?.disconnect();
            leaving = undefined;
            const target = event.target instanceof Element ? event.target : null;
            const layer = target === null ? null : layerOf(view, target) ?? openedAround(target)?.layer ?? null;
            // A layer closing hands the keyboard back as it leaves the page,
            // after any exit it plays: decided once it is gone.
            if (layer === null || !layer.isConnected || view.dom.contains(layer)) {
              decideSoon();
              return;
            }
            leaving = new MutationObserver(() => {
              if (layer.isConnected) return;
              leaving?.disconnect();
              leaving = undefined;
              decideSoon();
            });
            leaving.observe(page.body, { childList: true, subtree: true });
          };
          page.addEventListener('focusin', onFocusIn, true);
          page.addEventListener('focusout', onFocusOut, true);
          // The first decision is the mount's (`DocumentEditor` recomputes as
          // it attaches the scroller): ProseMirror builds plugin views again
          // when the plugins change, and a decision taken then would land in
          // the middle of a focus handover.
          publish();
          return {
            update: () => {
              if (view.editable !== editable) {
                editable = view.editable;
                recomputeBodyFocus(view);
              }
              publish();
            },
            destroy: () => {
              clearTimeout(later);
              leaving?.disconnect();
              page.removeEventListener('focusin', onFocusIn, true);
              page.removeEventListener('focusout', onFocusOut, true);
            },
          };
        },
      }),
    ],
  };
});
