// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The `@`-suggestion popup list: the connection reference pool a user picks from
 * when typing `@` in the prompt (design 2026-07-10 §2.2). Each row is a source
 * image thumbnail + node name; arrow keys move the selection and Enter picks.
 * Rendered by the suggestion's ReactRenderer and positioned at the caret by
 * floating-ui (see reference-mention-suggestion).
 */

import { Crop } from 'lucide-react';
import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';

/** Imperative handle so the suggestion can forward key events into the list. */
export interface ReferenceMentionListRef {
  /** Returns true when the key was handled (arrow / enter), false otherwise. */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface ReferenceMentionListProps {
  /** The pool rows to choose from (already filtered by the typed query). */
  items: ReferenceRailItem[];
  /** Picks a row — inserts the reference mention. */
  command: (item: ReferenceRailItem) => void;
  /** Localized empty-state text (no connected references match). */
  emptyLabel: string;
}

/**
 * Keyboard-navigable list of pool references for the `@` suggestion popup.
 * @param root0 - Component props.
 * @param root0.items - Pool rows filtered by the typed query.
 * @param root0.command - Picks a row (inserts the mention).
 * @param root0.emptyLabel - Localized empty-state text.
 * @param ref - Imperative handle exposing `onKeyDown` to the suggestion.
 * @returns The popup list.
 */
export const ReferenceMentionList = React.forwardRef<
  ReferenceMentionListRef,
  ReferenceMentionListProps
>(function ReferenceMentionList({ items, command, emptyLabel }, ref): React.JSX.Element {
  const t = useTranslation();
  const [selected, setSelected] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  // Reset the highlight when the row CONTENT changes — never on array
  // identity. @tiptap/suggestion re-runs items() (a fresh array) whenever the
  // suggestion range MOVES, and a collaborator typing anywhere before the `@`
  // in the shared prompt moves it; an identity-keyed reset made that remote
  // keystroke silently snap the highlight to row 0 so Enter inserted the
  // wrong reference (adversarial round-1).
  const contentKey = items.map((i) => i.sourceNodeId).join('\u001f');
  React.useEffect(() => setSelected(0), [contentKey]);
  // Keep the keyboard-selected row visible (I1, user 2026-07-12): arrow keys
  // moved the highlight but the list only scrolled with the mouse, so selecting
  // past the visible rows left the choice off-screen. `block: 'nearest'` scrolls
  // the minimum within the popup's own scroll container without moving the page.
  React.useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const pick = React.useCallback(
    (index: number): void => {
      const item = items[index];
      if (item) command(item);
    },
    [items, command],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event: KeyboardEvent): boolean => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowUp') {
          setSelected((s) => (s + items.length - 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          pick(selected);
          return true;
        }
        return false;
      },
    }),
    [items, selected, pick],
  );

  if (items.length === 0) {
    return (
      <div className='w-56 rounded-overlay border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md'>
        {emptyLabel}
      </div>
    );
  }

  return (
    // ScrollArea (#1773): overlay scrollbar (scroll-only, no layout space,
    // hover = color change). The height cap + padding sit on the viewport
    // (the scroller); `listRef` keeps pointing at the rows' DIRECT parent so
    // the keyboard-follow `children[selected]` lookup stays valid, and
    // scrollIntoView scrolls the nearest scrollable ancestor — the viewport.
    <ScrollArea
      className='w-56 rounded-overlay border border-border bg-popover shadow-md'
      viewportClassName='max-h-56 p-1'
    >
      <div ref={listRef}>
        {items.map((item, i) => {
          // A source with no thumbnail (text / audio / …) shows its MODALITY icon,
          // not a blanket broken-image glyph — the same getNodeIcon the prompt
          // chip uses, so the picker and the inserted chip read identically (P4,
          // user 2026-07-12).
          const FallbackIcon = getNodeIcon(item.sourceNodeType);
          return (
            <button
              key={item.sourceNodeId}
              type='button'
              data-testid={`reference-mention-option-${item.sourceNodeId}`}
              onClick={() => pick(i)}
              onMouseEnter={() => setSelected(i)}
              className={
                'flex w-full items-center gap-2 rounded-overlay px-2 py-1 text-left text-xs ' +
                (i === selected
                  ? 'bg-accent text-accent-foreground'
                  : 'text-popover-foreground')
              }
            >
              {typeof item.thumbnail === 'string' && item.thumbnail.length > 0 ? (
                <img
                  src={item.thumbnail}
                  alt=''
                  className='h-6 w-6 shrink-0 rounded-sm object-cover'
                  draggable={false}
                />
              ) : (
                <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-muted'>
                  <FallbackIcon className='h-3 w-3' aria-hidden='true' />
                </span>
              )}
              {/* Crop glyph before the name marks a focus copy so a standalone
                  focus crop reads apart from a live node reference in the
                  picker (user 2026-07-17, consistent with rail + chip). */}
              {item.focus ? (
                <>
                  <Crop
                    data-testid={`reference-mention-option-focus-badge-${item.sourceNodeId}`}
                    className='h-3 w-3 shrink-0'
                    aria-hidden='true'
                  />
                  {/* SR counterpart (adversarial 2026-07-17): a crop shares
                      its source node's name — announce the distinction. */}
                  <span className='sr-only'>
                    {t('canvas.generatePanel.focusCropTag')}
                  </span>
                </>
              ) : null}
              <span className='truncate'>
                {item.sourceNodeName || t('canvas.generatePanel.reference')}
              </span>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
});
