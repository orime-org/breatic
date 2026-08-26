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
 *   the bar hangs outside the scroller, so nothing removes it once the anchor
 *   scrolls out. The `hide` middleware does; it is OFF by default, and passing
 *   it a boundary is what turns it on.
 * - **The alignment.** The default `placement` is `'top'` (`dist/index.js:48`),
 *   and floating-ui only shifts along the alignment axis when the placement
 *   carries `-start` or `-end` (`@floating-ui/core` `:49-51`); bare `top`
 *   centres. The ruling asks for the bar's left edge on the selection's left
 *   edge, so `'top-start'`.
 * - **Where it lives.** Inside the scroller it gets clipped, so `appendTo`
 *   puts it outside — the use the prop's own doc comment names.
 * - **Scrolling.** That last choice creates a need of its own: the plugin
 *   recomputes on two events, `scrollTarget`'s scroll (`:188`) and the
 *   window's resize (`:187`), both through the same handler (`:172` defaults
 *   `scrollTarget` to `window`; `:307` is a one-shot
 *   `computePosition` with no `autoUpdate`, and `:121` returns early when
 *   neither selection nor document changed). Our scrolling happens inside the
 *   ScrollArea viewport, whose scroll events do not reach `window`. Left
 *   unset, the bar would sit still while the text moved under it.
 * - **Which box decides "it does not fit".** The body's own visible area,
 *   named explicitly. `flip`'s default is the clipping ancestors (floating-ui
 *   `detectOverflow`) — measured 2026-08-22 those come out identical to the
 *   viewport on all four edges, because the 40px that used to separate them
 *   was the top bar and it is gone. Naming the box anyway keeps this
 *   independent of which ancestor happens to carry `overflow-hidden`, which is
 *   a detail of the workspace shell rather than of this bar.
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
 * keeps the whole bar out of the tab order: it floats ON TOP of the body, and
 * anything floating over the body that takes focus collides with the body's
 * own focus with no way to reconcile them. The keyboard route to these eight
 * commands is their shortcuts — `Mod-b` / `Mod-i` / `Mod-Shift-s` / `Mod-u`
 * for the marks, `Mod-e` for inline code, `Mod-Shift-8` / `Mod-Shift-7` /
 * `Mod-Shift-b` for the blocks.
 */

import * as React from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { posToDOMRect } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, PluginKey } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/react/menus';

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
import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';

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
   * Slots that open a menu on hover.
   *
   * Their open state lives on the bar rather than on each of them, so that one
   * is open at a time (§5.3 I-7): the bar hands every slot the id that is open
   * and the setter, each compares.
   */
  slots: React.ComponentType<{
    editor: Editor;
    container: HTMLElement | null;
    scroller: HTMLElement | null;
    openId: string | null;
    onOpenChange: (id: string, open: boolean) => void;
  }>[];
}

