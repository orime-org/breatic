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

import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { ReactRenderer } from '@tiptap/react';
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
 * @throws Never.
 */
export function makeReferenceSuggestion(input: {
  getPool: () => ReferenceRailItem[];
  emptyLabel: string;
}): Omit<SuggestionOptions<ReferenceRailItem>, 'editor'> {
  return {
    char: '@',
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
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },
    render: () => {
      let component: ReactRenderer<ReferenceMentionListRef> | null = null;
      let el: HTMLDivElement | null = null;

      /**
       * Positions the popup element at the caret rect via floating-ui.
       * @param clientRect - The suggestion's caret rect getter.
       * @returns Nothing.
       */
      const place = (
        clientRect: SuggestionProps<ReferenceRailItem>['clientRect'],
      ): void => {
        if (!el || !clientRect) return;
        const rect = clientRect();
        if (!rect) return;
        const reference = { getBoundingClientRect: () => rect };
        void computePosition(reference, el, {
          placement: 'bottom-start',
          middleware: [offset(6), flip(), shift({ padding: 8 })],
        }).then(({ x, y }) => {
          if (!el) return;
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        });
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
          el?.remove();
          el = null;
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
