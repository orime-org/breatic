// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The bar that floats above a selection.
 *
 * It carries the commands whose object is the current selection or the block
 * it sits in — the same object the top bar acts on, which is why the same six
 * commands legitimately appear in both (menu-system ruling §9.1: one object may
 * have several entry points; what is forbidden is mixing objects inside one
 * carrier). This slice adds no command of its own.
 *
 * ## Six things the stock component does not do for us
 *
 * Read off the installed `@tiptap/extension-bubble-menu@3.29.2`, whose props
 * `@tiptap/react/menus` passes straight through:
 *
 * - **The anchor.** `dist/index.js:261` measures `posToDOMRect(view, from, to)`
 *   — the selection's whole bounding box. Over a `Mod-a` selection that box is
 *   the entire document, so the bar would anchor above the first line even when
 *   that line is scrolled far out of view. `getReferencedVirtualElement` is the
 *   official way out (`dist/index.d.ts:66`) and it wins outright: `:254`
 *   returns it before every other branch. We hand back one line the reader can
 *   see — see {@link pickAnchorPos}.
 * - **The alignment.** The default `placement` is `'top'` (`dist/index.js:48`),
 *   and floating-ui only shifts along the alignment axis when the placement
 *   carries `-start` or `-end` (`@floating-ui/core` `:49-51`); bare `top`
 *   centres. The ruling asks for the bar's left edge on the selection's left
 *   edge, so `'top-start'`.
 * - **Where it lives.** Inside the scroller it gets clipped, so `appendTo`
 *   puts it outside — the use the prop's own doc comment names.
 * - **Scrolling.** That last choice creates a need of its own: the plugin
 *   recomputes on `scrollTarget`'s scroll and nothing else (`:172` defaults it
 *   to `window`, `:188` is the only listener; `:307` is a one-shot
 *   `computePosition` with no `autoUpdate`, and `:121` returns early when
 *   neither selection nor document changed). Our scrolling happens inside the
 *   ScrollArea viewport, whose scroll events do not reach `window`. Left
 *   unset, the bar would sit still while the text moved under it.
 * - **Which box decides "it does not fit".** `flip`'s boundary defaults to the
 *   clipping ancestors (floating-ui `detectOverflow`), which here is the
 *   workspace's `overflow-hidden` layer — its top sits 40px ABOVE the text, so
 *   flip believes there is room where the reader sees none. The box to judge
 *   against is the body's own visible area, which is what Lexical compares to
 *   (`editorScrollerRect.top`). Hence `flip: { boundary }`.
 * - **The gap.** The plugin builds its middleware in the order flip, shift,
 *   offset (`:195-218`), and floating-ui runs them in array order — so flip
 *   decides before the 8px gap exists. floating-ui's own guidance is the
 *   opposite ("offset() should generally be placed at the beginning of your
 *   middleware array") and the plugin takes no custom middleware array, so the
 *   order cannot be fixed from here. The gap therefore lives in the anchor
 *   rectangle instead — see {@link anchorRect} — and no `offset` is passed.
 *
 * ## And one thing it does that we undo
 *
 * `:178` makes the bar itself focusable (`tabIndex = 0`). The ruling (§5.2)
 * keeps the whole bar out of the tab order: the top bar sits BESIDE the body
 * and is always there, while this one floats ON TOP of it, and anything
 * floating over the body that takes focus collides with the body's own focus
 * with no way to reconcile them. The six commands stay reachable from the
 * keyboard through the top bar and their own shortcuts.
 */

import * as React from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { posToDOMRect } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { Selection } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/react/menus';

import {
  ToolButton,
  type ToolDef,
} from '@web/spaces/document/document-tool-button';
import { MARK_TOOLS, BLOCK_TOOLS } from '@web/spaces/document/document-tools';
import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';

/** The commands this carrier shows, in the order the ruling lists them. */
const BUBBLE_TOOLS: ToolDef[] = [...MARK_TOOLS, ...BLOCK_TOOLS];

/** How far from the selection the bar sits, per the ruling's visual spec. */
const GAP_FROM_SELECTION_PX = 8;

/**
 * The box of the line holding a position.
 *
 * `coordsAtPos` answers a line box for a position inside a text block, but a
 * BLOCK BOUNDARY — the document's end, the seam between two blocks — sits
 * inside no line, and there it answers a zero-height separator instead: the
 * block branch returns `flattenH(...)`, which collapses top onto bottom
 * (`prosemirror-view@1.42.2/dist/index.js:618`).
 *
 * An `AllSelection`'s head is exactly such a boundary — pressing `Mod-a` twice
 * puts it at `doc.content.size` — and measuring from there took the gap from
 * the last paragraph's BOTTOM edge rather than its line's top, which put the
 * bar 17px into that paragraph's text and covered the one above it whole
 * (measured in a browser: bar 205–241, last line 224–249).
 *
 * So a boundary is walked into the nearest text position before measuring.
 * Which line to anchor is decided elsewhere and unchanged; this only makes
 * sure the answer is a line at all.
 * @param view - The editor view to measure against.
 * @param pos - A document position.
 * @returns The line's extent, in viewport coordinates.
 */
function lineAt(
  view: EditorView,
  pos: number,
): { top: number; bottom: number } {
  const coords = view.coordsAtPos(pos);
  if (coords.bottom > coords.top) return coords;
  return view.coordsAtPos(Selection.near(view.state.doc.resolve(pos), -1).head);
}

/**
 * The document position the bar sits above.
 *
 * One rule covers both ways a selection gets made, because the head of a
 * selection IS the end the user is moving: dragging with the mouse, the head
 * is where the button came up; extending with the keyboard, it is the edge
 * being pushed. Anchor there whenever the reader can see it, which is always
 * true of a drag — the pointer was on screen when it was released.
 *
 * A `Mod-a` selection is the case that forces the fallback: its head is the
 * end of the document, usually far below the fold. Then the anchor is the top
 * of the selection if that is on screen, and otherwise the position where the
 * selection crosses the top edge — never the selection's own start, which for
 * `Mod-a` is a first line that may be scrolled arbitrarily far away.
 *
 * Positions rather than DOM rectangles, deliberately. `Range.getClientRects()`
 * hands back the BORDER BOX of any element the range wholly contains, so a
 * fully selected paragraph yields one tall rectangle instead of one per line —
 * and `Mod-a` selects whole blocks by definition. Asking the editor where a
 * position sits always yields a single line, whatever the range happens to
 * span.
 * @param view - The editor view to measure against.
 * @param bounds - The visible box of the body's scroll container.
 * @returns A position inside the current selection.
 */
function pickAnchorPos(view: EditorView, bounds: DOMRect): number {
  const { from, to, head } = view.state.selection;
  /**
   * Whether the line holding a position overlaps the visible box at all.
   * @param pos - A document position.
   * @returns True when any part of its line is on screen.
   */
  const isVisible = (pos: number): boolean => {
    const line = lineAt(view, pos);
    return line.bottom > bounds.top && line.top < bounds.bottom;
  };

  // `head` is always inside `[from, to]` — a selection defines them as the min
  // and max of its anchor and head — so the only question is whether it shows.
  if (isVisible(head)) return head;
  if (isVisible(from)) return from;

  // The selection starts above the fold. Ask what sits on the first visible
  // row instead — measured from the editor's own left edge, since the
  // scroller's is out in the gutter where there is no text to hit.
  const editorLeft = view.dom.getBoundingClientRect().left;
  const atTop = view.posAtCoords({ left: editorLeft + 1, top: bounds.top + 1 });
  if (atTop && atTop.pos > from && atTop.pos < to) return atTop.pos;
  return from;
}

/**
 * The box the selection occupies on screen.
 *
 * The live DOM range rather than `posToDOMRect`: that helper takes the min of
 * the two endpoints' x (`@tiptap/core` `dist/index.js:2443`), which over a
 * selection spanning several lines is neither endpoint's line nor the leftmost
 * edge the reader sees — a middle line starting at the block edge is left out
 * of the sample entirely. The range's own bounding box covers every line.
 *
 * The range is in step with the editor's selection whenever the bar is up: the
 * plugin only shows it while the editor holds focus, and the bar itself never
 * takes focus away (see the note at the top of this file).
 * @param view - The editor view, for the fallback measurement.
 * @returns The selection's bounding box in viewport coordinates.
 */
function selectionBox(view: EditorView): DOMRect {
  const selection = view.dom.ownerDocument.defaultView?.getSelection();
  if (selection && selection.rangeCount > 0) {
    return selection.getRangeAt(0).getBoundingClientRect();
  }
  const { from, to } = view.state.selection;
  return posToDOMRect(view, from, to);
}

/**
 * A zero-width rectangle standing in for one line of text, grown by the gap.
 *
 * The gap belongs here rather than in an `offset` middleware because flip runs
 * BEFORE offset in this plugin and would otherwise decide whether the bar fits
 * without knowing the bar needs 8px more than its own height. Growing the
 * anchor says the same thing in a form flip can see, and it says it on both
 * sides at once, so the gap comes out right whichever way the bar ends up.
 *
 * Zero width is not a shortcut: `top-start` reads the left edge and the top,
 * and a right edge would only invite the shift middleware to slide the bar
 * along a box the user never selected.
 * @param left - Left edge of the selection, in viewport coordinates.
 * @param line - The anchored line's vertical extent, in viewport coordinates.
 * @param line.top - Its top edge.
 * @param line.bottom - Its bottom edge.
 * @returns The rectangle.
 */
function anchorRect(left: number, line: { top: number; bottom: number }): DOMRect {
  const top = line.top - GAP_FROM_SELECTION_PX;
  const bottom = line.bottom + GAP_FROM_SELECTION_PX;
  return new DOMRect(left, top, 0, bottom - top);
}

interface SelectionBubbleBarProps {
  /** The editor this bar acts on. */
  editor: Editor;
  /**
   * True for a viewer, and then the bar is not rendered at all.
   *
   * Not "rendered but disabled", which is what the top bar does: that one is
   * always on screen, so a row of dark buttons still tells a reader what this
   * document can do. This one only appears because someone selected text, and
   * a bar whose every button is dead is nothing but noise (ruling §3.3.1).
   */
  readOnly?: boolean;
}

/**
 * The formatting bar that follows the selection.
 *
 * Resolves the body's scroll container and renders nothing until it has it.
 * That is not defensiveness: the plugin reads `options.scrollTarget` when it
 * registers, and the only chance to hand it the right one is before that.
 * Handing it over on a later render does not work either — the React wrapper
 * drops the first update after registration (`skipFirstUpdateRef`,
 * `@tiptap/react/dist/menus/index.js`), and React batches that skipped update
 * with the state change that carries the viewport. Measured: passed late, the
 * plugin's target stayed `window` through mount and selection and only became
 * the viewport once something else re-rendered `DocumentEditor` — which, being
 * memoised on a history object that changes only after the user edits, never
 * happens in a freshly opened document. Waiting one commit costs nothing;
 * there is no selection to float above on the first frame either.
 *
 * Splitting the resolution from the bar is what keeps every branch below live:
 * with the viewport known non-null, nothing downstream has to ask again.
 * @param root0 - Bar props.
 * @param root0.editor - The editor this bar acts on.
 * @param root0.readOnly - True for a viewer; the bar stays away entirely.
 * @returns The bar, or null for a viewer and until the scroller is in hand.
 */
export function SelectionBubbleBar({
  editor,
  readOnly = false,
}: SelectionBubbleBarProps): React.JSX.Element | null {
  const [viewport, setViewport] = React.useState<HTMLElement | null>(null);
  // Looked up from the editor's own element rather than from the document: the
  // body's scroller is the one this editor sits in, and `ScrollArea` puts its
  // children inside the viewport, so walking up from `view.dom` answers that by
  // construction. Asking the document for the first match instead would tie the
  // bar to "at most one body scroller exists", which nothing enforces.
  //
  // In an effect because the element exists one commit after this component
  // first renders, so it cannot be read during that first render.
  React.useEffect(() => {
    setViewport(
      editor.view.dom.closest<HTMLElement>('[data-radix-scroll-area-viewport]'),
    );
  }, [editor]);

  if (readOnly) return null;
  if (!viewport) return null;
  return <BubbleBar editor={editor} viewport={viewport} />;
}

/**
 * The bar itself, once the scroller it lives against is known.
 * @param root0 - Bar props.
 * @param root0.editor - The editor this bar acts on.
 * @param root0.viewport - The body's visible box: what the anchor is judged
 *   against, what flip treats as its boundary, and what scrolling is watched on.
 * @returns The bar.
 */
function BubbleBar({
  editor,
  viewport,
}: {
  editor: Editor;
  viewport: HTMLElement;
}): React.JSX.Element {
  // Walked up from the viewport already in hand rather than looked up again:
  // this is the scroller the bar is judged against, so its parent is the box
  // the bar must hang outside of. A second document-wide lookup would be a
  // second chance to land on a different editor's scroller.
  const appendTo = React.useCallback(
    () =>
      viewport.closest<HTMLElement>(`.${BODY_SCROLLER_CLASS}`)?.parentElement
      ?? document.body,
    [viewport],
  );

  const getReferencedVirtualElement = React.useCallback(() => {
    const { view } = editor;
    if (view.state.selection.empty) return null;
    const line = lineAt(view, pickAnchorPos(view, viewport.getBoundingClientRect()));
    // The two axes come from different places, and they have to. Vertically the
    // bar belongs to ONE line — the anchor. Horizontally the ruling asks for
    // the selection's left edge, which is the left of the box it occupies: the
    // anchor's own x is no such thing (it is usually the head, and a `Mod-a`'s
    // head sits at the END of the last line — measured, taking x from there put
    // the bar 314px right of where the ruling wants it), and neither is
    // `posToDOMRect`, which samples only the two endpoints and so misses the
    // block edge that a middle line starts at.
    const rect = anchorRect(selectionBox(view).left, line);
    return {
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect] as unknown as DOMRectList,
    };
  }, [editor, viewport]);

  const options = React.useMemo(
    () => ({
      placement: 'top-start' as const,
      // Off, not absent: the plugin's own default is `offset: 8`
      // (`dist/index.js:49`) and our options are spread over the defaults, so
      // leaving it out keeps it. The gap is part of the anchor already (see
      // `anchorRect`); letting the middleware add it too would double it.
      offset: false as const,
      flip: { boundary: viewport },
      scrollTarget: viewport,
    }),
    [viewport],
  );

  const barRef = React.useRef<HTMLDivElement | null>(null);
  // The last word on the bar's tab index. The plugin assigns `tabIndex = 0` in
  // its constructor (`dist/index.js:178`), which the React wrapper runs in a
  // passive effect — after the layout effect that writes our props
  // (`@tiptap/react/dist/menus/index.js:275`), so passing `tabIndex` as a prop
  // loses. A parent's effects run after its children's, so this one is last;
  // no dependency array, because the plugin re-registers inside an effect of
  // its own and every such re-registration is followed by this.
  React.useEffect(() => {
    if (barRef.current) barRef.current.tabIndex = -1;
  });

  // Whether there is a selection at all, subscribed rather than read during
  // render — a co-editor's change arrives with no React render behind it. The
  // buttons are built only while it is true: each of them runs its command's
  // dry run on every transaction, and the bar spends almost all of its life
  // hidden, so leaving them mounted doubles that work (six extra dry runs per
  // keystroke) for a carrier nobody can see.
  const hasSelection = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? !e.state.selection.empty : false),
  });

  return (
    <BubbleMenu
      editor={editor}
      appendTo={appendTo}
      getReferencedVirtualElement={getReferencedVirtualElement}
      ref={barRef}
      // No debounce on the scroll recompute. The plugin's default is 60ms and
      // its handler clears the timer on every event (`dist/index.js:37/95`), so
      // through a scrolling gesture the timer never fires — measured, the bar
      // stood still for the whole gesture while the text moved under it, the
      // gap running 8 to -152, and only snapped back once scrolling stopped.
      // Both references do it per event with no debounce: floating-ui's
      // `autoUpdate` (`ancestorScroll`, on by default) and Lexical's floating
      // toolbar, which recomputes straight inside its scroll handler.
      resizeDelay={0}
      options={options}
      data-testid='doc-selection-bubble-bar'
      className='flex items-center gap-0.5 rounded-overlay border border-border bg-popover px-1.5 py-1 shadow-md'
    >
      {hasSelection
        ? BUBBLE_TOOLS.map((tool) => (
          <ToolButton
            key={tool.id}
            tool={tool}
            editor={editor}
            carrier='bubble'
          />
        ))
        : null}
    </BubbleMenu>
  );
}
