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
 *   returns it before every other branch. We hand back the line the user can
 *   actually see.
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
  const scrollTarget = React.useCallback(
    () =>
      document.querySelector<HTMLElement>(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      ),
    [],
  );
  // The anchor. Left alone, the plugin measures the selection's whole bounding
  // box (`dist/index.js:261`), which over a `Mod-a` selection is the entire
  // document — the bar would then sit above the first line, however far that
  // line has been scrolled away. What we hand back instead is one line: the
  // first client rect the selection produces that is actually inside the
  // viewport, falling back to the first one when the selection is entirely
  // above or below it. `:254` returns this before every other branch, so it
  // simply wins.
  const getReferencedVirtualElement = React.useCallback(() => {
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0) return null;
    const rects = Array.from(domSelection.getRangeAt(0).getClientRects()).filter(
      (r) => r.width > 0 || r.height > 0,
    );
    if (rects.length === 0) return null;
    const visible =
      rects.find((r) => r.bottom > 0 && r.top < window.innerHeight) ?? rects[0];
    if (!visible) return null;
    return {
      getBoundingClientRect: () => visible,
      getClientRects: () => [visible] as unknown as DOMRectList,
    };
  }, []);

  const [viewport, setViewport] = React.useState<HTMLElement | null>(null);
  // The viewport arrives one commit after this component first renders, so the
  // option cannot be read during that first render. Reading it in an effect and
  // holding it in state lets the plugin pick it up through its own props
  // update (`dist/index.js:405-409` swaps the scroll listener when it changes).
  React.useEffect(() => {
    setViewport(scrollTarget());
  }, [scrollTarget]);

  if (readOnly) return null;

  return (
    <BubbleMenu
      editor={editor}
      appendTo={appendTo}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={{
        placement: 'top-start',
        offset: OFFSET_FROM_SELECTION_PX,
        flip: true,
        ...(viewport ? { scrollTarget: viewport } : {}),
      }}
      data-testid='doc-selection-bubble-bar'
      className='flex items-center gap-0.5 rounded-overlay border border-border bg-popover p-1 shadow-md'
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