/**
 * The controls this carrier shows, grouped the way the demo draws them.
 *
 * Five groups split by four separators, the order the demo's own caption gives
 * (`2026-08-21-editor-command-surface.html:521`): block type ｜ alignment ｜
 * bold italic strike underline ｜ link inline-code colour comment ｜ AI.
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
  { key: 'blocks', tools: [], coming: [], panels: [], slots: [BlockTypeSlot] },
  { key: 'align', tools: [], coming: [], panels: [], slots: [AlignSlot] },
  { key: 'marks', tools: MARK_TOOLS, coming: [], panels: [], slots: [] },
  {
    key: 'inline',
    tools: INLINE_TOOLS,
    panels: [DocumentLinkPopover],
    slots: [ColorSlot],
    coming: [
      {
        id: 'comment',
        labelKey: 'spaces.document.commands.comment',
        Icon: MessageSquareText,
      },
    ],
  },
  { key: 'ai', tools: [], coming: [], panels: [], slots: [AiSlot] },
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

  // A ref, not `useMemo`: this key IS the plugin's identity, and `useMemo` is
  // a cache React is allowed to drop and recompute. A new key mid-life would
  // leave the metas we send addressed to a plugin nobody is listening for.
  // `@tiptap/react`'s own menu wrapper holds its key the same way — a
  // `useRef(...).current` (`dist/menus/index.js:306-308`).
  const pluginKeyRef = React.useRef<PluginKey | null>(null);
  pluginKeyRef.current ??= new PluginKey('selectionBubbleBar');
  const pluginKey = pluginKeyRef.current;

  /**
   * The conditions that hold whichever path is asking.
   *
   * The plugin's own `shouldShow` (`dist/index.js:62-77`) is REPLACED rather
   * than extended when we pass ours, so its conditions live here: focus
   * somewhere that counts, a selection that is not empty, text inside it, and
   * an editable editor. Both askers go through this — the plugin's own
   * question and the mouse-event path below. That path used to carry its own
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
    const bar = barRef.current;
    const { doc, selection } = view.state;
    if (selection.empty || !editor.isEditable) return false;
    // Focus first, then the text. Both answer in constant time now —
    // `hasTextIn` stops at the first text node — so this order is no longer
    // about cost; it is just the cheapest question asked first.
    // 焦点落在条自己这棵子树里也算数。四个下拉的菜单 portal 进条内部
    // （`DropdownMenuContent` 的 `container`），而 Radix 打开菜单时会把焦点
    // 移进菜单内容 —— 拦那次移动的 prop（`onOpenAutoFocus`）住在
    // `MenuContentImplPrivateProps` 里、被公开类型 `Omit` 掉了，Radix 明说
    // 它不对外。所以判据跟着放宽，这也正是 bubble-menu 插件自己的语义
    // （`dist/index.js:71-72` 的 `isChildOfMenu`）。
    const focusInBar = bar !== null && bar.contains(bar.ownerDocument.activeElement);
    if (!view.hasFocus() && !focusInBar) return false;
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
    // Two operands, two different failures.
    //
    // The divisor is the OLD area — `pin.area`, the box the point was placed
    // in. It can be degenerate: `isInside` accepts a rectangle collapsed to a
    // single point (`x >= left && x <= right` both hold when they are equal),
    // and a pointer can only pass that test by sitting exactly on it, so the
    // numerator is zero too: `0 / 0` is NaN. A pin is never rewritten once
    // made, so that one is permanent.
    //
    // The NEW area is tested for a different reason. A zero there makes the
    // product zero, not NaN, and the bar would sit at the area's own corner
    // for that one frame — the next reading of a real size is correct again,
    // because this function always maps from the original point. Momentary,
    // not permanent, and still worth not doing.
    const measurable =
      pin.area.width > 0 && pin.area.height > 0
      && area.width > 0 && area.height > 0;
    if (unchanged || !measurable) {
      return { x: pin.x, y: pin.y };
    }
    return {
      x: area.left + ((pin.x - pin.area.left) / pin.area.width) * area.width,
      y: area.top + ((pin.y - pin.area.top) / pin.area.height) * area.height,
    };
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

  /**
   * The one line this bar sits against, in viewport coordinates and with no
   * gap added.
   *
   * A pinned point has no extent, so both edges of the "line" are the same
   * coordinate; growing it into the gap (below) then gives it the same shape a
   * real line gets, which is what keeps the flip behaviour identical across the
   * two modes.
   *
   * Its x comes from the pointer too, not from the selection's box: over a
   * select-all that box is the whole body column and its left edge says nothing
   * about where the reader is looking.
   * @returns The line, or null while the selection is empty.
   */
  const anchorLine = React.useCallback((): {
    left: number;
    top: number;
    bottom: number;
  } | null => {
    const { view } = editor;
    if (view.state.selection.empty) return null;
    const pinned = pinnedPoint();
    if (pinned) return { left: pinned.x, top: pinned.y, bottom: pinned.y };
    // The two axes come from different places here, and they have to.
    // Vertically the bar belongs to ONE line — the anchor. Horizontally the
    // ruling asks for the selection's left edge, which is the left of the
    // box it occupies: the anchor's own x is no such thing (it is usually
    // the head, and measured, taking x from there put the bar 314px right of
    // where the ruling wants it), and neither is `posToDOMRect`, which
    // samples only the two endpoints and so misses the block edge that a
    // middle line starts at.
    const line = pickAnchorLine(view, viewport.getBoundingClientRect());
    return {
      left: selectionBox(view).left,
      top: line.top,
      bottom: line.bottom,
    };
  }, [editor, viewport, pinnedPoint]);

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

  // 一次只开一个菜单（§5.3 的 I-7）。开合由条持有，每一格拿到「现在开着的是
  // 谁」和这个 setter 自己比对 —— 各格自己存一份的话，指针从一格挪到另一格
  // 时旧的那个收不到任何信号。
  const [openMenu, setOpenMenu] = React.useState<string | null>(null);
  const setMenuOpen = React.useCallback((id: string, open: boolean): void => {
    setOpenMenu((current) => {
      if (open) return id;
      // 关的信号只对当前开着的那一格作数：指针从 A 挪到 B 时，A 的关和 B 的
      // 开先后到达，晚到的那个关会把 B 也收掉。
      return current === id ? null : current;
    });
  }, []);

  // 鼠标按着的时候不显示条（D1）。
  //
  // 插件对选区变化有 250ms 防抖，判据是「选区静止 250ms」—— 拖拽中手一停就
  // 满足，条冒出来，继续拖又跟着跳。它判的是「选区不动了」，不是「选择这个
  // 动作结束了」。业界解法是门控不是延迟：BlockNote 的 `FormattingToolbar`
  // 按下时收起、松开时再判（注释里写明照抄 Notion，`setTimeout` 零命中），
  // Plate 的 `useFloatingToolbar` 同理。
  // 指针按着的时候条不出现（D1）。
  //
  // 走跟链接面板同一条路径 —— 给条挂上 `invisible!`，而不是让插件重问
  // `shouldShow`：插件的 `update` 在选区和文档都没变时直接 return
  // （`bubble-menu-plugin.ts` 的 `handleDebouncedUpdate`），一次不改内容的
  // 事务换不回一次重问。
  const [pointerDown, setPointerDown] = React.useState(false);
  React.useEffect(() => {
    const { view } = editor;
    /** 按下了：条让开，菜单收掉。 */
    const down = (): void => {
      setPointerDown(true);
      setOpenMenu(null);
    };
    /** 松开了：门开，条按当前选区自己决定出不出来。 */
    const up = (): void => {
      setPointerDown(false);
    };
    view.dom.addEventListener('pointerdown', down);
    // 挂在 root 上并捕获：用户常把指针拖出编辑器之外才松手，挂 `view.dom` 会
    // 漏掉那一次，门就永远关着了。
    const root = view.root as Document | ShadowRoot;
    root.addEventListener('pointerup', up, true);
    // 指针被系统取消（拖出窗口、切走应用）同样要开门，否则卡在永不显示。
    root.addEventListener('pointercancel', up, true);
    return () => {
      view.dom.removeEventListener('pointerdown', down);
      root.removeEventListener('pointerup', up, true);
      root.removeEventListener('pointercancel', up, true);
    };
  }, [editor]);

  const getReferencedVirtualElement = React.useCallback(() => {
    const line = anchorLine();
    if (!line) return null;
    const rect = anchorRect(line.left, line);
    return {
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect] as unknown as DOMRectList,
    };
  }, [anchorLine]);

  const options = React.useMemo(
    () => ({
      placement: 'top-start' as const,
      // Off, not absent: the plugin's own default is `offset: 8`
      // (`dist/index.js:49`) and our options are spread over the defaults, so
      // leaving it out keeps it. The gap is part of the anchor already (see
      // `anchorRect`); letting the middleware add it too would double it.
      offset: false as const,
      flip: { boundary: viewport },
      // Already on by default (`:51`). The boundary is named for the same
      // reason as flip's: judge against the body's visible area, not against
      // whichever ancestor happens to clip. This one keeps the whole bar
      // inside the body's left and right edges.
      shift: { boundary: viewport },
      // Off by default (`:55`) — passing it at all is what turns it on. This is
      // what takes the bar away once its anchor has left the body area: the
      // plugin reads the middleware's verdict and sets `visibility: hidden`
      // (`:316-319`). Clipping alone would not, since the bar hangs outside the
      // scroller.
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
  // hidden, so leaving them mounted doubles that work (eight extra dry runs per
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
      // Above the whole-document entry. The bar is the transient one, summoned
      // by a selection the reader just made, and its horizontal position
      // follows that selection far enough to reach the entry's corner. The
      // editor shell is `isolate`, so this number is compared against the
      // entry's and nothing else on the page.
      className={cn(
        'z-20 flex items-center gap-0.5 rounded-overlay border border-border bg-popover px-1.5 py-1 shadow-md',
        // `invisible!` rather than `invisible`: the plugin writes
        // `visibility` as an inline style when it shows the bar
        // (`extension-bubble-menu`), and an inline declaration beats a plain
        // class. Measured — with the plain one the classes were on the element
        // and the bar was still on screen.
        (panelOpen || pointerDown) && 'invisible! pointer-events-none',
      )}
    >
      {hasSelection
        ? BUBBLE_GROUPS.map((group, index) => (
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
            {group.slots.map((Slot, slotIndex) => (
              <Slot
                key={slotIndex}
                editor={editor}
                container={barRef.current}
                scroller={viewport}
                openId={openMenu}
                onOpenChange={setMenuOpen}
              />
            ))}
            {group.coming.map((tool) => (
              <ComingTool key={tool.id} tool={tool} />
            ))}
          </React.Fragment>
        ))
        : null}
    </BubbleMenu>
  );
}
