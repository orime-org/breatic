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
import {
  ChevronDown,
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
  Sparkles,
} from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { DocumentBubbleMenu } from '@web/spaces/document/document-bubble-menu';
import { UNAVAILABLE } from '@web/spaces/document/document-coming-tool';
import {
  BLOCK_TYPE_ITEMS,
  blockTypeItem,
  currentBlockType,
} from '@web/spaces/document/document-block-type';
import { BUBBLE_CONTROL_HEIGHT } from '@web/spaces/document/document-tool-button';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';

/**
 * Says a control was pressed before anyone wrote the command behind it.
 *
 * The console rather than the screen: these controls look and behave the way
 * the demo draws them, and the product is not launched, so a reader is not
 * told anything (user 2026-08-26). Whoever is holding the browser open sees
 * which command they reached.
 * @param what - The control that was pressed.
 */
function pressedWithNothingBehindIt(what: string): void {
  console.warn(`not implemented yet: ${what}`);
}

/** The shape every slot shares: `.bubble-drop` — 28 tall, 6px either side. */
// `group` is what lets the chevron inside read the trigger's `data-state`.
const SLOT = `group flex ${BUBBLE_CONTROL_HEIGHT} items-center gap-[3px] px-1.5`;

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

/** What every slot receives from the bar, plus what makes it that slot. */
interface SlotShellProps extends SlotProps {
  /** This slot's id, which is also the stem of every test id under it. */
  id: string;
  /** Read out for the opener. */
  label: string;
  /** What the opener draws to the left of its chevron. */
  face: React.ReactNode;
  /**
   * Extra attributes for the opener, for the slots that carry any.
   *
   * `data-*` is spelled out: TypeScript accepts those on a JSX element without
   * being told, and refuses them in an object literal typed by the component's
   * own props.
   */
  openerProps?: React.ComponentProps<typeof Button> & {
    [key: `data-${string}`]: string | undefined;
  };
  /** The menu's rows. */
  children: React.ReactNode;
  /** Extra classes for the menu panel. */
  contentClassName?: string;
}

/**
 * A menu whose contents are rows keeps a gap between them (user 2026-08-27).
 * The colour panel is not rows — its spacing comes from the demo.
 */
const ROWS = 'flex flex-col gap-1';

/**
 * One slot: an opener that ends in a chevron, and the menu it opens.
 *
 * All four are this shape — what differs is the face of the opener and what
 * the menu holds — so the wiring to {@link DocumentBubbleMenu} lives here once.
 * @param props - See {@link SlotShellProps}.
 * @param props.id - This slot's id.
 * @param props.label - Read out for the opener.
 * @param props.face - What the opener draws before its chevron.
 * @param props.openerProps - Extra attributes for the opener.
 * @param props.children - The menu's rows.
 * @param props.contentClassName - Extra classes for the menu panel.
 * @param props.editor - The editor.
 * @param props.container - Which element the menu mounts inside.
 * @param props.scroller - The body's scroller.
 * @param props.openId - Which slot is open.
 * @param props.onOpenChange - Open or close one slot.
 * @returns The slot.
 */
