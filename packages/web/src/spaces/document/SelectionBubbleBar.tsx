// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bar that floats above a selection.
 *
 * It carries the commands whose object is the current selection or the block
 * it sits in. The ruling routes a command by that object (menu-system §9.1:
 * one object may have several entry points; what is forbidden is mixing
 * objects inside one carrier), so the block handle menu will legitimately
 * carry some of these same commands when it arrives. #112 built this carrier
 * with no command of its own; #902 started filling it (underline, inline
 * code), and the slices after it each bring their own.
 *
 * ## How it is positioned
 *
 * By `@floating-ui/react`'s `useFloating`, the same way the link panel is —
 * `strategy: 'absolute'`, mounted inside the body's scroller, recomputed by
 * `autoUpdate`. Four choices in it are ours rather than the library's
 * defaults:
 *
 * - **The anchor.** Not the selection's bounding box: over a `Mod-a` selection
 *   that box is the whole document, and the bar would sit above the first line
 *   however far it has scrolled away. A select-all anchors to the pointer,
 *   anything smaller to one of its own two ends — see {@link pickAnchorLine}.
 * - **The alignment.** `'top-start'`, because floating-ui only aligns to an
 *   edge when the placement carries `-start` or `-end` (`@floating-ui/core`
 *   `:49-51`) and the ruling asks for the bar's left edge on the selection's.
 * - **Which box decides "it does not fit".** The body's own visible area,
 *   named explicitly. `flip`'s default is the clipping ancestors (floating-ui
 *   `detectOverflow`) — measured 2026-08-22 those come out identical to the
 *   viewport on all four edges, because the 40px that used to separate them
 *   was the top bar and it is gone. Naming the box anyway keeps this
 *   independent of which ancestor happens to carry `overflow-hidden`, which is
 *   a detail of the workspace shell rather than of this bar.
 * - **The gap.** Part of the anchor rectangle (see {@link anchorRect}) rather
 *   than an `offset` middleware, so that `flip` decides with the gap already
 *   counted rather than before it exists.
 * - **When the side is decided.** Once, as the bar comes up, and it holds for
 *   as long as the bar stays up (E3, user 2026-08-26). `flip` picks the side
 *   on that first computation and is then left out of the middleware array.
 *
 * Nothing takes the bar away when its anchor scrolls out of the body: it hangs
 * inside the scroller, so the scroller's own overflow clips it, which is what
 * the link panel relies on too.
 *
 * ## The bar takes no focus
 *
 * The ruling (§5.2) keeps the whole bar out of the tab order: it floats ON TOP
 * of the body, and anything floating over the body that takes focus collides
 * with the body's own focus with no way to reconcile them. A plain div carries
 * no focusability to begin with, and a press on it is refused its default so
 * that focus does not move at all. The keyboard route to these eight commands
 * is their shortcuts — `Mod-b` / `Mod-i` / `Mod-Shift-s` / `Mod-u` for the
 * marks, `Mod-e` for inline code, `Mod-Shift-8` / `Mod-Shift-7` /
 * `Mod-Shift-b` for the blocks.
 */

import * as React from 'react';
import type { Editor } from '@tiptap/react';
import { posToDOMRect } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection } from '@tiptap/pm/state';
import {
  FloatingPortal,
  useFloating,
  autoUpdate,
  flip,
  shift,
  type Placement,
  type VirtualElement,
} from '@floating-ui/react';

import { MessageSquareText } from 'lucide-react';

import {
  ToolButton,
  type ToolDef,
} from '@web/spaces/document/document-tool-button';
import {
  BlockTypeSlot,
  AlignSlot,
  ColorSlot,
  AiSlot,
} from '@web/spaces/document/document-bubble-slots';
import {
  ComingTool,
  type ComingToolDef,
} from '@web/spaces/document/document-coming-tool';
import {
  MARK_TOOLS,
  INLINE_TOOLS,
} from '@web/spaces/document/document-tools';
import { DocumentLinkPopover } from '@web/spaces/document/DocumentLinkPopover';
import { Separator } from '@web/components/ui/separator';
import { cn } from '@web/lib/utils';

