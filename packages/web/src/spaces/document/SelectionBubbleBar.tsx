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
 * - **Whether to show at all.** The stock `shouldShow` asks only about focus
 *   and emptiness (`:62-77`). A select-all with the pointer outside the body
 *   has nowhere to put the bar, and a position nobody asked for is worse than
 *   no bar, so ours adds that condition.
 * - **Putting the bar up on a scroll.** The plugin's scroll path only calls
 *   `updatePosition`, which returns immediately while the bar is down
 *   (`:300-302`), so a bar withheld for want of a pointer would never appear
 *   however far the reader scrolls. Our own scroll handler wakes it.
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
 * The box of the line holding a position.
 *
 * `coordsAtPos` answers a line box for a position inside a text block, but a
 * BLOCK BOUNDARY — the document's end, the seam between two blocks — sits
 * inside no line, and there it answers a zero-height separator instead: the
 * block branch returns `flattenH(...)`, which collapses top onto bottom
 * (`prosemirror-view@1.42.2/dist/index.js:618`).
 *
 * This used to walk such a boundary into the nearest text position before
 * measuring, because an `AllSelection`'s head lands on one — `Mod-a` puts it at
 * `doc.content.size` — and measuring the separator took the gap from the last
 * paragraph's BOTTOM edge rather than its line's top, putting the bar 17px into
 * that paragraph's text. A select-all no longer reaches this function at all
 * (it anchors to the pointer), and the walk has no effect anywhere else: the
 * ends of a `TextSelection` are inside text, so the first reading already
 * answers a line; and beside an atom block `Selection.near` hands back a
 * `NodeSelection` whose head is the position it was given — measured on a
 * document ending in an `unsupportedBlock`, both ends walked to the same
 * position they started from.
 * @param view - The editor view to measure against.
 * @param pos - A document position.
 * @returns The line's extent, in viewport coordinates.
 */