function SlotShell({
  id,
  label,
  face,
  openerProps,
  children,
  contentClassName,
  editor,
  container,
  scroller,
  openId,
  onOpenChange,
}: SlotShellProps): React.JSX.Element {
  // Held rather than written inline. `DocumentBubbleMenu` builds three
  // callbacks and subscribes the scroller off this prop, so a new identity on
  // every render rebuilds all four and re-attaches the listener.
  const change = React.useCallback(
    (open: boolean): void => {
      onOpenChange(id, open);
    },
    [id, onOpenChange],
  );

  return (
    <DocumentBubbleMenu
      id={id}
      editor={editor}
      container={container}
      contentClassName={contentClassName}
      scroller={scroller}
      open={openId === id}
      onOpenChange={change}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={SLOT}
          {...openerProps}
        >
          {face}
          {/* Radix stamps `data-state` on the trigger, so the arrow turns
              over with the menu it opens. */}
          <ChevronDown className='h-[13px] w-[13px] transition-transform group-data-[state=open]:rotate-180' />
        </Button>
      }
    >
      {children}
    </DocumentBubbleMenu>
  );
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
  // An id rather than the row itself: `useEditorState` compares what the
  // selector returns to decide whether to re-render, and a fresh object is
  // never equal to the last one.
  const current = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? currentBlockType(e) : 'paragraph'),
  });
  const CurrentIcon = blockTypeItem(current).Icon;

  return (
    <SlotShell
      id={id}
      label={t('spaces.document.commands.blockType')}
      face={<CurrentIcon className='h-4 w-4' />}
      openerProps={{ 'data-block-type': current }}
      contentClassName={ROWS}
      editor={editor}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      {BLOCK_TYPE_ITEMS.map((item) => {
        const Icon = item.Icon;
        // A row with a command is dimmed only where that command reaches
        // nothing; a row with none is never dimmed on this account.
        const runnable = item.canRun === undefined || item.canRun(editor);
        return (
          <React.Fragment key={item.id}>
            {/* demo:571 rules off the headings from the lists below them. */}
            {item.id === 'bullet-list' ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid={`${id}-item-${item.id}`}
              // The row the selection is already in. Its fill sits one step
              // past hover in the same direction, so hovering it never washes
              // the mark away.
              data-active={item.id === current ? 'true' : undefined}
              aria-disabled={item.greyed || !runnable ? 'true' : undefined}
              className={cn(
                item.id === current && 'bg-active-fill focus:bg-active-fill',
                (item.greyed || !runnable) && UNAVAILABLE,
              )}
              onSelect={() => {
                if (item.run) {
                  if (runnable) item.run(editor);
                  return;
                }
                pressedWithNothingBehindIt(`block type ${item.id}`);
              }}
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
    </SlotShell>
  );
});

/** The alignment menu's three rows, from demo:590-596. */
/**
 * The blocks alignment reaches (demo:606): paragraphs and the three headings.
 *
 * Everywhere else — a quote, either list, a code block — the slot is drawn
 * unavailable (A7). Read off {@link currentBlockType}, which already answers
 * this for the block type slot beside it.
 */
const ALIGNABLE = new Set(['paragraph', 'heading-1', 'heading-2', 'heading-3']);

const ALIGN_ITEMS = [
  { id: 'left', labelKey: 'spaces.document.commands.alignLeft', Icon: TextAlignStart },
  { id: 'center', labelKey: 'spaces.document.commands.alignCenter', Icon: TextAlignCenter },
  { id: 'right', labelKey: 'spaces.document.commands.alignRight', Icon: TextAlignEnd },
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
  const appliesHere = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? ALIGNABLE.has(currentBlockType(e)) : true),
  });
  const askOpen = React.useCallback(
    (slotId: string, open: boolean): void => {
      // A slot drawn as unavailable does not open. The demo's treatment for a
      // control that cannot act cancels the hover as well as the press
      // (demo:463), so a grey cell that still dropped a live menu would be
      // saying two things at once.
      if (open && !appliesHere) return;
      onOpenChange(slotId, open);
    },
    [appliesHere, onOpenChange],
  );

  return (
    <SlotShell
      id={id}
      label={label}
      face={<TextAlignStart className='h-4 w-4' />}
      openerProps={{
        'aria-disabled': appliesHere ? undefined : 'true',
        className: cn(SLOT, !appliesHere && UNAVAILABLE),
      }}
      contentClassName={ROWS}
      editor={editor}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={askOpen}
    >
      {ALIGN_ITEMS.map((item) => (
        <DropdownMenuItem
          key={item.id}
          data-testid={`${id}-item-${item.id}`}
          // Left is where every block already is, so it is the row demo:590
          // draws as active.
          data-active={item.id === 'left' ? 'true' : undefined}
          className={cn(
            item.id === 'left' && 'bg-active-fill focus:bg-active-fill',
          )}
          onSelect={() => {
            pressedWithNothingBehindIt(`align ${item.id}`);
          }}
        >
          <item.Icon />
          {t(item.labelKey)}
        </DropdownMenuItem>
      ))}
    </SlotShell>
  );
});

/** The colour panel's seven hues, from demo 3.5 and the palette. */
const PALETTE = ['red', 'orange', 'green', 'blue', 'violet', 'pink', 'teal'];

/**
 * One cell of either colour row: 30 square, 6px apart, the letter at 15px
 * (demo:241-247). `text-base` is the step that carries 15px
 * (`theme/tokens.css:364`).
 */
