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
  DropdownMenuLabel,
  DropdownMenuShortcut,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { DocumentBubbleMenu } from '@web/spaces/document/document-bubble-menu';
import { UNAVAILABLE } from '@web/spaces/document/document-coming-tool';
import {
  BLOCK_TYPE_ITEMS,
  currentBlockTypeItem,
} from '@web/spaces/document/document-block-type';
import { BUBBLE_CONTROL_HEIGHT } from '@web/spaces/document/document-tool-button';

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
          <DropdownMenuItem
            key={item.id}
            data-testid={`${id}-item-${item.id}`}
            aria-disabled={runnable ? undefined : 'true'}
            className={runnable ? undefined : UNAVAILABLE}
            onSelect={(event) => {
              if (!runnable) {
                event.preventDefault();
                return;
              }
              item.run?.(editor);
            }}
          >
            <Icon />
            {t(item.labelKey)}
            {item.shortcut ? (
              <DropdownMenuShortcut data-testid={`${id}-shortcut-${item.id}`}>
                {item.shortcut}
              </DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        );
      })}
    </DocumentBubbleMenu>
  );
});

/** The alignment menu's three rows, from demo:590-596. */
const ALIGN_ITEMS = [
  { id: 'left', labelKey: 'spaces.document.commands.alignLeft' },
  { id: 'center', labelKey: 'spaces.document.commands.alignCenter' },
  { id: 'right', labelKey: 'spaces.document.commands.alignRight' },
];

/**
 * The alignment slot.
 *
 * Neither the slot nor its three rows reach a command this time round:
 * alignment needs a new schema attribute, which is task #905.
 * @param props - See {@link SlotProps}.
 * @returns The slot.
 */
export const AlignSlot = React.memo(function AlignSlot({
  container,
  scroller,
  openId,
  onOpenChange,
}: Omit<SlotProps, 'editor'>): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-align';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.align'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
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
      {ALIGN_ITEMS.map((item) => (
        <DropdownMenuItem
          key={item.id}
          data-testid={`${id}-item-${item.id}`}
          aria-disabled='true'
          className={UNAVAILABLE}
          onSelect={(event) => {
            event.preventDefault();
          }}
        >
          {t(item.labelKey)}
        </DropdownMenuItem>
      ))}
    </DocumentBubbleMenu>
  );
});

/** The colour panel's seven hues, from demo 3.5 and the palette. */
const PALETTE = ['red', 'orange', 'green', 'blue', 'violet', 'pink', 'teal'];

/**
 * The colour slot.
 *
 * Its opener is the letter A and a chevron (demo:506-509). The panel holds two
 * rows of seven: the text row colours the A, the background row is a swatch
 * (demo 3.5). No command behind it this time round — task #905.
 * @param props - See {@link SlotProps}.
 * @returns The slot.
 */
export const ColorSlot = React.memo(function ColorSlot({
  container,
  scroller,
  openId,
  onOpenChange,
}: Omit<SlotProps, 'editor'>): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-color';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.color'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
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
      <DropdownMenuLabel>
        {t('spaces.document.commands.textColor')}
      </DropdownMenuLabel>
      <div className='flex gap-1 px-2 pb-1'>
        {PALETTE.map((hue) => (
          <span
            key={hue}
            data-testid={`${id}-text-${hue}`}
            className={`${UNAVAILABLE} flex size-6 items-center justify-center rounded-chrome font-semibold`}
            style={{ color: `var(--color-palette-${hue})` }}
          >
            A
          </span>
        ))}
      </div>
      <DropdownMenuLabel>
        {t('spaces.document.commands.fillColor')}
      </DropdownMenuLabel>
      <div className='flex gap-1 px-2 pb-1'>
        {PALETTE.map((hue) => (
          <span
            key={hue}
            data-testid={`${id}-fill-${hue}`}
            className={`${UNAVAILABLE} size-6 rounded-chrome`}
            style={{
              background: `color-mix(in srgb, var(--color-palette-${hue}) 14%, transparent)`,
            }}
          />
        ))}
      </div>
    </DocumentBubbleMenu>
  );
});

/** The AI menu's eight commands in three groups, from the ruling §3.2.1. */
const AI_GROUPS = [
  {
    labelKey: 'spaces.document.commands.aiRewriteGroup',
    // Each row spells its key out. A template built from the id would read the
    // same at runtime and vanish from the scan that finds dead catalog entries,
    // so every one of these eight would look unused.
    items: [
      { id: 'refine', labelKey: 'spaces.document.commands.ai_refine' },
      { id: 'expand', labelKey: 'spaces.document.commands.ai_expand' },
      { id: 'shorten', labelKey: 'spaces.document.commands.ai_shorten' },
      { id: 'translate', labelKey: 'spaces.document.commands.ai_translate' },
      { id: 'tone', labelKey: 'spaces.document.commands.ai_tone' },
    ],
  },
  {
    labelKey: 'spaces.document.commands.aiProduceGroup',
    items: [
      { id: 'storyboard', labelKey: 'spaces.document.commands.ai_storyboard' },
      { id: 'illustrate', labelKey: 'spaces.document.commands.ai_illustrate' },
    ],
  },
  {
    labelKey: 'spaces.document.commands.aiOtherGroup',
    items: [{ id: 'custom', labelKey: 'spaces.document.commands.ai_custom' }],
  },
];

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
  container,
  scroller,
  openId,
  onOpenChange,
}: Omit<SlotProps, 'editor'>): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-coming-ai';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.ai'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
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
      {AI_GROUPS.map((group) => (
        <React.Fragment key={group.labelKey}>
          <DropdownMenuLabel>{t(group.labelKey)}</DropdownMenuLabel>
          {group.items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              data-testid={`doc-bubble-ai-item-${item.id}`}
              aria-disabled='true'
              className={UNAVAILABLE}
              onSelect={(event) => {
                event.preventDefault();
              }}
            >
              {t(item.labelKey)}
            </DropdownMenuItem>
          ))}
        </React.Fragment>
      ))}
    </DocumentBubbleMenu>
  );
});