/** One run of controls, drawn between two separators. */
interface BubbleGroup {
  /** Names the separator drawn before this group. */
  key: string;
  tools: ToolDef[];
  coming: ComingToolDef[];
  /**
   * Controls that open a panel instead of running a command.
   *
   * A `ToolDef` runs one command when pressed; these own a panel and the state
   * that goes with it, which is a different shape and not one the eight
   * commands have any use for.
   */
  panels: React.ComponentType<{
    editor: Editor;
    onPanelOpenChange: (open: boolean) => void;
  }>[];
  /**
   * The slot that opens a menu on hover, for the groups that carry one.
   *
   * Its open state lives on the bar rather than on the slot, so that one is
   * open at a time (§5.3 I-7): the bar hands every slot the id that is open
   * and the setter, each compares.
   */
  slot?: React.ComponentType<{
    editor: Editor;
    container: HTMLElement | null;
    scroller: HTMLElement | null;
    openId: string | null;
    onOpenChange: (id: string, open: boolean) => void;
  }>;
}

/**
 * The controls this carrier shows, grouped the way the demo draws them.
 *
 * Five groups split by four separators, the order the demo's own caption gives
 * (`2026-08-21-editor-command-surface.html:521`): block type | alignment |
 * bold italic strike underline | link inline-code colour comment | AI.
 *
 * Three of the five hold a slot that opens a menu on hover; the three block
 * commands that used to sit flat in the first group now live inside the block
 * type menu, which is where the demo draws them.
 *
 * Comment stands here with no command behind it (its function is task #18), as
 * do alignment, colour, and every AI command — each of those needs schema or a
 * model call that arrives with its own slice. They all carry the treatment
 * `document-coming-tool.tsx` defines (user 2026-08-23: a control that reads as
 * available and answers a click with nothing tells the reader it is broken).
 */
const BUBBLE_GROUPS: BubbleGroup[] = [
  { key: 'blocks', tools: [], coming: [], panels: [], slot: BlockTypeSlot },
  { key: 'align', tools: [], coming: [], panels: [], slot: AlignSlot },
  { key: 'marks', tools: MARK_TOOLS, coming: [], panels: [] },
  {
    key: 'inline',
    tools: INLINE_TOOLS,
    panels: [DocumentLinkPopover],
    slot: ColorSlot,
    coming: [
      {
        id: 'comment',
        labelKey: 'spaces.document.commands.comment',
        Icon: MessageSquareText,
      },
    ],
  },
  { key: 'ai', tools: [], coming: [], panels: [], slot: AiSlot },
];

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
 * fall back to `from`.
 *
 * `from` is the other end only in a FORWARD selection. ProseMirror defines
 * `from`/`to` as the min and max of anchor and head
 * (`prosemirror-state@1.4.4/dist/index.js:41`/`:45`), so dragging upward or
 * extending with Shift+Up gives `head === from` and the fallback re-measures
 * the same line. That is not a gap being papered over: when the anchored line
 * has left the body area the bar is meant to go away, and `hide` takes it —
 * hunting for a third line the reader can currently see is exactly the branch
 * this replaced.
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
 * A `TextSelection`'s two ends are inside text, so `coordsAtPos` answers a
 * real line box for them. It answers a zero-height separator instead at a
 * BLOCK BOUNDARY (`prosemirror-view@1.42.2/dist/index.js:618` collapses top
 * onto bottom there), which is where an `AllSelection`'s head sits.
 *
 * A select-all DOES reach here, contrary to what this said before. It happens
 * inside the plugin's own 250ms update debounce (`dist/index.js:36`): the
 * selection has just become a select-all with the pointer outside the body,
 * so there is no pin, while the bar is still up from the previous selection
 * and `shouldShow` has not been asked again yet. Any `updatePosition` in that
 * window — a scroll, a resize — takes the anchor from here. The reading is a
 * zero-height line at the document's end, and the debounce ends by hiding the
 * bar. So this is a stale anchor for at most 250ms, not a wrong resting
 * place; the walk that used to convert such a boundary into a text position
 * changed nothing that outlived that window, which is why it is gone.
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
  // No user path is known to reach this. Getting here needs the bar to be up
  // (so: focused editor, non-empty selection) while the document reports no
  // range at all — `getSelection()` is typed nullable and a detached document
  // returns null, but nothing in this app detaches one. It is the two calls
  // above having a value the type system does not promise, not a guard
  // against a scenario anyone could name.
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
 * Zero width is not a shortcut: under `top-start` the floating x works out to
 * the reference's own left edge — the width terms cancel
 * (`@floating-ui/core@1.8.0` `computeCoordsFromPlacement`) — so a right edge
 * would change no position. It would change two other things: `flip` compares
 * reference and floating widths when picking which side to try first, and
 * `hide` measures the reference itself, so a wider rectangle would be judged
 * visible for longer. `shift` reads neither — it only clamps the floating
 * element, and its implementation never touches `rects.reference`.
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

