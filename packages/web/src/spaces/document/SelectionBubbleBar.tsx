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
 * ## What the stock component does not do for us
 *
 * Read off the installed `@tiptap/extension-bubble-menu@3.29.2`, whose props
 * `@tiptap/react/menus` passes straight through:
 *
 * - **The anchor.** `dist/index.js:261` measures `posToDOMRect(view, from, to)`
 *   — the selection's whole bounding box. Over a `Mod-a` selection that box is
 *   the entire document, so the bar would anchor above the first line even when
 *   that line is scrolled far out of view. `getReferencedVirtualElement` is the
 *   official way out (`dist/index.d.ts:66`) and it wins outright: `:254`
 *   returns it before every other branch. What we hand back depends on the
 *   selection: a select-all anchors to the pointer, anything smaller to one of
 *   its own two ends — see {@link pickAnchorLine}.
 * - **Whether to show at all.** The stock `shouldShow` (`:62-77`) asks four
 *   things: focus somewhere that counts, a non-empty selection, a selection
 *   that is not an empty text block, and an editable editor. A select-all with
 *   the pointer outside the body has nowhere to put the bar, and a position
 *   nobody asked for is worse than no bar, so ours adds that condition — and
 *   restates the four, since passing `shouldShow` replaces the stock one
 *   rather than extending it.
 * - **Raising the bar when a mouse event arrives.** The plugin only
 *   reconsiders on an editor transaction; a mouse event is not one, and
 *   `updatePosition` returns immediately while the bar is down (`:300-302`).
 *   Our own listener wakes it.
 * - **Taking the bar away when its anchor leaves.** Clipping does not do it —
 *   the bar hangs outside the scroller, so the layer that clips it starts 40px
 *   higher and the bar would show in that strip, over the top bar. The `hide`
 *   middleware does, once given the right boundary.
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
import { AllSelection, PluginKey } from '@tiptap/pm/state';
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
 * The line the bar sits against, for a selection that covers part of the body.
 *
 * One rule covers both ways such a selection gets made, because the head of a
 * selection IS the end the user is moving: dragging with the mouse, the head
 * is where the button came up; extending with the keyboard, it is the edge
 * being pushed. Anchor there whenever the reader can see it, which is always
 * true of a drag — the pointer was on screen when it was released. Otherwise
 * anchor the other end.
 *
 * Neither end being on screen is not this function's problem: the `hide`
 * middleware takes the anchor it returns and hides the bar when that anchor
 * has left the body area (see the options below). Hunting for some third line
 * the reader can currently see is exactly what this used to do, and that
 * branch was the common source of the in-scope defects found in five of the
 * six implementation-adversarial rounds. None of Lexical, Slate, ProseMirror's
 * own example, or this plugin does it either.
 *
 * Lines rather than DOM rectangles, deliberately. `Range.getClientRects()`
 * hands back the BORDER BOX of any element the range wholly contains, so a
 * fully selected paragraph yields one tall rectangle instead of one per line.
 * `coordsAtPos` always yields a single line, whatever the range spans.
 *
 * Both ends measured here are inside text, so `coordsAtPos` answers a real
 * line box for them. It answers a zero-height separator instead at a BLOCK
 * BOUNDARY (`prosemirror-view@1.42.2/dist/index.js:618` collapses top onto
 * bottom there), which is what an `AllSelection`'s head sits on — but that
 * selection never reaches this function while the bar is showing: it anchors
 * to its pin, and without a pin the bar is down and no anchor is asked for.
 * @param view - The editor view to measure against.
 * @param bounds - The visible box of the body's scroll container.
 * @returns The anchored line's extent, in viewport coordinates.
 */
