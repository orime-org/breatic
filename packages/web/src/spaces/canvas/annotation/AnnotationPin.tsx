// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A collapsed annotation: a 28px bubble with the face of whoever raised it,
 * its tail tip on the point it was left at.
 *
 * This is what a note is almost all of the time (#1881 §8.7) — the sticky is
 * what the reader gets when they open it. The face is fixed on the AUTHOR
 * rather than on whoever replied last, which would change with every reply and
 * leave the same pin wearing a different person each time; A11 names the
 * author on the sticky for the same reason.
 *
 * Not a `NodeShell`: that gives a squared card, a status border, a lock mark in
 * the top-right corner and `overflow-hidden` — and the last would clip exactly
 * the two badges this draws outside its own edge.
 *
 * **Two boxes, on purpose.** The outer one is what xyflow measures, so it
 * carries the size in FLOW pixels (`pinFlowSize`); the inner one is the pin as
 * designed, at its natural 28px, scaled to fill the outer. Everything inside
 * therefore keeps ordinary fixed sizes — the border stays a hairline, the
 * badges stay legible — and still lands on screen at the size it was drawn. No
 * per-badge counter-scale, and no floor to step over.
 */

import * as React from 'react';
import { Lock } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import {
  PIN_SCREEN_SIZE,
  pinFlowSize,
} from '@web/spaces/canvas/annotation/pin-geometry';
import { StudioAvatar } from '@web/ui/StudioAvatar';

export interface AnnotationPinProps {
  /** The author's display name, or an empty string while the name loads. */
  authorName: string;
  /** The author's uploaded avatar, or null for their initials. */
  avatarUrl: string | null;
  /** How many replies are under this note; no badge at zero. */
  replyCount: number;
  /** The current canvas zoom, which decides the box's flow size. */
  zoom: number;
  /** Whether this note is frozen (no Group can hold one, so only its own). */
  locked?: boolean;
  /** Whether the node is selected, driving the selection ring. */
  selected?: boolean;
  /** Open this note's sticky, or close it when it is already open. */
  onToggle: () => void;
}

/**
 * Draw the pin a collapsed annotation is.
 * @param props - Who wrote it, how many answered, and the current zoom.
 * @returns The pin element.
 */
export function AnnotationPin(props: AnnotationPinProps): React.JSX.Element {
  const { authorName, avatarUrl, replyCount, zoom, locked, selected, onToggle } =
    props;
  const flowSize = pinFlowSize(zoom);

  return (
    <Button
      variant={null}
      size={null}
      // Flow pixels: this element is the one xyflow measures.
      style={{ width: flowSize, height: flowSize }}
      className='group relative block bg-transparent p-0 focus-visible:ring-0'
      data-testid='annotation-pin'
      onClick={onToggle}
    >
      <span
        // The pin as designed, scaled to fill the box above. The tail points
        // down-left at the node's own coordinate, the same way the bubble
        // cursor points while the tool is armed.
        style={{
          width: PIN_SCREEN_SIZE,
          height: PIN_SCREEN_SIZE,
          transform: `scale(${flowSize / PIN_SCREEN_SIZE})`,
          transformOrigin: 'top left',
        }}
        className={cn(
          'absolute left-0 top-0 flex items-center justify-center',
          'rounded-full rounded-bl-[2px] border border-note-border bg-note',
          'group-hover:brightness-[.97]',
          'group-focus-visible:outline group-focus-visible:outline-1 group-focus-visible:outline-offset-1 group-focus-visible:outline-ring',
          selected === true &&
            'outline outline-1 outline-offset-1 outline-active-border',
        )}
        data-testid='annotation-pin-face'
      >
        {authorName.length === 0 ? (
          // Nobody named yet: the request is in flight, or the account is
          // gone. §8.7.1 asks for a plain ground here — the initials rule
          // answers '?' for a blank name, and a question mark names somebody
          // it does not know.
          <span
            className='size-full rounded-full bg-muted'
            data-testid='annotation-pin-avatar'
          />
        ) : (
          <StudioAvatar
            name={authorName}
            type='personal'
            avatarUrl={avatarUrl}
            size='xs'
            data-testid='annotation-pin-avatar'
          />
        )}
        {replyCount === 0 ? null : (
          // Outside the pin's own edge, top right: on it, it would sit over
          // the face. It answers "has anybody picked this up", which is what
          // decides whether the reader opens the note at all.
          <span
            className='absolute -right-1.5 -top-1.5 min-w-[15px] rounded-full bg-foreground px-1 text-2xs font-semibold leading-[15px] text-background'
            data-testid='annotation-pin-count'
          >
            {replyCount}
          </span>
        )}
        {locked !== true ? null : (
          // Bottom right, so it never shares a corner with the count.
          <span
            aria-hidden='true'
            className='absolute -bottom-1 -right-1 rounded-full bg-muted p-0.5 text-muted-foreground'
            data-testid='annotation-pin-lock'
          >
            <Lock className='h-2.5 w-2.5' />
          </span>
        )}
      </span>
    </Button>
  );
}
