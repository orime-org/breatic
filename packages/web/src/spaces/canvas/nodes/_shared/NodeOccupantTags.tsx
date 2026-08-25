// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { userPaletteColor } from '@web/lib/user-color';
import { countTagsThatFit } from '@web/spaces/canvas/fit-tags';

/**
 * The row's width limit, in px. Taken from the node name it sits above
 * (`NodeHeader.tsx:80` uses `max-w-[16rem]`), the only width on this anchor
 * that has a source.
 */
const MAX_ROW_PX = 256;

/** The space between two neighbouring tags, in px (`gap-1`). */
const GAP_PX = 4;

/**
 * What the `+N` badge takes, in px. An 11px `+9` plus the same padding the
 * tags carry; a node held by more than nine people at once would read `+10`
 * and run a couple of px wider, which costs one tag's place at most.
 */
const BADGE_PX = 22;

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
 * answers nothing. A row that ends up empty renders nothing at all, so a node
 * nobody is holding looks exactly as it does today.
 * @param props - The component props.
 * @param props.userIds - The user ids holding this node.
 * @param props.indentPx - Left inset matching the name below.
 * @returns The row of tags, or null when there is nobody to name.
 */
export function NodeOccupantTags({
  userIds,
  indentPx,
}: NodeOccupantTagsProps): React.JSX.Element | null {
  const names = useCollaboratorNames();
  const resolve = names?.resolve;

  const people = React.useMemo(() => {
    if (!resolve) return [];
    // `resolve` answers null for someone the roster cannot name — a member who
    // left, or a roster still loading. `flatMap` drops those and narrows the
    // name to a string for everyone that is left.
    return userIds.flatMap((userId) => {
      const name = resolve(userId);
      return name ? [{ userId, name }] : [];
    });
  }, [userIds, resolve]);

  const rowRef = React.useRef<HTMLDivElement>(null);
  // A measurement belongs to one exact roster of names, so the key has to
  // survive names carrying whatever characters a person's name carries.
  const key = JSON.stringify(people.map((p) => [p.userId, p.name]));
  const [measured, setMeasured] = React.useState<{ key: string; fit: number } | null>(null);
  // Until this key has been measured every tag is drawn, which is both the
  // truthful answer for a row that fits and the state the measurement needs.
  const fit = measured?.key === key ? measured.fit : people.length;

  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || people.length === 0) return;
    if (measured?.key === key) return;
    // `offsetWidth`, not the bounding rect: this row rides inside the node's
    // counter-scale transform, and the rect would report scaled pixels while
    // the limit above is a layout one.
    const widths = [...row.children].map((child) => (child as HTMLElement).offsetWidth);
    setMeasured({ key, fit: countTagsThatFit(widths, BADGE_PX, MAX_ROW_PX, GAP_PX) });
  }, [key, people.length, measured]);

  if (people.length === 0) return null;

  const shown = people.slice(0, fit);
  const hidden = people.length - shown.length;

  return (
    <div
      ref={rowRef}
      data-testid='node-occupant-tags'
      className='pointer-events-none flex max-w-[16rem] items-center gap-1 pb-0.5 select-none'
      style={{ paddingLeft: `${indentPx}px` }}
    >
      {shown.map((person) => (
        <span
          key={person.userId}
          className='overflow-hidden rounded-content-xs px-[0.3rem] py-[0.1rem] text-2xs font-semibold text-ellipsis whitespace-nowrap text-[color:var(--color-on-palette)]'
          style={{ backgroundColor: userPaletteColor(person.userId) }}
        >
          {person.name}
        </span>
      ))}
      {hidden > 0 ? (
        <span
          data-testid='node-occupant-overflow'
          className='rounded-content-xs bg-muted-foreground px-[0.3rem] py-[0.1rem] text-2xs font-semibold whitespace-nowrap text-[color:var(--color-on-palette)]'
        >
          {`+${hidden}`}
        </span>
      ) : null}
    </div>
  );
}
