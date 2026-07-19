// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The `@` suggestion wiring for the reference-mention node: typing `@` opens a
 * caret-anchored popup of the current connection reference pool, and picking a
 * row inserts a reference-mention atom carrying the stable `sourceNodeId` plus a
 * snapshot thumbnail / label (design 2026-07-10 §2.2). The pool is read through
 * a getter so the editor is never rebuilt when incoming edges change; the popup
 * is positioned by floating-ui and rendered via TipTap's ReactRenderer.
 */

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { ReactRenderer } from '@tiptap/react';
import type {
  SuggestionKeyDownProps,
  SuggestionOptions,
  SuggestionProps,
} from '@tiptap/suggestion';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { referenceMentionContent } from '@web/spaces/canvas/generate/reference-mention';
import { canConnect } from '@web/spaces/canvas/lib/connection-rules';
import {
  ReferenceMentionList,
  type ReferenceMentionListRef,
} from '@web/spaces/canvas/generate/reference-mention-list';

/**
 * Builds the `@` suggestion options for the reference-mention node.
 * @param input - Wiring inputs.
 * @param input.getPool - Reads the CURRENT reference pool (incoming edges); a
 *   getter so the editor need not rebuild when the pool changes.
 * @param input.emptyLabel - Localized empty-state text for the popup.
 * @param input.imageRefsDisabled - Live getter; when it returns true (t2i),
 *   image references are excluded from the picker. Optional (default: keep all).
 * @returns The suggestion options (without `editor`, supplied by the extension).
 */
