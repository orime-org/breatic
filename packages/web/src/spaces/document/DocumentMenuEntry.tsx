// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The entry at the body's top-right corner: commands whose object is the WHOLE
 * document, behind one `⋯` button.
 *
 * The routing rule behind it (design §3.0): a command goes to the carrier that
 * matches what it acts on. Commands acting on a selection or on the block it
 * sits in are on the bubble bar; whole-document ones had nowhere to go once
 * the top bar went away, and this entry is where they landed. Export, document settings and a button for
 * `clearDocument` all belong here when they arrive.
 *
 * ## Why one entry rather than a column of buttons
 *
 * The menu-system ruling's §2.1 survey puts whole-document commands behind a
 * single "…" in five of the six products it looked at (Notion, Google Docs,
 * Coda, Confluence, Craft), and it is the shape the block handle takes: one
 * grip, click for a menu. It also keeps the
 * gutter constant — the body's side padding is sized to what stands in it, and
 * a column of buttons would widen with every command added.
 */

import { Camera, History, MessageSquareText, MoreHorizontal } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';

interface DocumentMenuEntryProps {
  /** Whether the comment panel is on screen, which takes this row away. */
  commentsOpen: boolean;
  /** Opens the comment panel; closing it is the panel's own button. */
  onOpenComments: () => void;
  /**
   * How many threads in this document are unresolved.
   *
   * It marks the button while the panel is shut, which is the only thing a
   * comment arriving from a peer is allowed to change on screen (A5 · A15),
   * and it is what the row says the panel holds.
   */
  unresolvedComments: number;
  /** Whether the snapshot panel is on screen, which takes this row away too. */
  versionsOpen: boolean;
  /** Opens the dialog that saves a snapshot, or null where the user cannot save (a viewer). */
  onSaveSnapshot: (() => void) | null;
  /** Opens the snapshot panel, or null where the document has none. */
  onRestoreSnapshot: (() => void) | null;
}

/**
 * The whole-document command entry.
 * @param root0 - Entry props.
 * @param root0.commentsOpen - Whether the comment panel is on screen.
 * @param root0.onOpenComments - Opens it.
 * @param root0.unresolvedComments - How many threads are unresolved.
 * @param root0.versionsOpen - Whether the snapshot panel is on screen.
 * @param root0.onSaveSnapshot - Saves a snapshot, when the user may.
 * @param root0.onRestoreSnapshot - Opens the snapshot panel.
 * @returns The trigger and its menu.
 */
export const DocumentMenuEntry = React.memo(
  function DocumentMenuEntry({
    commentsOpen,
    onOpenComments,
    unresolvedComments,
    versionsOpen,
    onSaveSnapshot,
    onRestoreSnapshot,
  }: DocumentMenuEntryProps): React.JSX.Element | null {
    const t = useTranslation();
    // The way in stands aside once what it opens is on screen. The room on a
    // document page is finite: with the panel taking a column, a button
    // offering to open it again is spending space on nothing. Reaching
    // anything else in here means closing the panel first, which its own
    // button does (user 2026-09-22) — and that holds however many commands
    // this menu grows, the snapshot panel included.
    if (commentsOpen || versionsOpen) return null;

    // What the row says the panel holds: how much is waiting in it, else
    // that there is nothing. The row is only drawn while the panel is shut,
    // so it never has to say that it is open.
    const tail =
      unresolvedComments > 0
        ? t('spaces.document.docMenu.commentsUnresolved', {
          count: unresolvedComments,
        })
        : t('spaces.document.docMenu.commentsNone');
    return (
      // Sticky rather than absolute, and rendered inside the scroller: the
      // wheel then reaches the body the way the browser does it for everything
      // else, and the button keeps its corner while the text scrolls under it.
      // Zero height keeps it out of the flow. The negative margin is the
      // button plus the clearance, which is everything between the padding
      // box's right edge and the button's own right edge — so the button lands
      // in the gutter with the clearance on its left and the inset between it
      // and the viewport edge (`BODY_ROW_VARS`, `document-columns.ts`).
      <div className='sticky top-5 z-10 mr-[calc((var(--doc-entry-size)+var(--doc-entry-clearance))*-1)] flex h-0 justify-end'>
        {/* `modal={false}`, same reason as the canvas's left floating menu: a
            modal menu puts `pointer-events: none` on the body, so the click
            that dismisses it is swallowed instead of reaching what was
            clicked. Here that click is nearly always the body — someone
            opening the menu, deciding against it, and going back to writing.
            Modal, they had to click twice: once to dismiss (focus went to the
            trigger), once to put the caret back (measured 2026-08-22). */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant='ghost'
              size='icon'
              aria-label={t('spaces.document.docMenu.label')}
              data-testid='doc-doc-menu-trigger'
              className='size-[var(--doc-entry-size)]'
            >
              <MoreHorizontal className='h-4 w-4' />
              {/* The dot the panel's absence is announced with. Inside the
                  button so it travels with it, and `pointer-events-none` so
                  it never takes the press.

                  `status-info` rather than the palette blue it aliases: the
                  palette lives in `:root` rather than in `@theme`, so
                  `bg-palette-blue` is not a class Tailwind generates and the
                  dot came out transparent — measured in the browser, which is
                  the only place a missing utility shows. The alias is the same
                  colour and is what the status dots elsewhere already use. */}
              {unresolvedComments > 0 && (
                <span
                  data-testid='doc-doc-menu-dot'
                  className='pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-status-info'
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='min-w-[190px]'>
            <DropdownMenuItem
              data-testid='doc-doc-menu-comments'
              onSelect={onOpenComments}
            >
              <span className='flex flex-1 items-center gap-2'>
                <MessageSquareText className='h-4 w-4' />
                {t('spaces.document.docMenu.comments')}
                <span
                  data-testid='doc-doc-menu-comments-tail'
                  className='ml-auto text-2xs text-muted-foreground'
                >
                  {tail}
                </span>
              </span>
            </DropdownMenuItem>
            {(onSaveSnapshot !== null || onRestoreSnapshot !== null) && <DropdownMenuSeparator />}
            {/* A viewer has nothing to save, so the row is not drawn for one,
                as with every other writing entry a viewer meets. */}
            {onSaveSnapshot !== null && (
              <DropdownMenuItem data-testid='doc-doc-menu-save-snapshot' onSelect={onSaveSnapshot}>
                <span className='flex flex-1 items-center gap-2'>
                  <Camera className='h-4 w-4' />
                  {t('spaces.document.docMenu.saveSnapshot')}
                </span>
              </DropdownMenuItem>
            )}
            {onRestoreSnapshot !== null && (
              <DropdownMenuItem data-testid='doc-doc-menu-restore-snapshot' onSelect={onRestoreSnapshot}>
                <span className='flex flex-1 items-center gap-2'>
                  <History className='h-4 w-4' />
                  {t('spaces.document.docMenu.restoreSnapshot')}
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
);
