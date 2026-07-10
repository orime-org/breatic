// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The `@`-suggestion popup list: the connection reference pool a user picks from
 * when typing `@` in the prompt (design 2026-07-10 §2.2). Each row is a source
 * image thumbnail + node name; arrow keys move the selection and Enter picks.
 * Rendered by the suggestion's ReactRenderer and positioned at the caret by
 * floating-ui (see reference-mention-suggestion).
 */

import { ImageOff } from 'lucide-react';
import * as React from 'react';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

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
  const [selected, setSelected] = React.useState(0);
  // Reset the highlight to the top whenever the filtered set changes.
  React.useEffect(() => setSelected(0), [items]);

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
    <div className='max-h-56 w-56 overflow-auto rounded-overlay border border-border bg-popover p-1 shadow-md [scrollbar-width:thin]'>
      {items.map((item, i) => (
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
              <ImageOff className='h-3 w-3' aria-hidden='true' />
            </span>
          )}
          <span className='truncate'>{item.sourceNodeName || 'reference'}</span>
        </button>
      ))}
    </div>
  );
});
