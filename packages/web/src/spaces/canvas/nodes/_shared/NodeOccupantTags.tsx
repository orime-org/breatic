// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useNamed } from '@web/features/collab-editor/collaborator-names-context';
import { userPaletteColor } from '@web/lib/user-color';

/**
 * How many names the row draws before it starts counting instead.
 *
 * Two, the number the project member stack in the top bar already uses
 * (`MembersStack.tsx`). A name runs to about a hundred pixels, so two of them
 * plus the count sit inside the 288px node the row hangs above, whoever is
 * holding it and however long their names are.
 */
const MAX_NAMES = 2;

/** Who is holding this node, and how far in its anchor's first line starts. */
export interface NodeOccupantTagsProps {
  /** The user ids holding this node, in the order they arrived. */
  userIds: readonly string[];
  /**
   * Left inset, in px, matching the horizontal padding of the name below —
   * 4px inside a content node's header, 0 above a group's name. It is a
   * parameter because those two differ; a fixed value is wrong in one of them.
   */
  indentPx: number;
}

/**
 * The collaborators holding a node, drawn as name tags on the line above its
 * name.
 *
 * The tags carry the same visual as the text-caret labels already on screen
 * (`index.css` `.collaboration-carets__label`): the writer's identity hue as
 * the fill, 11px semibold, and a text colour that turns over with the theme
 * because those hues are tuned as coloured text.
 *
 * Someone the roster cannot name is left out rather than drawn as a bare
 * coloured chip: the point of the row is who is there, and a chip with no name
 * answers nothing. Such a person is not counted either — the badge stands for
 * people whose names exist and were not drawn. A row that ends up empty
 * renders nothing at all, so a node nobody is holding looks exactly as it does
 * today.
 * @param props - The component props.
 * @param props.userIds - The user ids holding this node.
 * @param props.indentPx - Left inset matching the name below.
 * @returns The row of tags, or null when there is nobody to name.
 */
export function NodeOccupantTags({
  userIds,
  indentPx,
}: NodeOccupantTagsProps): React.JSX.Element | null {
  const people = useNamed(
    React.useMemo(() => userIds.map((userId) => ({ userId })), [userIds]),
  );

  if (people.length === 0) return null;

  const shown = people.slice(0, MAX_NAMES);
  const hidden = people.length - shown.length;

  return (
    <div
      data-testid='node-occupant-tags'
      className='pointer-events-none absolute bottom-full left-0 flex items-center gap-1 pb-1 select-none'
      style={{ paddingLeft: `${indentPx}px` }}
    >
      {shown.map((person) => (
        <span
          key={person.userId}
          className='max-w-[112px] shrink-0 overflow-hidden rounded-content-xs px-[0.3rem] py-[0.1rem] text-2xs font-semibold text-ellipsis whitespace-nowrap text-[color:var(--color-on-palette)]'
          style={{ backgroundColor: userPaletteColor(person.userId) }}
        >
          {person.name}
        </span>
      ))}
      {hidden > 0 ? (
        <span
          data-testid='node-occupant-overflow'
          className='shrink-0 rounded-content-xs bg-muted-foreground px-[0.3rem] py-[0.1rem] text-2xs font-semibold whitespace-nowrap text-background'
        >
          {`+${hidden}`}
        </span>
      ) : null}
    </div>
  );
}
