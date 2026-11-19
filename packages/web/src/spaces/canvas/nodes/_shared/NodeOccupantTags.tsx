// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Bot } from 'lucide-react';
import * as React from 'react';

import { AgentPresenceContext, connectionOfOccupant } from '@web/features/agent-presence/agent-focus';
import { useNamed } from '@web/features/collab-editor/collaborator-names-context';
import { userPaletteColor } from '@web/lib/user-color';
import { cn } from '@web/lib/utils';

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
  /**
   * The user ids holding this node, already in the order to draw them: the
   * generation starter first, then the rest by user id. Order decides who is
   * named and who the count folds away, so it is settled upstream.
   */
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
 * The tags carry the same fill, size and weight as the text-caret labels already on screen
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
    React.useMemo(() => userIds.filter((id) => connectionOfOccupant(id) === null).map((userId) => ({ userId })), [userIds]),
  );
  // External agents working on this node, after the members (#1488 design 19.2).
  const { labels } = React.useContext(AgentPresenceContext);
  const agents = React.useMemo(
    () => userIds.flatMap((id) => {
      const connectionId = connectionOfOccupant(id);
      const label = connectionId === null ? undefined : labels.get(connectionId);
      return connectionId === null || label === undefined ? [] : [{ connectionId, label }];
    }),
    [userIds, labels],
  );
  const tags = [
    ...people.map((p) => ({ key: p.userId, agent: false, colorId: p.userId, text: p.name })),
    ...agents.map((a) => ({ key: a.connectionId, agent: true, colorId: a.connectionId, text: a.label })),
  ];

  if (tags.length === 0) return null;

  const shown = tags.slice(0, MAX_NAMES);
  const hidden = tags.length - shown.length;

  return (
    <div
      data-testid='node-occupant-tags'
      className='pointer-events-none absolute bottom-full left-0 flex items-center gap-1 pb-1 select-none'
      style={{ paddingLeft: `${indentPx}px` }}
    >
      {shown.map((tag) => (
        <span
          key={tag.key}
          data-testid={tag.agent ? `node-occupant-agent-${tag.key}` : undefined}
          className={cn(
            'shrink-0 overflow-hidden rounded-content-xs px-[0.3rem] py-[0.1rem] text-2xs font-semibold text-ellipsis whitespace-nowrap text-[color:var(--color-on-palette)]',
            tag.agent ? 'inline-flex max-w-[160px] items-center gap-0.5' : 'max-w-[112px]',
          )}
          style={{ backgroundColor: userPaletteColor(tag.colorId) }}
        >
          {tag.agent ? <Bot aria-hidden='true' className='size-3 shrink-0' /> : null}
          {tag.agent ? <span className='min-w-0 truncate'>{tag.text}</span> : tag.text}
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
