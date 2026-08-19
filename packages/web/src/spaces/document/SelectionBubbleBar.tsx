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
 * ## Four things the stock component does not do for us
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
 */

import * as React from 'react';
import type { Editor } from '@tiptap/react';
import { posToDOMRect } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { BubbleMenu } from '@tiptap/react/menus';

import {
  ToolButton,
  type ToolDef,
} from '@web/spaces/document/document-tool-button';
import { MARK_TOOLS, BLOCK_TOOLS } from '@web/spaces/document/DocumentToolbar';

/** The commands this carrier shows, in the order the ruling lists them. */
const BUBBLE_TOOLS: ToolDef[] = [...MARK_TOOLS, ...BLOCK_TOOLS];

/** How far above the selection the bar sits, per the ruling's visual spec. */
const OFFSET_FROM_SELECTION_PX = 8;

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
    const line = view.coordsAtPos(pos);
    return line.bottom > bounds.top && line.top < bounds.bottom;
  };

  if (head >= from && head <= to && isVisible(head)) return head;
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
 * A zero-width rectangle standing in for one line of text.
 *
 * Zero width is not a shortcut: `top-start` reads the left edge and the top,
 * and a right edge would only invite the shift middleware to slide the bar
 * along a box the user never selected.
 * @param left - Left edge, in viewport coordinates.
 * @param top - Top edge, in viewport coordinates.
 * @param bottom - Bottom edge, in viewport coordinates.
 * @returns The rectangle.
 */
function lineRect(left: number, top: number, bottom: number): DOMRect {
  return new DOMRect(left, top, 0, Math.max(0, bottom - top));
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
 * @param root0 - Bar props.
 * @param root0.editor - The editor this bar acts on.
 * @param root0.readOnly - True for a viewer; the bar stays away entirely.
 * @returns The bar, or null for a viewer.
 */
export function SelectionBubbleBar({
  editor,
  readOnly = false,
}: SelectionBubbleBarProps): React.JSX.Element | null {
  // Resolved when the plugin mounts the bar rather than on render: at render
  // time the scroller may not be in the document yet, and `appendTo` accepts a
  // function precisely so the answer can be given later (`dist/index.js:366`).
  const appendTo = React.useCallback(
    () => document.querySelector<HTMLElement>('.doc-body-scroller')?.parentElement
      ?? document.body,
    [],
  );

  const [viewport, setViewport] = React.useState<HTMLElement | null>(null);
  // The viewport exists one commit after this component first renders, so it
  // cannot be read during that first render.
  React.useEffect(() => {
    setViewport(
      document.querySelector<HTMLElement>(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      ),
    );
  }, []);

  const getReferencedVirtualElement = React.useCallback(() => {
    if (!viewport) return null;
    const { view } = editor;
    if (view.state.selection.empty) return null;
    const bounds = viewport.getBoundingClientRect();
    const { from, to } = view.state.selection;
    const line = view.coordsAtPos(pickAnchorPos(view, bounds));
    // The two axes come from different places, and they have to. Vertically the
    // bar belongs to ONE line — the anchor. Horizontally the ruling asks for
    // the selection's left edge, and the anchor's own x is no such thing: the
    // anchor is usually the head, which for a `Mod-a` sits at the END of the
    // last line. Measured, taking x from the anchor put the bar 314px right of
    // where the ruling wants it.
    const left = posToDOMRect(view, from, to).left;
    // Clip the line into the viewport. Whole-block selections start at the top
    // of a block that may itself be half scrolled away, and a bar hung off the
    // part above the fold is a bar nobody can see.
    const top = Math.max(line.top, bounds.top);
    const rect = lineRect(left, top, Math.max(top, line.bottom));
    return {
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect] as unknown as DOMRectList,
    };
  }, [editor, viewport]);

  const options = React.useMemo(
    () => ({
      placement: 'top-start' as const,
      offset: OFFSET_FROM_SELECTION_PX,
      flip: true,
      ...(viewport ? { scrollTarget: viewport } : {}),
    }),
    [viewport],
  );

  if (readOnly) return null;
  // Nothing is rendered until the viewport is in hand, and that is the whole
  // point: the plugin reads `options.scrollTarget` once, in its constructor
  // (`dist/index.js:172`). Handing the option over later does not reach it —
  // the component's own update path drops the first change it is given
  // (`@tiptap/react/dist/menus/index.js` sets `skipFirstUpdateRef` when the
  // plugin registers, and React batches that with this component's own state
  // update, so the two collapse into the one update that gets skipped).
  // Measured: with the option passed late, the plugin's `scrollTarget` stayed
  // `window` through mount and selection, and only became the viewport after
  // something else re-rendered `DocumentEditor` — which, being memoised on a
  // history object that only changes once the user has edited, does not happen
  // in a freshly opened document at all. Waiting one commit costs nothing:
  // there is no selection to float above on the very first frame either.
  if (!viewport) return null;

  return (
    <BubbleMenu
      editor={editor}
      appendTo={appendTo}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={options}
      data-testid='doc-selection-bubble-bar'
      className='flex items-center gap-0.5 rounded-overlay border border-border bg-popover px-1.5 py-1 shadow-md'
    >
      {BUBBLE_TOOLS.map((tool) => (
        <ToolButton
          key={tool.id}
          tool={tool}
          editor={editor}
          carrier='bubble'
        />
      ))}
    </BubbleMenu>
  );
}