const COLOUR_CELL =
  'flex size-[30px] items-center justify-center rounded-content-sm border'
  + ' border-border cursor-pointer hover:border-active-border text-base';

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
  // The panel's cells are buttons laid out in rows rather than menu rows, so
  // the close is theirs to ask for: Radix dismisses on selecting a
  // `DropdownMenuItem` and leaves every other press alone. C2 ends "菜单照常
  // 关闭" and says it for every row alike.
  const pick = React.useCallback(
    (what: string): void => {
      pressedWithNothingBehindIt(what);
      onOpenChange(id, false);
    },
    [onOpenChange],
  );

  return (
    <SlotShell
      id={id}
      label={label}
      face='A'
      openerProps={{ className: `${SLOT} font-semibold` }}
      editor={editor}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      <DropdownMenuLabel>
        {t('spaces.document.commands.textColor')}
      </DropdownMenuLabel>
      <div className='flex gap-1.5 px-2 pb-3.5'>
        {/* The default sits first and reads as the one in force, since nothing
            has coloured the text (demo:665). */}
        <Button
          variant={null}
          size={null}
          tabIndex={-1}
          data-testid={`${id}-text-default`}
          data-selected='true'
          className={cn(COLOUR_CELL, 'border-palette-blue font-semibold')}
          onClick={() => {
            pick('text colour default');
          }}
        >
          A
        </Button>
        {PALETTE.map((hue) => (
          <Button
            key={hue}
            variant={null}
            size={null}
            tabIndex={-1}
            data-testid={`${id}-text-${hue}`}
            className={cn(COLOUR_CELL, 'font-semibold')}
            style={{ color: `var(--color-palette-${hue})` }}
            onClick={() => {
              pick(`text colour ${hue}`);
            }}
          >
            A
          </Button>
        ))}
      </div>
      <DropdownMenuLabel>
        {t('spaces.document.commands.fillColor')}
      </DropdownMenuLabel>
      <div className='flex gap-1.5 px-2 pb-1'>
        {/* No background, drawn as the struck-through cell demo:252-260 draws,
            and likewise the one in force. */}
        <Button
          variant={null}
          size={null}
          tabIndex={-1}
          data-testid={`${id}-fill-none`}
          data-selected='true'
          onClick={() => {
            pick('background colour none');
          }}
          className={cn(
            COLOUR_CELL,
            'relative overflow-hidden border-palette-blue bg-background',
            'after:absolute after:-inset-x-1 after:top-1/2 after:border-t'
            + ' after:border-muted-foreground after:[content:""]'
            + ' after:[transform:rotate(-38deg)]',
          )}
        />
        {PALETTE.map((hue) => (
          <Button
            key={hue}
            variant={null}
            size={null}
            tabIndex={-1}
            data-testid={`${id}-fill-${hue}`}
            className={COLOUR_CELL}
            style={{
              background: `color-mix(in srgb, var(--color-palette-${hue}) 14%, transparent)`,
            }}
            onClick={() => {
              pick(`background colour ${hue}`);
            }}
          />
        ))}
      </div>
      {/* Takes both marks off the selection, once there are marks to take off
          (demo:695). */}
      <div className='px-2 pb-1 pt-0.5'>
        <Button
          variant='outline'
          size={null}
          data-testid={`${id}-reset`}
          tabIndex={-1}
          className='h-8 w-full text-sm'
          onClick={() => {
            pick('colour reset');
          }}
        >
          {t('spaces.document.commands.colorReset')}
        </Button>
      </div>
    </SlotShell>
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
  editor,
  container,
  scroller,
  openId,
  onOpenChange,
}: SlotProps): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-ai';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.ai'),
  });

  return (
    <SlotShell
      id={id}
      label={label}
      face={(
        <>
          <Sparkles className='h-4 w-4' />
          {t('spaces.document.commands.ai')}
        </>
      )}
      contentClassName={ROWS}
      editor={editor}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      {AI_GROUPS.map((group) => (
        <React.Fragment key={group.labelKey}>
          <DropdownMenuLabel>{t(group.labelKey)}</DropdownMenuLabel>
          {group.items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              data-testid={`doc-bubble-ai-item-${item.id}`}
              onSelect={() => {
                pressedWithNothingBehindIt(`ai ${item.id}`);
              }}
            >
              {t(item.labelKey)}
            </DropdownMenuItem>
          ))}
        </React.Fragment>
      ))}
    </SlotShell>
  );
});