export function makeReferenceSuggestion(input: {
  getPool: () => ReferenceRailItem[];
  emptyLabel: string;
  /**
   * Whether source-image references are inert (text-to-image ignores source
   * images). Read live so a mode toggle takes effect without rebuilding the
   * editor. When it returns true, image rows are excluded from the `@` picker so
   * t2i never offers an image reference (user 2026-07-18) — matching the rail,
   * which dims the same rows. Text references stay (they feed the prompt in
   * every mode). Optional; omitted (or false) keeps all connectable refs.
   */
  imageRefsDisabled?: () => boolean;
}): Omit<SuggestionOptions<ReferenceRailItem>, 'editor'> {
  /**
   * Filters the LIVE pool to the rows offerable for a query under the CURRENT
   * mode. Extracted so every popup show path computes from the same live inputs
   * (`getPool` + `imageRefsDisabled`): the plugin's `items()` on each keystroke,
   * AND the focus re-show below. `@tiptap/suggestion` only re-runs `items()` on a
   * query / range change (its `handleChange`), so a mode toggle — which lives on
   * the canvas node, not the prompt doc — never triggered a recompute; a popup
   * hidden (by clicking the mode picker) and re-shown on refocus then kept the
   * pre-toggle list. Computing here on every show path fixes that (#1799/#1800).
   * @param query - The text typed after `@`.
   * @returns The matching pool rows (capped at 8).
   */
  const computeItems = (query: string): ReferenceRailItem[] => {
    const q = query.toLowerCase();
    const hideImages = input.imageRefsDisabled?.() ?? false;
    return input
      .getPool()
      // Connection rules (spec §9.1): new incompatible wires are rejected at
      // the wire level, but a LEGACY edge (audio/video → image, created
      // before the rules) may survive in old documents. Never offer it in
      // the picker — an @-pick that can't feed image generation dead-ends at
      // execute ("no source image"). The rail still lists the legacy row so
      // the user can see and remove it.
      .filter((r) => canConnect(r.sourceNodeType, 'image'))
      // Text-to-image ignores source images, so image references are invalid:
      // exclude them from the `@` picker (user 2026-07-18) — with only images
      // in the pool the picker never opens. Text refs still feed the prompt.
      .filter((r) => !(hideImages && r.sourceNodeType === 'image'))
      .filter((r) => (r.sourceNodeName || '').toLowerCase().includes(q))
      .slice(0, 8);
  };
  return {
    char: '@',
    // @tiptap/suggestion defaults allowedPrefixes to [" "], which only fires `@`
    // when preceded by a space or at block start — so typing `@` right after
    // text (e.g. directly after a CJK character, where no space precedes it)
    // never opened the picker. null lets `@` trigger after any character
    // (Notion / Feishu behaviour).
    allowedPrefixes: null,
    items: ({ query }): ReferenceRailItem[] => computeItems(query),
    command: ({ editor, range, props }): void => {
      // No trailing space (user 2026-07-10): the gap between adjacent chips
      // stays clickable + visible via the chip-boundary caret plugin
      // (reference-mention-caret.ts).
      editor
        .chain()
        .focus()
        .insertContentAt(range, referenceMentionContent(props))
        .run();
    },
    render: () => {
      let component: ReactRenderer<ReferenceMentionListRef> | null = null;
      let el: HTMLDivElement | null = null;
      /** floating-ui autoUpdate teardown — keeps the popup glued to the caret. */
      let stopAutoUpdate: (() => void) | null = null;
      /** Document-level outside-click dismisser. */
      let onOutsidePointerDown: ((event: PointerEvent) => void) | null = null;
      /** Re-shows the popup when the editor regains focus (B2). */
      let onEditorFocus: (() => void) | null = null;
      /**
       * The latest suggestion props (from onStart / onUpdate): `command` is bound
       * to the live `@` range and `query` is the current filter text. The focus
       * re-show path reads these to recompute a FRESH list from the live pool +
       * mode, so a popup hidden by a mode / model click never re-shows a stale
       * list (#1799 / #1800).
       */
      let latestProps: SuggestionProps<ReferenceRailItem> | null = null;

      /**
       * Pushes an item list into the popup and toggles its visibility on whether
       * anything matched (I3: zero matches → hidden, so plain `@` typing is not
       * interrupted by an empty box). Shared by onUpdate and the focus re-show so
       * both paths render identically; the pick command is read live from
       * {@link latestProps} (bound to the current `@` range).
       * @param items - The rows to display.
       */
      const pushItems = (items: ReferenceRailItem[]): void => {
        component?.updateProps({
          items,
          command: (item: ReferenceRailItem) => latestProps?.command(item),
          emptyLabel: input.emptyLabel,
        });
        if (el) el.style.display = items.length > 0 ? '' : 'none';
      };

      /**
       * Anchors the popup to the caret and KEEPS it anchored via floating-ui
       * autoUpdate: a one-shot computePosition would leave the popup at stale
       * coordinates when the surface moves without a keystroke (canvas pan/zoom
       * moves the NodeToolbar-anchored editor; the prompt is its own scroll
       * container). The virtual reference returns the LIVE caret rect each call;
       * animationFrame polling is needed because the canvas pans via CSS
       * transform, not scroll events (adversarial 2026-07-10).
       * @param clientRect - The suggestion's live caret rect getter.
       */
      const place = (
        clientRect: SuggestionProps<ReferenceRailItem>['clientRect'],
      ): void => {
        if (!el || !clientRect) return;
        const reference = {
          getBoundingClientRect: () => clientRect() ?? new DOMRect(),
        };
        stopAutoUpdate?.();
        stopAutoUpdate = autoUpdate(
          reference,
          el,
          () => {
            // Skip repositioning when the caret rect is momentarily unresolvable
            // — keep the last good position rather than snapping to (0,0) (the
            // `?? new DOMRect()` fallback would otherwise place the popup at the
            // viewport corner). Restores the pre-autoUpdate `if (!rect) return`.
            if (!el || !clientRect()) return;
            void computePosition(reference, el, {
              placement: 'bottom-start',
              middleware: [offset(6), flip(), shift({ padding: 8 })],
            }).then(({ x, y }) => {
              if (!el) return;
              el.style.left = `${x}px`;
              el.style.top = `${y}px`;
            });
          },
          { animationFrame: true },
        );
      };

      return {
        onStart: (props: SuggestionProps<ReferenceRailItem>): void => {
          latestProps = props;
          component = new ReactRenderer(ReferenceMentionList, {
            props: {
              items: props.items,
              command: (item: ReferenceRailItem) => latestProps?.command(item),
              emptyLabel: input.emptyLabel,
            },
            editor: props.editor,
          });
          el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.top = '0';
          el.style.left = '0';
          el.style.zIndex = '50';
          el.appendChild(component.element);
          document.body.appendChild(el);
          // Clicking outside the popup AND the editor (a canvas node / panel
          // control) does NOT move the ProseMirror selection, so the suggestion
          // would otherwise stay open floating over the UI. Just HIDE the popup
          // — do NOT exitSuggestion (B2, user 2026-07-12): exitSuggestion marks
          // the active `@` range permanently dismissed, so after a blur-and-back
          // the user's continued typing never re-opened the picker until the
          // editor remounted (close/reopen panel). Hiding keeps the plugin
          // active, so re-focusing and typing re-shows it via onUpdate; a
          // genuine break of the `@` match (space, deleting the `@`, cursor
          // leaving the range) still exits the plugin naturally → onExit removes
          // the popup. Capture phase so we see the click before ReactFlow stops it.
          onOutsidePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (
              el &&
              target &&
              !el.contains(target) &&
              !props.editor.view.dom.contains(target)
            ) {
              el.style.display = 'none';
            }
          };
          document.addEventListener('pointerdown', onOutsidePointerDown, true);
          // Re-show on re-focus (B2 residual, user 2026-07-12): the outside-click
          // handler HIDES the popup (display:none) without exiting the suggestion.
          // Re-focusing the editor (clicking back in) does not fire onUpdate — only
          // typing does — so the popup would stay hidden until a keystroke. On
          // focus, RECOMPUTE the list from the live pool + mode rather than merely
          // un-hiding the cached one: @tiptap/suggestion only re-runs items() on a
          // query / range change, and a mode toggle (stored on the canvas node,
          // not the prompt doc) is neither — so re-showing the stale list kept
          // t2i's text-only rows after switching to i2i and never offered the
          // focus crops i2i should (#1799 / #1800). pushItems also re-hides when
          // nothing matches, matching a freshly-opened panel.
          onEditorFocus = (): void => {
            if (latestProps) pushItems(computeItems(latestProps.query));
          };
          props.editor.view.dom.addEventListener('focus', onEditorFocus);
          // Show the popup ONLY when the pool has ≥1 matching row (I3, user
          // 2026-07-12): typing `@` as ordinary text (nothing matches) must not
          // pop an empty "no references" box. Zero matches → hidden, so plain
          // `@` typing is uninterrupted; a match → shown.
          el.style.display = props.items.length > 0 ? '' : 'none';
          place(props.clientRect);
        },
        onUpdate: (props: SuggestionProps<ReferenceRailItem>): void => {
          latestProps = props;
          // props.items is already computed by the plugin (items() → computeItems
          // with the live mode), so push it as-is; the focus re-show recomputes.
          pushItems(props.items);
          place(props.clientRect);
        },
        onKeyDown: (props: SuggestionKeyDownProps): boolean => {
          if (props.event.key === 'Escape') return true;
          return component?.ref?.onKeyDown(props.event) ?? false;
        },
        onExit: (props: SuggestionProps<ReferenceRailItem>): void => {
          stopAutoUpdate?.();
          stopAutoUpdate = null;
          if (onOutsidePointerDown) {
            document.removeEventListener(
              'pointerdown',
              onOutsidePointerDown,
              true,
            );
            onOutsidePointerDown = null;
          }
          if (onEditorFocus) {
            props.editor.view.dom.removeEventListener('focus', onEditorFocus);
            onEditorFocus = null;
          }
          latestProps = null;
          el?.remove();
          el = null;
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
