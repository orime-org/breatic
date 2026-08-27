// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bar's four hover-opened slots: block type, alignment, colour, AI.
 *
 * All four share the shell in {@link DocumentBubbleMenu} — open and close,
 * focus, the wheel, scroll-closes-it all live there. This file is only about
 * what each slot looks like and what its menu holds.
 *
 * Three rows in the block type menu reach a command this time round (bulleted
 * list, numbered list, quote — the three that sit on the bar today); everything
 * else carries the not-open-yet treatment `document-coming-tool.tsx` defines
 * (user 2026-08-23's rule, which user 2026-08-26 confirmed still stands).
 */

import * as React from 'react';
import { ChevronDown, TextAlignStart, Sparkles } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { DocumentBubbleMenu } from '@web/spaces/document/document-bubble-menu';
import { UNAVAILABLE } from '@web/spaces/document/document-coming-tool';
import {
  BLOCK_TYPE_ITEMS,
  currentBlockTypeItem,
} from '@web/spaces/document/document-block-type';
import { BUBBLE_CONTROL_HEIGHT } from '@web/spaces/document/document-tool-button';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';

/** The shape every slot shares: `.bubble-drop` — 28 tall, 6px either side. */
const SLOT = `flex ${BUBBLE_CONTROL_HEIGHT} items-center gap-[3px] px-1.5`;

/** What every slot receives from the bar. */
interface SlotProps {
  editor: Editor;
  /** Which element the menu mounts inside; the bar passes itself. */
  container: HTMLElement | null;
  /** The body's scroller. */
  scroller: HTMLElement | null;
  /** Which slot is open; only one is at a time. */
  openId: string | null;
  /** Open or close one slot. */
  onOpenChange: (id: string, open: boolean) => void;
}

/**
 * The block type slot.
 *
 * Its icon tracks the current block (user 2026-08-26); the menu's nine rows
 * follow demo:560-588, seven of them carrying a shortcut column.
 * @param props - See {@link SlotProps}.
 * @returns The slot.
 */
export const BlockTypeSlot = React.memo(function BlockTypeSlot({
  editor,
  container,
  scroller,
  openId,
  onOpenChange,
}: SlotProps): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-block-type';
  const current = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? currentBlockTypeItem(e).id : 'paragraph'),
  });
  const CurrentIcon =
    BLOCK_TYPE_ITEMS.find((item) => item.id === current)?.Icon ??
    BLOCK_TYPE_ITEMS[0].Icon;

  return (
    <DocumentBubbleMenu
      id={id}
      editor={editor}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-label={t('spaces.document.commands.blockType')}
          data-testid={id}
          data-block-type={current}
          tabIndex={-1}
          className={SLOT}
        >
          <CurrentIcon className='h-4 w-4' />
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      {BLOCK_TYPE_ITEMS.map((item) => {
        const Icon = item.Icon;
        const runnable = item.run !== undefined;
        return (
          <React.Fragment key={item.id}>
            {/* demo:571 rules off the headings from the lists below them. */}
            {item.id === 'bullet-list' ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid={`${id}-item-${item.id}`}
              // The row the selection is already in, marked the way demo:560
              // marks it (`.menu-item[data-active="true"]` takes
              // `--color-muted`).
              data-active={item.id === current ? 'true' : undefined}
              aria-disabled={runnable ? undefined : 'true'}
              className={cn(
                item.id === current && 'bg-muted',
                !runnable && UNAVAILABLE,
              )}
              onSelect={runnable ? () => {
                item.run?.(editor);
              } : undefined}
            >
              <Icon />
              {t(item.labelKey)}
              {item.shortcut ? (
                <DropdownMenuShortcut data-testid={`${id}-shortcut-${item.id}`}>
                  {formatShortcut(item.shortcut)}
                </DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          </React.Fragment>
        );
      })}
    </DocumentBubbleMenu>
  );
});

/**
 * What a menu holds while its commands are not there yet.
 *
 * One line, and nothing else. The demo draws each of these menus filled in —
 * three alignments, a colour panel, nine AI commands — and each of those
 * arrives with the task that implements it (#905 for alignment and colour, the
 * ruling §3.3 routes the AI ones). Until then the menu says so rather than
 * standing there full of rows that answer a press with nothing (user
 * 2026-08-26).
 * @returns The line.
 */
function NotImplementedYet(): React.JSX.Element {
  const t = useTranslation();
  return (
    <DropdownMenuItem
      data-testid='doc-bubble-not-implemented'
      aria-disabled='true'
      className={UNAVAILABLE}
    >
      {t('spaces.document.commands.notImplemented')}
    </DropdownMenuItem>
  );
}

/**
 * The alignment slot.
 *
 * Neither the slot nor its three rows reach a command this time round:
 * alignment needs a new schema attribute, which is task #905.
 * @param props - See {@link SlotProps}.
 * @returns The slot.
 */
export const AlignSlot = React.memo(function AlignSlot({
  editor,
  container,
  scroller,
  openId,
  onOpenChange,
}: SlotProps): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-align';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.align'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
      editor={editor}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-disabled='true'
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={`${SLOT} ${UNAVAILABLE}`}
        >
          <TextAlignStart className='h-4 w-4' />
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      <NotImplementedYet />
    </DocumentBubbleMenu>
  );
});

/**
 * The colour slot.
 *
 * Its opener is the letter A and a chevron (demo:506-509). The panel holds two
 * rows of eight and a reset button (demo:693-695): the text row is a default
 * plus the seven hues, each colouring the letter A; the background row is a
 * "none" cell plus the same seven as swatches. No command behind any of it this
 * time round — task #905.
 * @param props - See {@link SlotProps}.
 * @returns The slot.
 */
export const ColorSlot = React.memo(function ColorSlot({
  editor,
  container,
  scroller,
  openId,
  onOpenChange,
}: SlotProps): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-color';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.color'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
      editor={editor}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-disabled='true'
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={`${SLOT} ${UNAVAILABLE} font-semibold`}
        >
          A
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      <NotImplementedYet />
    </DocumentBubbleMenu>
  );
});

/**
 * The AI slot.
 *
 * Its shape is the ruling's (§3.2.1): icon, the word AI, chevron, and hovering
 * it opens a list of commands below. None of the eight reach anything this time
 * round; each arrives with its own task (the ruling §3.3 routes them).
 * @param props - See {@link SlotProps}.
 * @returns The slot.
 */
export const AiSlot = React.memo(function AiSlot({
  editor,
  container,
  scroller,
  openId,
  onOpenChange,
}: SlotProps): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-coming-ai';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.ai'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
      editor={editor}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-disabled='true'
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={`${SLOT} ${UNAVAILABLE}`}
        >
          <Sparkles className='h-4 w-4' />
          {t('spaces.document.commands.ai')}
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      <NotImplementedYet />
    </DocumentBubbleMenu>
  );
});
