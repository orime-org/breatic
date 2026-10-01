// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

import { DefaultProjectCover } from '@web/ui/DefaultProjectCover';

interface ItemCardBodyProps {
  /** Cover image, or `null` for the built-in default cover. */
  thumbnailUrl: string | null;
  name: string;
  /** A muted line of its own under the name, truncating when it is too long. */
  subtitle?: string;
  /** Left side of the meta line; it takes the free width and may truncate. */
  meta: React.ReactNode;
  /** Translated role name, or `null` when the viewer has no role on the item. */
  role: string | null;
}

/**
 * The inside of a studio item card — a 16:9 cover, the name, an optional
 * muted subtitle line, and one muted meta line with the viewer's role at its
 * right end. The card around it (link
 * or button, border, `⋯` menu) belongs to each caller, because the Recent
 * landing and the studio Projects tab react to a click differently.
 * @param props the cover, name, subtitle, meta content and role.
 * @param props.thumbnailUrl the cover image URL, or null.
 * @param props.name the item name.
 * @param props.subtitle the line under the name, when there is one.
 * @param props.meta the left part of the meta line.
 * @param props.role the translated role name, or null.
 * @returns the card body.
 */
export function ItemCardBody({
  thumbnailUrl,
  name,
  subtitle,
  meta,
  role,
}: ItemCardBodyProps): React.JSX.Element {
  return (
    <>
      <div className='aspect-video w-full bg-muted text-muted-foreground'>
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=''
            className='h-full w-full object-cover'
            loading='lazy'
          />
        ) : (
          <DefaultProjectCover />
        )}
      </div>
      <div className='flex flex-col gap-1 px-3 pb-3 pt-2.5'>
        <div className='truncate text-sm font-medium'>{name}</div>
        {subtitle !== undefined ? (
          <div
            data-testid='item-card-subtitle'
            className='truncate text-xs text-muted-foreground'
          >
            {subtitle}
          </div>
        ) : null}
        <div
          data-testid='item-card-meta'
          className='flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground'
        >
          <div className='flex min-w-0 flex-1 gap-1'>{meta}</div>
          {role ? <span className='shrink-0'>{role}</span> : null}
        </div>
      </div>
    </>
  );
}