/** A pin: the point, plus the body area it was measured in. */
export interface BubblePin {
  x: number;
  y: number;
  area: DOMRect;
}

/**
 * Where a pin sits on screen now, given the body area's current box.
 *
 * Exported because the whole of the remapping rule lives here: a pin made in
 * one area and read in another is rescaled by the ratio between them, and two
 * degenerate cases refuse to divide.
 * @param pin - The pin, or null when nothing is pinned.
 * @param area - The body area's box right now.
 * @returns The screen point, or null when there is no pin.
 */
export function pinnedScreenPoint(
  pin: BubblePin | null,
  area: DOMRect,
): { x: number; y: number } | null {
  if (!pin) return null;
  // All four numbers, not just the two sizes: the ratio below reads `left`
  // and `top` as well, so an area that moved without resizing has to be
  // rescaled too or the bar stays behind where the body used to be.
  const unchanged =
    area.left === pin.area.left
    && area.top === pin.area.top
    && area.width === pin.area.width
    && area.height === pin.area.height;
  // Two operands, two different failures.
  //
  // The divisor is the OLD area — the box the point was placed in. It can be
  // degenerate: `isInside` accepts a rectangle collapsed to a single point,
  // and a pointer can only pass that test by sitting exactly on it, so the
  // numerator is zero too: `0 / 0` is NaN. A pin is never rewritten once made,
  // so that one is permanent.
  //
  // The NEW area is tested for a different reason. A zero there makes the
  // product zero, not NaN, and the bar would sit at the area's own corner for
  // that one frame — the next reading of a real size is correct again, because
  // this always maps from the original point. Momentary, not permanent, and
  // still worth not doing.
  const measurable =
    pin.area.width > 0 && pin.area.height > 0
    && area.width > 0 && area.height > 0;
  if (unchanged || !measurable) return { x: pin.x, y: pin.y };
  return {
    x: area.left + ((pin.x - pin.area.left) / pin.area.width) * area.width,
    y: area.top + ((pin.y - pin.area.top) / pin.area.height) * area.height,
  };
}

/**
 * Where the bar's anchor sits, as one rectangle.
 *
 * Exported because this is the whole anchoring decision in one place: which
 * line the bar hangs against, where its left edge goes, and the gap above it.
 * Tests call it rather than reaching into whatever positions the bar, so
 * changing the positioning engine does not take the anchoring coverage with it.
 * @param view - The editor view to measure against.
 * @param viewportBox - The body scroller's visible box.
 * @param pinned - The screen point a select-all is pinned to, or null.
 * @returns The anchor rectangle, or null while the selection is empty.
 */
export function bubbleAnchorRect(
  view: EditorView,
  viewportBox: DOMRect,
  pinned: { x: number; y: number } | null,
): DOMRect | null {
  if (view.state.selection.empty) return null;
  // A pinned point has no extent, so both edges of its "line" are the same
  // coordinate; the gap then gives it the shape a real line would have.
  if (pinned) return anchorRect(pinned.x, { top: pinned.y, bottom: pinned.y });
  // The two axes come from different places, and they have to. Vertically the
  // bar belongs to ONE line — the anchor. Horizontally the ruling asks for the
  // selection's left edge, which is the left of the box it occupies: the
  // anchor's own x is no such thing, and neither is `posToDOMRect`, which
  // samples only the two endpoints and so misses the block edge a middle line
  // starts at.
  const line = pickAnchorLine(view, viewportBox);
  return anchorRect(selectionBox(view).left, line);
}

/**
 * Whether a range of the document holds any text at all.
 *
 * `doc.textBetween(from, to)` answers the same question by building the whole
 * string first, and this runs on every mouse event anywhere on the page: over
 * a select-all that string is the entire document, rebuilt each time. Walking
 * instead stops at the first text node it finds.
 * @param doc - The document node.
 * @param from - Range start.
 * @param to - Range end.
 * @returns True when at least one non-empty text node lies in the range.
 */