function pickAnchorLine(
  view: EditorView,
  bounds: DOMRect,
): { top: number; bottom: number } {
  const { from, head } = view.state.selection;
  // `head` is always inside `[from, to]` — a selection defines them as the min
  // and max of its anchor and head — so the only question is whether it shows.
  const headLine = view.coordsAtPos(head);
  if (headLine.bottom > bounds.top && headLine.top < bounds.bottom) {
    return headLine;
  }
  return view.coordsAtPos(from);
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
 * The range is in step with the editor's selection whenever the bar is up:
 * {@link isWarranted} refuses without `view.hasFocus()`, and the bar refuses
 * the focus change a press on it would cause (see the note further down), so
 * a bar on screen means an editor holding focus, which in turn means a live
 * DOM range that ProseMirror keeps synchronised with its own selection.
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

/**
 * Whether a viewport coordinate falls inside a box.
 * @param point - A viewport coordinate.
 * @param point.x - Its horizontal position.
 * @param point.y - Its vertical position.
 * @param box - The box to test against.
 * @returns True when the point is within the box.
 */
function isInside(point: { x: number; y: number }, box: DOMRect): boolean {
  return (
    point.x >= box.left
    && point.x <= box.right
    && point.y >= box.top
    && point.y <= box.bottom
  );
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
 * registers, and on THIS wiring that is the only chance to hand it the right
 * one. The plugin itself can take it later — `updateOptions` rebinds the scroll
 * listener when the target changes (`dist/index.js:405-409`) — but the update
 * that would carry it never arrives here.
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

  const barRef = React.useRef<HTMLDivElement | null>(null);
  const pointerRef = React.useRef<{ x: number; y: number } | null>(null);
  const pinnedRef = React.useRef<{ x: number; y: number; area: DOMRect } | null>(
    null,
  );

  const pluginKey = React.useMemo(() => new PluginKey('selectionBubbleBar'), []);

  /**
   * Where the bar sits over a select-all, or null when it stays away.
   *
   * It never pins to the POINTER — that happens at the two moments the rule
   * names and nowhere else: when the selection becomes a select-all, and when
   * the pointer crosses into the body area. Keeping the two apart is what
   * makes "the pointer is only read at those two moments" true; when this
   * doubled as the act of pinning, the plugin's own 250ms update debounce
   * decided the moment instead, and a pointer moved inside that window was
   * taken as the answer.
   *
   * It does write one thing: a resize rescales the pin and stores the result,
   * so the ratio is taken against the area the point was last placed in rather
   * than compounding across every resize.
   *
   * A pin survives a resize by moving with the body area rather than by
   * staying at fixed coordinates. Staying put is a rule about SCROLLING (user
   * 2026-08-20); a narrower window is a different event, and there the pin
   * keeps its relative place in the area. Fixed coordinates would either leave
   * the bar outside the area or let the hide middleware take it away for good.
   * @returns The point the bar sits at, or null.
   */
  const pinnedPoint = React.useCallback((): { x: number; y: number } | null => {
    if (!(editor.state.selection instanceof AllSelection)) return null;
    const pin = pinnedRef.current;
    if (!pin) return null;
    const area = viewport.getBoundingClientRect();
    // All four numbers, not just the two sizes: the ratio below reads `left`
    // and `top` as well, so an area that moved without resizing has to be
    // rescaled too or the bar stays behind where the body used to be.
    const unchanged =
      area.left === pin.area.left
      && area.top === pin.area.top
      && area.width === pin.area.width
      && area.height === pin.area.height;
    // The divisor is the OLD area — `pin.area`, the box the point was placed
    // in. It can be degenerate: `isInside` accepts a rectangle collapsed to a
    // single point (`x >= left && x <= right` both hold when they are equal),
    // so a pin can be written against a 0x0 reading. The new area is tested
    // too, because a zero one would be stored back here and become the next
    // call's divisor. Either way the failure is permanent rather than
    // momentary — NaN would go over the only copy of the pinned point, and
    // NaN never equals the next reading either, so every later call would
    // repeat it. With nothing to rescale against, keep what we have.
    const measurable =
      pin.area.width > 0 && pin.area.height > 0
      && area.width > 0 && area.height > 0;
    if (unchanged || !measurable) {
      return { x: pin.x, y: pin.y };
    }
    const moved = {
      x: area.left + ((pin.x - pin.area.left) / pin.area.width) * area.width,
      y: area.top + ((pin.y - pin.area.top) / pin.area.height) * area.height,
    };
    pinnedRef.current = { ...moved, area };
    return moved;
  }, [editor, viewport]);

  /**
   * Pin the bar to the pointer, if there is a pointer inside the body area.
   *
   * Called only at the two moments the rule names. Answers whether there is
   * now a point to sit at, which is the same question `pinnedPoint` answers
   * afterwards.
   * @returns True when the bar has a place to be.
   */
  const pinToPointer = React.useCallback((): boolean => {
    if (!(editor.state.selection instanceof AllSelection)) return false;
    if (pinnedPoint()) return true;
    const pointer = pointerRef.current;
    if (!pointer) return false;
    const area = viewport.getBoundingClientRect();
    if (!isInside(pointer, area)) return false;
    pinnedRef.current = { ...pointer, area };
    return true;
  }, [editor, viewport, pinnedPoint]);

  React.useEffect(() => {
    /**
     * Pin at the moment the selection becomes a select-all, drop it when it
     * stops being one.
     *
     * Both acts ride on the transaction rather than on the question "should
     * the bar show", because that question is asked on the plugin's schedule:
     * 250ms after the fact (its update debounce), and again on every later
     * transaction. Pinning there made the pointer's position 250ms after the
     * select-all the answer, and let a co-editor's keystroke pin a bar the
     * reader never asked for. Dropping there never ran at all on the one
     * transition that needs it, since an empty selection returns earlier.
     */
    const follow = (): void => {
      if (editor.state.selection instanceof AllSelection) {
        // Idempotent, which is what makes the ruling's third line ("once the
        // bar is up, nothing re-decides where it sits") hold on this path:
        // `pinToPointer` returns early when a pin already exists, so a later
        // transaction over the same select-all — a co-editor's keystroke, say
        // — cannot move a bar the reader already has. That early return is the
        // single copy of the guarantee. Asking here as well whether the
        // selection just BECAME a select-all would be a second copy of it, and
        // two copies of one rule drift apart.
        pinToPointer();
        return;
      }
      pinnedRef.current = null;
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [editor, pinToPointer]);

  /**
   * The conditions that hold whichever path is asking.
   *
   * The plugin's own `shouldShow` (`dist/index.js:62-77`) is REPLACED rather
   * than extended when we pass ours, so its conditions live here: focus
   * somewhere that counts, a selection that is not empty, text inside it, and
   * an editable editor. Both the plugin's question and our scroll handler go
   * through this — the scroll handler used to carry its own shorter list and
   * so put the bar up over an editor the reader had already left.
   *
   * The text condition drops the plugin's `isTextSelection` guard on purpose:
   * an `AllSelection` is not a `TextSelection`, so with that guard a
   * select-all over an emptied document showed a bar whose every button was
   * dead. What matters is whether the selection holds text, not its class.
   *
   * The focus condition is the editor's focus and nothing else. It used to
   * also accept focus sitting inside the bar, from the days when the bar was
   * focusable; the bar now refuses the focus change a press would cause (see
   * the note further down), so that branch had no way left to be true.
   *
   * Takes the view rather than reading it off the editor: the plugin asks this
   * during teardown too, and by then `editor.view` throws.
   * @param view - The editor view the caller already holds.
   * @returns True when a bar is warranted at all.
   */
  const isWarranted = React.useCallback((view: EditorView): boolean => {
    const { doc, selection } = view.state;
    if (selection.empty || !editor.isEditable) return false;
    // Focus before text: `textBetween` walks the selection and builds a string
    // as long as it, so over a multi-screen selection it is the expensive one.
    // Everything above and below it answers in constant time.
    if (!view.hasFocus()) return false;
    return doc.textBetween(selection.from, selection.to).length > 0;
  }, [editor]);

  /**
   * Whether a bar belongs on screen right now — the plugin's own question.
   *
   * Read-only: it never pins. A select-all shows exactly when a pin already
   * exists, put there either by the transaction that made the selection a
   * select-all or by a mouse event over the body.
   *
   * The mouse-event path below asks the same thing without coming through
   * here, and it has to: the plugin's `'show'` meta runs `updatePosition()`
   * and `show()` without consulting `shouldShow` at all
   * (`dist/index.js:157-160`; its four metas — `updatePosition`,
   * `updateOptions`, `hide`, `show` — are the whole vocabulary, there is no
   * "reconsider" among them). What that path must not do is state the rule a
   * second time, and it does not: it calls the same {@link isWarranted}, and
   * then `pinToPointer`, whose true answer already means "this is a
   * select-all AND there is now a pin" — the second half of the branch below.
   * @param root0 - What the plugin passes its `shouldShow`.
   * @param root0.view - The editor view.
   * @returns True when the bar belongs on screen.
   */
  const shouldShow = React.useCallback(({ view }: { view: EditorView }): boolean => {
    if (!isWarranted(view)) return false;
    if (view.state.selection instanceof AllSelection) {
      return pinnedPoint() !== null;
    }
    return true;
  }, [isWarranted, pinnedPoint]);

  // The second of the two moments the ruling names: A MOUSE EVENT ARRIVES
  // (user 2026-08-20, restating it — "鼠标移动是一种情况，能侦测到鼠标事件了。
  // 侦测到鼠标事件的时候，就应该去重算一下。你滚滚轮的时候，不也是鼠标事件
  // 嘛"). The first is the transaction that makes the selection a select-all.
  //
  // So the question asked here is not "did the pointer cross a line" but
  // "there is a fresh reading of where the pointer is — does the bar have
  // somewhere to be now?". Both listeners below deliver that reading:
  // `mousemove` when the pointer moves, `wheel` when it does not and the
  // page does. (`scroll` is a plain `Event` and carries no coordinates, which
  // is why the wheel is the one worth listening to.)
  //
  // An earlier version compared this reading with the previous one and only
  // acted on an edge. That was a second copy of the third line of the ruling
  // ("once the bar is up, nothing re-decides where it sits") — a copy the
  // `pinnedRef` exit below already makes true — and it was wrong in its own
  // right: with the pointer standing still and the body area GROWING under it
  // (the window widened), both readings sit inside the new area, no edge is
  // ever computed, and the bar could never appear.
  //
  // On `document` rather than on the viewport: a pointer that walks out of
  // the body has to be seen leaving, or the last coordinate inside would
  // stand as the current one.
  React.useEffect(() => {
    /**
     * Record where the pointer is, and raise the bar if it now has a place.
     * @param event - A mouse event, of any kind that carries coordinates.
     */
    const remember = (event: MouseEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
      // Two field reads before the one measurement. `getBoundingClientRect`
      // makes the browser settle layout, and this handler runs on every mouse
      // event anywhere in the document. A bar already placed does not move,
      // and a selection that is not a select-all has no pin to place —
      // `pinToPointer` refuses on both counts anyway, one forced layout later.
      if (pinnedRef.current) return;
      const { view } = editor;
      if (!(view.state.selection instanceof AllSelection)) return;
      // `isWarranted` before `pinToPointer`, not after: pinning is a write,
      // and a pin made while no bar is warranted would sit there waiting. The
      // reader would then get the bar at a place the pointer passed through
      // while they were typing somewhere else entirely.
      if (!isWarranted(view) || !pinToPointer()) return;
      view.dispatch(view.state.tr.setMeta(pluginKey, 'show'));
      view.dispatch(view.state.tr.setMeta(pluginKey, 'updatePosition'));
    };
    /**
     * Forget the pointer once it leaves the document.
     *
     * Without this the last coordinate stands forever, and a keyboard
     * select-all made while the pointer sits in another application would put
     * the bar where the pointer used to be.
     *
     * `mouseout` with a null `relatedTarget`, not `mouseleave`. Both are
     * about the pointer leaving, and only one of them is promised to us:
     * `mouseleave` does not bubble and its target is an Element (MDN,
     * Element/mouseleave_event: "mouseleave does not bubble and mouseout
     * does"), so nothing in the specification says a listener bound here
     * would run. `mouseout` bubbles, and its `relatedTarget` is "the
     * EventTarget the pointing device entered to" (MDN,
     * MouseEvent/relatedTarget) — null exactly when it entered nothing, which
     * is to say it left the page.
     *
     * Measured in Chrome 2026-08-20 (probe: pointer moved to y = -20 with
     * listeners on document, documentElement and window): `document` received
     * `mouseout` with a null `relatedTarget` AND a `mouseleave` whose target
     * was `#document` — so the `mouseleave` form did work there, as an extra
     * the engine offers rather than one the specification requires. Two
     * moves that stayed inside produced only `mouseout`, each naming the
     * element being entered, which is what keeps the null test honest.
     * @param event - The pointer leaving something.
     */
    const forget = (event: MouseEvent): void => {
      if (event.relatedTarget !== null) return;
      pointerRef.current = null;
    };
    document.addEventListener('mousemove', remember);
    document.addEventListener('wheel', remember);
    document.addEventListener('mouseout', forget);
    return () => {
      document.removeEventListener('mousemove', remember);
      document.removeEventListener('wheel', remember);
      document.removeEventListener('mouseout', forget);
    };
  }, [editor, viewport, isWarranted, pinToPointer, pluginKey]);

  const getReferencedVirtualElement = React.useCallback(() => {
    const { view } = editor;
    if (view.state.selection.empty) return null;
    const pinned = pinnedPoint();
    // A pinned point has no extent, so both edges of the "line" are the same
    // coordinate and `anchorRect` grows it into the gap on either side — the
    // same shape a real line gets, which is what keeps the flip behaviour
    // identical across the two modes.
    //
    // Its x comes from the pointer too, not from the selection's box: over a
    // select-all that box is the whole body column and its left edge says
    // nothing about where the reader is looking.
    const rect = pinned
      ? anchorRect(pinned.x, { top: pinned.y, bottom: pinned.y })
      // The two axes come from different places here, and they have to.
      // Vertically the bar belongs to ONE line — the anchor. Horizontally the
      // ruling asks for the selection's left edge, which is the left of the
      // box it occupies: the anchor's own x is no such thing (it is usually
      // the head, and measured, taking x from there put the bar 314px right of
      // where the ruling wants it), and neither is `posToDOMRect`, which
      // samples only the two endpoints and so misses the block edge that a
      // middle line starts at.
      : anchorRect(
        selectionBox(view).left,
        pickAnchorLine(view, viewport.getBoundingClientRect()),
      );
    return {
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect] as unknown as DOMRectList,
    };
  }, [editor, viewport, pinnedPoint]);

  const options = React.useMemo(
    () => ({
      placement: 'top-start' as const,
      // Off, not absent: the plugin's own default is `offset: 8`
      // (`dist/index.js:49`) and our options are spread over the defaults, so
      // leaving it out keeps it. The gap is part of the anchor already (see
      // `anchorRect`); letting the middleware add it too would double it.
      offset: false as const,
      flip: { boundary: viewport },
      // Already on by default (`:51`), but against the wrong box: every one of
      // these boundaries falls back to the clipping ancestors, and ours is the
      // workspace's `overflow-hidden` layer whose top sits 40px above the text.
      // This one keeps the whole bar inside the body's left and right edges.
      shift: { boundary: viewport },
      // Off by default (`:55`). This is what takes the bar away once its anchor
      // has left the body area: the plugin reads the middleware's verdict and
      // sets `visibility: hidden` (`:316-319`). Clipping alone would not do it
      // — the bar hangs outside the scroller, so the layer that clips it starts
      // 40px higher and the bar would show in that strip, over the top bar.
      hide: { boundary: viewport },
      scrollTarget: viewport,
    }),
    [viewport],
  );
  // The last word on the bar's focusability. The plugin assigns `tabIndex = 0`
  // in its constructor (`dist/index.js:178`), which the React wrapper runs in a
  // passive effect — after the layout effect that writes our props
  // (`@tiptap/react/dist/menus/index.js:275`), so passing `tabIndex` as a prop
  // loses. A parent's effects run after its children's, so this one is last;
  // no dependency array, because the plugin re-registers inside an effect of
  // its own and every such re-registration is followed by this.
  //
  // The attribute is REMOVED, not set to -1. A negative tabindex keeps the
  // element focusable and only takes it out of the tab order, so clicking the
  // bar's padding used to move focus into it. A plain div carries no
  // focusability to take away.
  //
  // That alone was not enough, and the ninth adversarial round caught it:
  // removing the attribute changes where focus LANDS, not whether it LEAVES the
  // body. Measured — after clicking the bar's padding, focus was in neither the
  // editor nor the bar, the body's selection highlight was gone, and the bar
  // was still there. The plugin sets `preventHide` from a capture-phase
  // mousedown on the whole bar (`dist/index.js:78-79` defines the handler,
  // `:182` registers it), and `blurHandler` returns without hiding whenever
  // that flag is up (`:106-108`, which is also its only reset). With no
  // transaction to follow, nothing asks again.
  //
  // So the bar also refuses the focus change outright. Same move as Slate's
  // official hovering-toolbar example, whose comment reads "prevent toolbar
  // from taking focus away from editor"
  // (`site/examples/ts/hovering-toolbar.tsx`). The buttons keep working: their
  // commands run on click, and the editor never lost focus to begin with.
  React.useEffect(() => {
    const bar = barRef.current;
    if (!bar) return undefined;
    bar.removeAttribute('tabindex');
    /**
     * Refuse the focus change a press would otherwise cause.
     * @param event - The press.
     */
    const keepFocusInBody = (event: MouseEvent): void => {
      event.preventDefault();
    };
    bar.addEventListener('mousedown', keepFocusInBody);
    return () => {
      bar.removeEventListener('mousedown', keepFocusInBody);
    };
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
      pluginKey={pluginKey}
      shouldShow={shouldShow}
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
