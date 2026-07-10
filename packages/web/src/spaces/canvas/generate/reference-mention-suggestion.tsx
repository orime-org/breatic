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
import { exitSuggestion } from '@tiptap/suggestion';
import type {
  SuggestionKeyDownProps,
  SuggestionOptions,
  SuggestionProps,
} from '@tiptap/suggestion';

import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
} from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import {
  MENTION_KIND_ATTR,
  MENTION_LABEL_ATTR,
  MENTION_THUMBNAIL_ATTR,
} from '@web/spaces/canvas/generate/reference-mention';
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
 * @returns The suggestion options (without `editor`, supplied by the extension).
 */
export function makeReferenceSuggestion(input: {
  getPool: () => ReferenceRailItem[];
  emptyLabel: string;
}): Omit<SuggestionOptions<ReferenceRailItem>, 'editor'> {
  return {
    char: '@',
    // @tiptap/suggestion defaults allowedPrefixes to [" "], which only fires `@`
    // when preceded by a space or at block start — so typing `@` right after
    // text (e.g. CJK "额@") never opened the picker. null lets `@` trigger after
    // any character (Notion / Feishu behaviour).
    allowedPrefixes: null,
    items: ({ query }): ReferenceRailItem[] => {
      const q = query.toLowerCase();
      return input
        .getPool()
        .filter((r) => (r.sourceNodeName || '').toLowerCase().includes(q))
        .slice(0, 8);
    },
    command: ({ editor, range, props }): void => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: REFERENCE_MENTION_NODE,
            attrs: {
              [MENTION_SOURCE_ID_ATTR]: props.sourceNodeId,
              [MENTION_THUMBNAIL_ATTR]: props.thumbnail ?? null,
              [MENTION_LABEL_ATTR]: props.sourceNodeName || null,
              [MENTION_KIND_ATTR]: props.sourceNodeType,
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
    render: () => {
      let component: ReactRenderer<ReferenceMentionListRef> | null = null;
      let el: HTMLDivElement | null = null;
      /** floating-ui autoUpdate teardown — keeps the popup glued to the caret. */
      let stopAutoUpdate: (() => void) | null = null;
      /** Document-level outside-click dismisser. */
      let onOutsidePointerDown: ((event: PointerEvent) => void) | null = null;

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
          component = new ReactRenderer(ReferenceMentionList, {
            props: {
              items: props.items,
              command: (item: ReferenceRailItem) => props.command(item),
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
          // Dismiss on click outside the popup AND outside the editor: clicking
          // a canvas node / panel control does NOT move the ProseMirror
          // selection, so the suggestion would otherwise stay open floating over
          // the UI. exitSuggestion is the plugin's own clean-close path (fires
          // onExit) (adversarial 2026-07-10). Capture phase so we see the click
          // before ReactFlow stops it.
          onOutsidePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (
              el &&
              target &&
              !el.contains(target) &&
              !props.editor.view.dom.contains(target)
            ) {
              exitSuggestion(props.editor.view);
            }
          };
          document.addEventListener('pointerdown', onOutsidePointerDown, true);
          place(props.clientRect);
        },
        onUpdate: (props: SuggestionProps<ReferenceRailItem>): void => {
          component?.updateProps({
            items: props.items,
            command: (item: ReferenceRailItem) => props.command(item),
            emptyLabel: input.emptyLabel,
          });
          place(props.clientRect);
        },
        onKeyDown: (props: SuggestionKeyDownProps): boolean => {
          if (props.event.key === 'Escape') return true;
          return component?.ref?.onKeyDown(props.event) ?? false;
        },
        onExit: (): void => {
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
          el?.remove();
          el = null;
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