export function hasTextIn(doc: ProseMirrorNode, from: number, to: number): boolean {
  // An empty range holds nothing, and `nodesBetween` would say otherwise: it
  // still visits the text node the position sits inside. Measured against
  // `textBetween(...).length > 0` over every (from, to) pair of ten document
  // shapes — that is the only disagreement between the two, and this removes
  // it, so the swap does not depend on the caller checking `selection.empty`
  // first (it does, but the function should not need it to).
  if (from >= to) return false;
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.isText && (node.text?.length ?? 0) > 0) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
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
   * Not "rendered but disabled": this bar only appears because someone
   * selected text, and a bar whose every button is dead is nothing but noise
   * (ruling §3.3.1).
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
}): React.JSX.Element | null {
  // The bar element, as state rather than only a ref: the four slots mount
  // their menus INSIDE it (`container`), and a ref is still null on the render
  // that creates the element. A menu that mounted with null went to `body`
  // instead, which put focus outside the bar's subtree, which took the bar off
  // the screen — measured, hovering a slot removed the whole bar.
  const [barEl, setBarEl] = React.useState<HTMLDivElement | null>(null);
  const barRef = React.useRef<HTMLDivElement | null>(null);
  // Whether one of the bar's own overlays — a slot menu or the link panel — is
  // open. Read by `isWarranted`, written just below where both are tracked.
  const overlayOpenRef = React.useRef(false);
  // Whether the bar belongs on screen at all. Two paths write it: every
  // transaction (plus focus and blur), and the mouse-event path that pins a
  // select-all to the pointer — the latter carries no transaction of its own.
  const [warranted, setWarranted] = React.useState(false);
  // Which anchor the bar hangs off, as state so the render can read it: the
  // pointer when a select-all is pinned, a line of the selection otherwise.
  // The two want different coordinate systems (see `strategy` below), and
  // `useFloating` is called during the render.
  const [pinned, setPinned] = React.useState(false);
  const pointerRef = React.useRef<{ x: number; y: number } | null>(null);
  const pinnedRef = React.useRef<BubblePin | null>(null);
  // Whether the last transaction found a select-all, so the next one can tell
  // "the selection just became one" from "it already was". See `follow`.
  //
  // Seeded from the selection this bar is born looking at, not from `false`:
  // the ref's whole job is to say what the previous look found, and on the
  // first look that is whatever is there now. Hardcoding `false` would assert
  // something never measured. (Three ways of mounting this component with a
  // select-all already in place were tried and none of them holds: mounting
  // resets the selection each time. So this is not a fix for a reachable
  // defect — it is the initial value meaning what the name says.)
  const wasSelectAllRef = React.useRef(
    editor.state.selection instanceof AllSelection,
  );

  /**
   * The conditions that hold whichever path is asking.
   *
   * Focus somewhere that counts, a selection that is not empty, text inside
   * it, and an editable editor. Both askers go through this — the transaction
   * path and the mouse-event path below. That path used to carry its own
   * shorter list and so put the bar up over an editor the reader had already
   * left.
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
    // Focus first, then the text. Both answer in constant time now —
    // `hasTextIn` stops at the first text node — so this order is no longer
    // about cost; it is just the cheapest question asked first.
    //
    // An open overlay counts as the focus being where it should. Radix moves
    // focus into the menu content when one opens, and the prop that would stop
    // that move (`onOpenAutoFocus`) is `Omit`ted from the public type — Radix
    // saying it is not ours to pass. The reading is OUR OWN STATE rather than
    // the DOM's active element: during a focus change the active element is
    // `<body>` for the length of the `blur`, and in a test environment with no
    // layout the menu is not focusable at all, so it stays `<body>` — measured
    // both ways, reading the DOM took the bar off screen the moment a slot was
    // hovered.
    if (!view.hasFocus() && !overlayOpenRef.current) return false;
    return hasTextIn(doc, selection.from, selection.to);
  }, [editor]);

  /**
   * Where the bar sits over a select-all, or null when it stays away.
   *
   * Pure: it reads the pin and never writes one. Pinning happens at the two
   * moments the ruling names and nowhere else — the transaction that makes
   * the selection a select-all, and a mouse event over the body. Keeping the
   * two apart is what makes "the pointer is only read at those moments" true;
   * when this doubled as the act of pinning, the plugin's own 250ms update
   * debounce decided the moment instead, and a pointer moved inside that
   * window was taken as the answer.
   *
   * It used to store the rescaled point back, on the reasoning that ratios
   * would otherwise compound across resizes. They do not: this always maps
   * from the ORIGINAL point and the area it was placed in, so two resizes in
   * a row give the same answer as one straight to the final size, and with
   * one division instead of two.
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
    return pinnedScreenPoint(pinnedRef.current, viewport.getBoundingClientRect());
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
      const { view } = editor;
      const isAll = view.state.selection instanceof AllSelection;
      // The ruling's FIRST moment is the INSTANT the selection becomes a
      // select-all, not every transaction that happens to find one.
      // Transactions arrive from everywhere: a co-editor's keystroke, the
      // editor regaining focus, an undo. Acting on all of them means the pin
      // is made from wherever the pointer last happened to be, at a moment
      // nobody asked about. Measured with a second Y.Doc over the wire: the
      // reader select-alls with the pointer outside the body (no bar, right),
      // switches away, the pointer drifts across the text, a co-editor types,
      // the reader comes back — and the bar appears at a spot they merely
      // passed over.
      const became = isAll && !wasSelectAllRef.current;
      wasSelectAllRef.current = isAll;
      if (!isAll) {
        pinnedRef.current = null;
        return;
      }
      if (!became) return;
      // Same order as the mouse path, for the same reason: pinning is a WRITE,
      // and a pin made while no bar is warranted would sit there waiting.
      if (!isWarranted(view)) return;
      pinToPointer();
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [editor, isWarranted, pinToPointer]);


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
   * (`dist/index.js:159-161`; its four metas — `updatePosition`,
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

  // The second of the two moments the ruling names: A MOUSE EVENT ARRIVES.
  // Not "the pointer moved" and not "the page scrolled" — any mouse event at
  // all, a wheel gesture included, because each one carries a fresh reading
  // of where the pointer is (user 2026-08-20; the wording is quoted in the
  // design record, §5.1). The first moment is the transaction that makes the
  // selection a select-all.
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
      // Two field reads first, and they are not just an optimisation. On an
      // existing pin `pinToPointer` answers TRUE (it is idempotent), so
      // without this exit the two metas below would fire on every mouse event
      // while a bar is up — waking the plugin over and over to be told
      // nothing changed. The select-all test is the cheap half of what
      // `pinToPointer` asks, and skipping the call keeps this handler's
      // reading of the rules in one place.
      if (pinnedRef.current) return;
      const { view } = editor;
      if (!(view.state.selection instanceof AllSelection)) return;
      // `isWarranted` before `pinToPointer`, not after: pinning is a write,
      // and a pin made while no bar is warranted would sit there waiting. The
      // reader would then get the bar at a place the pointer passed through
      // while they were typing somewhere else entirely.
      if (!isWarranted(view) || !pinToPointer()) return;
      // Straight to the state. This path carries no transaction of its own —
      // the reader moved the pointer, they did not edit — so there is nothing
      // for the transaction listener to hear. `pinToPointer` answered true
      // just above, so this bar hangs off the pointer.
      setWarranted(true);
      setPinned(true);
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
  }, [editor, viewport, isWarranted, pinToPointer]);

  /**
   * This bar's anchor rectangle, read fresh.
   * @returns The rectangle, or null while the selection is empty.
   */
  const anchorLine = React.useCallback(
    (): DOMRect | null =>
      bubbleAnchorRect(editor.view, viewport.getBoundingClientRect(), pinnedPoint()),
    [editor, viewport, pinnedPoint],
  );

  /**
   * Step aside while a panel is up.
   *
   * The panel holds the focus and the reader's attention while it is open, and
   * the two would otherwise be anchored to the same line: measured, a panel
   * that `flip` sent above its target landed on the bar's own pixels.
   *
   * Made invisible rather than hidden through the plugin. Telling the plugin to
   * hide takes the bar's whole subtree with it, and every panel is part of that
   * subtree: measured in a browser, pressing the link button left bar, button
   * and panel all absent, because a portalled panel still belongs to the
   * component that renders it. jsdom does not show this — its bar element goes
   * while React keeps the children — which is why it is a browser case that
   * pins it.
   *
   * Coming back is the selection's business either way: closing a panel drops
   * the selection, so `shouldShow` turns the bar off a moment later.
   */
  const [panelOpen, setPanelOpen] = React.useState(false);

  // One menu open at a time (§5.3, I-7). The bar holds it and hands every slot
  // the id that is open plus this setter, each comparing for itself — with the
  // state on each slot, the one being left would hear nothing as the pointer
  // moves to the next.
  const [openMenu, setOpenMenu] = React.useState<string | null>(null);
  // Mirrored into a ref so `isWarranted` can read it without listing it as a
  // dependency: that callback is handed to listeners registered once, and a new
  // identity on every menu open would re-register all of them.
  //
  // A panel counts the same as a menu. Both are the bar's own overlays, both
  // take the focus when they open, and the bar is what renders them — so a bar
  // that judged focus-has-left while one was up would take that overlay away
  // with itself. Measured: pressing edit inside the link panel put the whole
  // panel out of the document.
  overlayOpenRef.current = openMenu !== null || panelOpen;
  const setMenuOpen = React.useCallback((id: string, open: boolean): void => {
    setOpenMenu((current) => {
      if (open) return id;
      // A close only counts for the slot that is open: moving from A to B,
      // A's close and B's open arrive one after the other, and a close landing
      // second would take B away with it.
      return current === id ? null : current;
    });
  }, []);

  // The bar stays away while the pointer is down (D1).
  //
  // Same route the link panel takes — `invisible!` on the bar, rather than
  // asking the plugin to re-run `shouldShow`: its `update` returns early when
  // neither the selection nor the document changed
  // (`bubble-menu-plugin.ts`, `handleDebouncedUpdate`), so a transaction that
  // alters nothing buys no second look.
  //
  // The plugin debounces selection changes by 250ms and asks "has the
  // selection held still that long", which a pause mid-drag satisfies — the
  // bar appears, the drag goes on, and it jumps after. What it judges is "the
  // selection stopped moving", not "the act of selecting ended". The industry
  // answer is a pointer gate rather than a delay: BlockNote's
  // `FormattingToolbar` takes the bar away on `pointerdown` and asks again on
  // `pointerup` (its comment names Notion as the source; `setTimeout` appears
  // nowhere in the file), and Plate's `useFloatingToolbar` does the same.
  const [pointerDown, setPointerDown] = React.useState(false);
  React.useEffect(() => {
    const { view } = editor;
    /** Pressed: the bar steps aside and any menu closes. */
    const down = (): void => {
      setPointerDown(true);
      setOpenMenu(null);
    };
    /** Released: the gate opens and the bar decides on the selection alone. */
    const up = (): void => {
      setPointerDown(false);
    };
    view.dom.addEventListener('pointerdown', down);
    // On the root, capturing: readers often drag past the editor before
    // letting go, and a listener on `view.dom` would miss that release and
    // leave the gate shut for good.
    const root = view.root as Document | ShadowRoot;
    root.addEventListener('pointerup', up, true);
    // A cancelled pointer (dragged out of the window, the app switched away)
    // opens the gate too; without it the bar would never come back.
    root.addEventListener('pointercancel', up, true);
    return () => {
      view.dom.removeEventListener('pointerdown', down);
      root.removeEventListener('pointerup', up, true);
      root.removeEventListener('pointercancel', up, true);
    };
  }, [editor]);

  /**
   * The anchor, as floating-ui wants it.
   *
   * `getBoundingClientRect` reads the selection AT CALL TIME rather than
   * closing over a rectangle measured once. `autoUpdate` answers a scroll by
   * calling `computePosition` again, and `computePosition` asks the reference
   * where it is — a captured rectangle would send the bar back to where the
   * text used to be (E1).
   *
   * `contextElement` is load-bearing, not decoration. `autoUpdate` runs
   * `unwrapElement(reference)`, which for a virtual element reads exactly this
   * field, and the whole `getOverflowAncestors` walk is skipped when it comes
   * back undefined — with no context element, not one scroll listener is
   * attached to the body's scroller and the bar never follows anything.
   */
  const anchor = React.useMemo<VirtualElement>(
    () => ({
      getBoundingClientRect: () => anchorLine() ?? new DOMRect(0, 0, 0, 0),
      contextElement: editor.view.dom,
    }),
    [anchorLine, editor],
  );

  // Which side the bar came up on, settled the moment it came up (E3).
  //
  // `flip` runs while this is null and is left out of the array once it holds
  // a side, which fixes the placement for as long as the bar stays up. User
  // 2026-08-26: "decide where it goes when it appears; after that do not let
  // it turn over again". A bar that keeps re-deciding jumps from above the
  // selection to below it mid-scroll, under a pointer that is not on it.
  const [side, setSide] = React.useState<Placement | null>(null);

  // Held rather than written inline: `useFloating` compares the array by
  // identity, and a new one on every render would recompute the position on
  // every render.
  const middleware = React.useMemo(
    () => (side === null
      // No `offset`: the gap is already part of the anchor rectangle
      // (`anchorRect`), and a middleware adding it again would double it.
      //
      // Both boundaries name the body's visible area rather than letting each
      // middleware find whichever ancestor happens to clip, and they keep the
      // bar inside it. Nothing has to take the bar away when the anchor
      // leaves: the bar sits inside the scroller, so the scroller's own
      // overflow clips it, which is how the link panel does it too (E5).
      ? [flip({ boundary: viewport }), shift({ boundary: viewport })]
      // `shift` stays on either side of that decision: it holds the bar inside
      // the body column horizontally, which is a different question from which
      // side of the selection it sits on.
      : [shift({ boundary: viewport })]),
    [side, viewport],
  );

  const { refs, floatingStyles, update, placement, isPositioned } = useFloating({
    // Tracked so `isPositioned` means "this bar, as it stands now, has been
    // placed" — it goes back to false each time the bar leaves.
    open: warranted,
    // Two anchors, two coordinate systems.
    //
    // Against a line of the selection the bar belongs to the scrolled content:
    // `absolute` inside the scroller puts its offsets in the content's own
    // coordinates, so it travels with the text and the scroller's overflow
    // clips it when the line goes (E1, E5).
    //
    // Against the pointer it belongs to the screen. The pin is a client point,
    // and holding a content-positioned element at a fixed client point takes a
    // correction on every scroll event — measured in a browser, the bar moved
    // with the content for the frame between the scroll and the correction
    // landing, 120px on a single wheel step. `fixed` takes its offsets from the
    // viewport, so the scroll moves nothing and there is nothing to correct
    // (E2).
    strategy: pinned ? 'fixed' : 'absolute',
    placement: side ?? 'top-start',
    middleware,
    whileElementsMounted: autoUpdate,
  });

  // Take the side down as soon as it has been placed, and let it go when the
  // bar does. The open menu goes with it: that id lives here, on a component
  // that stays mounted, while the slots unmount with the bar — left set, it
  // would open a menu again the moment the next selection brings them back.
  React.useEffect(() => {
    if (!warranted) {
      setSide(null);
      setOpenMenu(null);
      return;
    }
    // Not while the pointer is down. E3 settles the side "as the bar comes
    // up", and D1 keeps the bar off screen for the length of a drag-select, so
    // coming up IS the release. A side taken mid-drag is taken from a line the
    // reader never saw the bar against: dragging upward there is room above the
    // head where the drag starts and none where it ends, and with `flip` gone
    // by then only `shift` acts — which works on the cross axis and leaves the
    // bar hanging over the body's top edge. Measured in a browser: 40px of it
    // outside, clipped by the scroller.
    if (pointerDown || side !== null || !isPositioned) return;
    setSide(placement);
  }, [warranted, isPositioned, placement, side, pointerDown]);

  React.useEffect(() => {
    refs.setPositionReference(anchor);
  }, [anchor, refs]);

  /**
   * Take the bar element three ways at once.
   *
   * Stable, not written inline: React detaches an inline ref callback and
   * re-attaches it on every render, calling it with null in between, and that
   * null reaches the slots as their menu container.
   * @param node - The bar, or null as it unmounts.
   */
  const takeBarNode = React.useCallback(
    (node: HTMLDivElement | null): void => {
      barRef.current = node;
      setBarEl(node);
      refs.setFloating(node);
    },
    [refs],
  );
  // The bar refuses the focus change a press on it would cause.
  //
  // Same move as Slate's official hovering-toolbar example, whose comment reads
  // "prevent toolbar from taking focus away from editor"
  // (`site/examples/ts/hovering-toolbar.tsx`). Without it, pressing the bar's
  // padding took focus out of the body: measured — focus in neither the editor
  // nor the bar, the body's selection highlight gone. The buttons keep
  // working, since their commands run on click and the editor never lost focus
  // to begin with.
  //
  // As a native listener rather than React's `onMouseDown`, because the same
  // press must be refused wherever inside the bar it lands, including on the
  // menus the slots mount in here.
  React.useEffect(() => {
    const bar = barEl;
    if (!bar) return undefined;
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
  }, [barEl]);

  // The question is asked on every transaction, and on focus and blur — the
  // three moments that can change any of `shouldShow`'s terms. Focus and blur
  // carry no transaction of their own, so a bar left up after the reader
  // clicked away would have nothing to take it down.
  React.useEffect(() => {
    /** Re-ask whether the bar belongs on screen, and where it belongs. */
    const ask = (): void => {
      setWarranted(shouldShow({ view: editor.view }));
      // Which anchor, asked at the same three moments: a selection becoming or
      // ceasing to be a select-all is a transaction, and the answer decides
      // the coordinate system the position is computed in.
      setPinned(pinnedPoint() !== null);
      // Whether and where are asked together: these same three moments are
      // the ones that move the anchor. `autoUpdate` does not cover them — it
      // listens for scrolls and for elements changing size, and a new
      // selection is neither, so without this the bar stays above the line
      // the previous selection was on.
      update();
    };
    /**
     * The editor lost focus — ask again, unless the focus is on its way into
     * the bar.
     *
     * `relatedTarget` rather than `document.activeElement`: during a focus
     * change the active element is `<body>` for the length of the `blur`, and
     * a check reading it there judges every menu opening as focus leaving for
     * nowhere. `relatedTarget` names the element about to receive it. The
     * bubble-menu plugin reads the same field for the same reason.
     * @param payload - What tiptap passes its `blur` event.
     * @param payload.event - The DOM focus event.
     */
    const askOnBlur = ({ event }: { event: FocusEvent }): void => {
      const next = event.relatedTarget;
      const bar = barRef.current;
      if (bar && next instanceof Node && bar.contains(next)) return;
      ask();
    };
    editor.on('transaction', ask);
    editor.on('focus', ask);
    editor.on('blur', askOnBlur);
    ask();
    return () => {
      editor.off('transaction', ask);
      editor.off('focus', ask);
      editor.off('blur', askOnBlur);
    };
  }, [editor, shouldShow, pinnedPoint, update]);

  // The controls are built only while the bar is on screen, which is what the
  // early return below makes true: each of them runs its command's dry run on
  // every transaction, and the bar spends almost all of its life away.
  if (!warranted) return null;

  return (
    // `FloatingPortal`, the same one the link panel uses. It mounts a
    // container of its own inside the root and puts the bar in that, which
    // matters here: `index.css:970` makes every DIRECT child div of the body's
    // scroll viewport a full-height column flex container, so a bar mounted as
    // a direct child came out 74 wide and 870 tall with its controls stacked
    // vertically (measured in a browser). Inside the portal's container the
    // bar is a grandchild and that rule does not reach it.
    <FloatingPortal root={viewport}>
      <div
        ref={takeBarNode}
        style={floatingStyles}
        data-testid='doc-selection-bubble-bar'
        // Above the whole-document entry. The bar is the transient one, summoned
        // by a selection the reader just made, and its horizontal position
        // follows that selection far enough to reach the entry's corner. The
        // editor shell is `isolate`, so this number is compared against the
        // entry's and nothing else on the page.
        className={cn(
          'z-20 flex items-center gap-0.5 rounded-overlay border border-border bg-popover px-1.5 py-1 shadow-md',
          // `isPositioned` is the third term, and it is about the bar's first
          // frame. floating-ui has to have the element in the document before
          // it can measure it, so the bar enters carrying whatever offsets the
          // previous computation left — measured in a browser over a keyboard
          // selection, that is the scroller's own top left corner (320, 80),
          // one frame before the real place (616, 290). A mouse selection hides
          // this behind the press gate; the keyboard has no such gate.
          (panelOpen || pointerDown || !isPositioned)
            && 'invisible pointer-events-none',
        )}
      >
        {BUBBLE_GROUPS.map((group, index) => (
          <React.Fragment key={group.key}>
            {index > 0 ? (
              <Separator
                orientation='vertical'
                // Not decorative: the groups this divides are meant to be
                // announced apart, which is the case the component's own
                // docstring names for this flag.
                decorative={false}
                data-testid={`doc-bubble-sep-${group.key}`}
                // The demo's `.bubble-sep` is 16 tall with 3px either side.
                // Its 1px width and its colour come from the component.
                className='mx-[3px] h-4 w-px'
              />
            ) : null}
            {group.panels.map((Panel, panelIndex) => (
              <Panel key={panelIndex} editor={editor} onPanelOpenChange={setPanelOpen} />
            ))}
            {group.tools.map((tool) => (
              <ToolButton key={tool.id} tool={tool} editor={editor} />
            ))}
            {group.slot ? (
              <group.slot
                editor={editor}
                container={barEl}
                scroller={viewport}
                openId={openMenu}
                onOpenChange={setMenuOpen}
              />
            ) : null}
            {group.coming.map((tool) => (
              <ComingTool key={tool.id} tool={tool} />
            ))}
          </React.Fragment>
        ))}
      </div>
    </FloatingPortal>
  );
}