function lineAt(view: EditorView, pos: number): { top: number; bottom: number } {
  return view.coordsAtPos(pos);
}

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
 * Asking the editor where a position sits always yields a single line,
 * whatever the range happens to span.
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
  const headLine = lineAt(view, head);
  if (headLine.bottom > bounds.top && headLine.top < bounds.bottom) {
    return headLine;
  }
  return lineAt(view, from);
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

  // On `document`, not on the editor: the question this feeds is whether the
  // pointer is INSIDE the body area, so the moment it leaves has to be seen
  // too. Listening on the body would freeze the last reading at whatever it
  // was on the way out and the test would answer "inside" forever.
  //
  // `wheel` as well as `mousemove` because a wheel gesture moves the text
  // under a still pointer: the pointer's own coordinates are unchanged but the
  // event carries them, and it is the only pointer-bearing event a scroll
  // produces — `scroll` itself is a plain `Event` with no coordinates at all.
  React.useEffect(() => {
    /**
     * Keep the pointer's latest viewport coordinates.
     * @param event - A pointer-bearing event.
     */
    const remember = (event: MouseEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    // Leaving the document is the one thing the two events above cannot say.
    // Without it the last coordinate stands forever, and a keyboard select-all
    // made while the pointer sits in another application would put the bar
    // where the pointer used to be. Only ever reached before the bar is up: a
    // bar already placed reads its pin, not this.
    /** Forget the pointer's coordinates once it leaves the document. */
    const forget = (): void => {
      pointerRef.current = null;
    };
    document.addEventListener('mousemove', remember);
    document.addEventListener('wheel', remember);
    document.addEventListener('mouseleave', forget);
    return () => {
      document.removeEventListener('mousemove', remember);
      document.removeEventListener('wheel', remember);
      document.removeEventListener('mouseleave', forget);
    };
  }, []);

  // Dropping the pin is its own subscription, not a line inside the getter
  // below. Every caller of that getter returns early on an empty selection —
  // `shouldShow` and `getReferencedVirtualElement` both check emptiness first,
  // and the scroll handler leaves as soon as a pin exists — so clearing from
  // inside it never ran on the one transition that has to clear it: selecting
  // all, clicking the selection away, then selecting all again. Measured in a
  // browser: the bar came back at the previous pin's coordinates with the
  // pointer outside the body entirely.
  //
  // On `transaction` rather than on a React render because a co-editor's change
  // arrives with no render behind it.
  /**
   * Whether a viewport coordinate falls inside a box.
   * @param point - A viewport coordinate.
   * @param point.x - Its horizontal position.
   * @param point.y - Its vertical position.
   * @param box - The box to test against.
   * @returns True when the point is within the box.
   */
  const isInside = (point: { x: number; y: number }, box: DOMRect): boolean =>
    point.x >= box.left
    && point.x <= box.right
    && point.y >= box.top
    && point.y <= box.bottom;

  /**
   * Where the bar sits over a select-all, or null when it stays away.
   *
   * READ ONLY — it never pins. Pinning happens at the two moments the rule
   * names, and nowhere else: when the selection becomes a select-all, and on
   * a scroll. Keeping the two apart is what makes "the pointer is only read at
   * those two moments" true; when this doubled as the act of pinning, the
   * plugin's own 250ms update debounce decided the moment instead, and a
   * pointer moved within that window was taken as the answer.
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
    if (area.width === pin.area.width && area.height === pin.area.height) {
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

  const wasSelectAllRef = React.useRef(false);
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
      const isSelectAll = editor.state.selection instanceof AllSelection;
      if (isSelectAll && !wasSelectAllRef.current) pinToPointer();
      if (!isSelectAll) pinnedRef.current = null;
      wasSelectAllRef.current = isSelectAll;
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
   * Takes the view rather than reading it off the editor: the plugin asks this
   * during teardown too, and by then `editor.view` throws.
   * @param view - The editor view the caller already holds.
   * @returns True when a bar is warranted at all.
   */
  const isWarranted = React.useCallback((view: EditorView): boolean => {
    const { doc, selection } = view.state;
    if (selection.empty || !editor.isEditable) return false;
    if (!doc.textBetween(selection.from, selection.to).length) return false;
    const inBar = barRef.current?.contains(document.activeElement) ?? false;
    return view.hasFocus() || inBar;
  }, [editor]);

  const shouldShow = React.useCallback(({ view }: { view: EditorView }): boolean => {
    if (!isWarranted(view)) return false;
    // Read only. The pin was set on the transaction that made this a
    // select-all, or by a scroll; this question never pins.
    if (editor.state.selection instanceof AllSelection) {
      return pinnedPoint() !== null;
    }
    return true;
  }, [editor, isWarranted, pinnedPoint]);

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

  // Ours rather than the wrapper's auto-generated one, because the scroll
  // handler below has to address this plugin by key to wake it.
  const pluginKey = React.useMemo(() => new PluginKey('selectionBubbleBar'), []);

  // The second of the two select-all rules: a scroll leaves a shown bar alone,
  // and only when there is none does it ask where the pointer is.
  //
  // It has to be us who asks. The plugin's own scroll handler only calls
  // `updatePosition` (`dist/index.js:89-96`), whose first line is
  // `if (!this.isVisible) return` (`:300-302`) — a bar that is not up stays
  // down however far the reader scrolls. Waking it takes two metas rather than
  // one: `'show'` runs `updatePosition()` BEFORE `show()` (`:157-160`), so on
  // its own it would put the bar back at whatever position it last computed.
  React.useEffect(() => {
    /** Put the bar up if this scroll is the moment it becomes placeable. */
    const onScroll = (): void => {
      if (pinnedRef.current) return;
      const { view } = editor;
      if (!isWarranted(view)) return;
      if (!pinToPointer()) return;
      view.dispatch(view.state.tr.setMeta(pluginKey, 'show'));
      view.dispatch(view.state.tr.setMeta(pluginKey, 'updatePosition'));
    };
    viewport.addEventListener('scroll', onScroll);
    return () => {
      viewport.removeEventListener('scroll', onScroll);
    };
  }, [editor, viewport, isWarranted, pinToPointer, pluginKey]);

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
