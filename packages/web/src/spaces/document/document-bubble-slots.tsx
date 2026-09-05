// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bar's four hover-opened slots: block type, alignment, colour, AI.
 *
 * All four share the shell in {@link DocumentBubbleMenu} — open and close,
 * focus, the wheel, scroll-closes-it all live there. This file is only about
 * what each slot looks like and what its menu holds.
 *
 * All nine rows of the block type menu reach a command. Everything else here
 * is drawn the way the demo draws them and writes a line to the console when
 * pressed, the menu closing after them either way (user 2026-08-27).
 *
 * Two things carry the greyed treatment `document-coming-tool.tsx` defines:
 * the block type menu over a selection no row can act on (§6.7), judged only
 * while the menu is down, and the alignment slot over a selection alignment
 * does not reach (A7).
 */

import * as React from 'react';
import {
  Check,
  ChevronDown,
  TextAlignStart,
  TextAlignCenter,
  TextAlignEnd,
  Sparkles,
} from 'lucide-react';
import type { BlockNoteEditor } from '@blocknote/core';

import { Button } from '@web/components/ui/button';
import { DropdownMenuShortcut } from '@web/components/ui/dropdown-menu';
import {
  BubbleMenuHeading,
  BubbleMenuRow,
  BubbleMenuRule,
} from '@web/spaces/document/document-bubble-rows';
import { useTranslation } from '@web/i18n/use-translation';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';
import { cn } from '@web/lib/utils';
import { DocumentBubbleMenu } from '@web/spaces/document/document-bubble-menu';
import { UNAVAILABLE } from '@web/spaces/document/document-coming-tool';
import {
  BLOCK_TYPE_ITEMS,
  blockTypeItem,
} from '@web/spaces/document/document-block-type';
import { printedShortcut } from '@web/spaces/document/document-block-type-shortcuts';
import {
  DIMENSION_OF_ROW,
  faceOf,
  tickedOver,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';
import {
  canRunBlockType,
  runBlockType,
} from '@web/spaces/document/document-block-run';
import { selectionCanAlign } from '@web/spaces/document/document-align-model';
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

/** The document editor, as far as a slot needs to know. */
export type SlotEditor = BlockNoteEditor<never, never, never>;

/**
 * Whether two id sets hold the same members.
 * @param a - One set.
 * @param b - The other.
 * @returns True when they match.
 */
function sameIds(a: Set<BlockTypeId>, b: Set<BlockTypeId>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/** What every slot receives from the bar. */
interface SlotProps {
  editor: SlotEditor;
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
interface SlotShellProps extends Omit<SlotProps, 'editor'> {
  /** This slot's id, which is also the stem of every test id under it. */
  id: string;
  /** Read out for the opener. */
  label: string;
  /** What the opener draws to the left of its chevron. */
  face: React.ReactNode;
  /**
   * Extra attributes for the opener, for the slots that carry any.
   *
   * Added to the slot shape rather than replacing it: these are spread FIRST,
   * so the shape's own attributes — its label, its test id, its place outside
   * the tab order (R4) — stand whatever a slot passes, and `className` is
   * appended to the shape's classes.
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

/** The colour panel's own group label, at the demo's `.color-group-label` size and colour. */
const COLOUR_GROUP_LABEL = 'px-2 pb-2 text-xs text-muted-foreground';

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
      container={container}
      contentClassName={contentClassName}
      scroller={scroller}
      open={openId === id}
      onOpenChange={change}
      trigger={
        <Button
          {...openerProps}
          variant='ghost'
          size={null}
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={cn(SLOT, openerProps?.className)}
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
 * follow the demo's block type menu, each carrying a shortcut column.
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
  const current = useEditorSnapshot(editor, (e) =>
    faceOf(e.prosemirrorState.doc, e.prosemirrorState.selection),
  );
  // Compared by membership, so a fresh Set every read costs nothing and the
  // reference stays put — a set rebuilt per read is never the same object.
  const marked = useEditorSnapshot(
    editor,
    (e) => tickedOver(e.prosemirrorState.doc, e.prosemirrorState.selection),
    sameIds,
  );
  // Whether any row can act at all. On the flat model every block can become
  // any of the nine, so the rows are live together; what greys them is a
  // selection that covers no text block — a stand-in for content this build
  // cannot read is the reachable case.
  //
  // Asked on every change the menu is down for, and on none of the ones it is
  // shut for. The press reads the state it is given at the moment of the
  // press, so an answer from when the menu opened could draw a row greyed
  // while the press behind it goes through.
  const open = openId === id;
  const reachable = useEditorSnapshot(editor, (e) =>
    open ? canRunBlockType(e) : true,
  );
  const CurrentIcon = blockTypeItem(current).Icon;

  return (
    <SlotShell
      id={id}
      label={t('spaces.document.commands.blockType')}
      face={<CurrentIcon className='h-4 w-4' />}
      openerProps={{ 'data-block-type': current }}
      contentClassName={ROWS}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      {BLOCK_TYPE_ITEMS.map((item, index) => {
        const Icon = item.Icon;
        const shortcut = printedShortcut(item.id);
        const nextRow = BLOCK_TYPE_ITEMS[index + 1]?.id;
        return (
          <React.Fragment key={item.id}>
            <BubbleMenuRow
              data-testid={`${id}-item-${item.id}`}
              aria-disabled={reachable ? undefined : 'true'}
              className={cn(!reachable && UNAVAILABLE)}
              onSelect={() => {
                runBlockType(editor, item.id);
              }}
            >
              <Icon />
              {/* The demo gives the label the row's spare width
                  (`.row .name { flex: 1 }`), so the shortcut and the tick sit
                  at the right edge on every row. Leaving it to
                  `DropdownMenuShortcut`'s own `ml-auto` would right-align only
                  the rows that print a chord. */}
              <span className='flex-1 text-left'>{t(item.labelKey)}</span>
              {shortcut ? (
                <DropdownMenuShortcut data-testid={`${id}-shortcut-${item.id}`}>
                  {formatShortcut(shortcut)}
                </DropdownMenuShortcut>
              ) : null}
              {/* The tick goes after the shortcut, where the demo draws it,
                  and every row carries the column whether or not it is ticked
                  (the demo's `.row .tick`) — otherwise the ticked row lays out
                  narrower than the rest and its shortcut leaves the line the
                  others sit on. `components/ui/dropdown-menu`'s checkbox item
                  puts its mark on the left instead, so this row keeps that
                  component's glyph at that weight in the demo's place. */}
              <span
                data-testid={`${id}-tickcol-${item.id}`}
                className='ml-1 flex size-4 shrink-0 items-center justify-center'
              >
                {marked.has(item.id) ? (
                  <Check
                    data-testid={`${id}-tick-${item.id}`}
                    className='size-4'
                    strokeWidth={3}
                  />
                ) : null}
              </span>
            </BubbleMenuRow>
            {/* The demo's `.menu-sep`, drawn wherever the order crosses from
                one of the three dimensions to the next. Read off
                `DIMENSION_OF_ROW` rather than written out here, so a row added
                to a group lands inside its rules by saying which group it is
                in — the one place that already has to say so. */}
            {nextRow !== undefined &&
            DIMENSION_OF_ROW[item.id] !== DIMENSION_OF_ROW[nextRow]
              ? <BubbleMenuRule />
              : null}
          </React.Fragment>
        );
      })}
    </SlotShell>
  );
});

/** The alignment menu's three rows, from the demo's alignment menu. */
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
  const appliesHere = useEditorSnapshot(editor, selectionCanAlign);
  const askOpen = React.useCallback(
    (slotId: string, open: boolean): void => {
      // A slot drawn as unavailable does not open. The demo's treatment for a
      // control that cannot act cancels the hover as well as the press
      // (the demo's note on its greyed rows), so a grey cell that still dropped a
      // live menu would be
      // saying two things at once.
      if (open && !appliesHere) return;
      onOpenChange(slotId, open);
    },
    [appliesHere, onOpenChange],
  );

  // The selection can move under an open menu — a keyboard selection reaches a
  // block alignment does not act on while the pointer rests on the menu — and
  // the slot greys out where it stands. The menu it dropped goes with it, and
  // the bar's record of which menu is open goes with that: three of its
  // readers take that record to mean a menu is on screen.
  const open = openId === id;
  React.useEffect(() => {
    if (open && !appliesHere) onOpenChange(id, false);
  }, [open, appliesHere, id, onOpenChange]);

  return (
    <SlotShell
      id={id}
      label={label}
      face={<TextAlignStart className='h-4 w-4' />}
      openerProps={{
        'aria-disabled': appliesHere ? undefined : 'true',
        className: cn(!appliesHere && UNAVAILABLE),
      }}
      contentClassName={ROWS}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={askOpen}
    >
      {ALIGN_ITEMS.map((item) => (
        <BubbleMenuRow
          key={item.id}
          data-testid={`${id}-item-${item.id}`}
          // Left is where every block already is, so it is the row the demo
          // draws as active.
          data-active={item.id === 'left' ? 'true' : undefined}
          className={cn(item.id === 'left' && 'bg-accent')}
          onSelect={() => {
            pressedWithNothingBehindIt(`align ${item.id}`);
          }}
        >
          <item.Icon />
          {t(item.labelKey)}
        </BubbleMenuRow>
      ))}
    </SlotShell>
  );
});

/** The colour panel's seven hues, from demo 3.5 and the palette. */
const PALETTE = ['red', 'orange', 'green', 'blue', 'violet', 'pink', 'teal'];

/**
 * One cell of either colour row: 30 square, 6px apart, the letter at 15px
 * (the demo's `.color-cell`). `text-base` is the step that carries 15px
 * (`theme/tokens.css:364`).
 */
const COLOUR_CELL =
  'flex size-[30px] items-center justify-center rounded-content-sm border'
  + ' border-border cursor-default hover:border-active-border text-base';

/**
 * The cell the selection already carries.
 *
 * `status-selected` rather than the demo's blue: the palette lives in `:root`
 * (`theme/tokens.css:47`), so no `border-palette-*` utility is generated, and
 * one written anyway wins the merge against `border-border` and leaves the
 * border on `currentColor`. This token is in `@theme`, and it is what the
 * canvas colour picker marks its own cell with (`GroupBackgroundPicker:91`).
 */
const COLOUR_CELL_ON = 'border-status-selected hover:border-status-selected';

/**
 * The colour slot.
 *
 * Its opener is the letter A and a chevron, the way the demo draws it. The
 * panel holds two
 * rows of eight and a reset button (the demo's `.color-panel`): the text row is
 * a default
 * plus the seven hues, each colouring the letter A; the background row is a
 * "none" cell plus the same seven as swatches. No command behind any of it this
 * time round — task #905.
 * @param props - See {@link SlotProps}.
 * @returns The slot.
 */
export const ColorSlot = React.memo(function ColorSlot({
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
  // The panel's cells are buttons laid out in a grid rather than rows built
  // on `BubbleMenuRow`, so closing is theirs to ask for. Ruling C2 has the
  // menu close on every press alike, command behind the cell or not.
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
      openerProps={{ className: 'font-semibold' }}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      <div className={COLOUR_GROUP_LABEL}>
        {t('spaces.document.commands.textColor')}
      </div>
      <div className='flex gap-1.5 px-2 pb-3.5'>
        {/* The default sits first and reads as the one in force, since nothing
            has coloured the text (the demo marks it `data-selected`). */}
        <Button
          variant={null}
          size={null}
          tabIndex={-1}
          data-testid={`${id}-text-default`}
          data-selected='true'
          className={cn(
            COLOUR_CELL,
            COLOUR_CELL_ON,
            'font-semibold',
          )}
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
      <div className={COLOUR_GROUP_LABEL}>
        {t('spaces.document.commands.fillColor')}
      </div>
      <div className='flex gap-1.5 px-2 pb-3.5'>
        {/* No background, drawn as the demo's `.color-cell-none` is,
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
            COLOUR_CELL_ON,
            'relative overflow-hidden bg-background',
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
          (the demo's `.color-reset`). */}
      <div className='px-2 pb-1 pt-0.5'>
        <Button
          variant='outline'
          size={null}
          data-testid={`${id}-reset`}
          tabIndex={-1}
          // No fill of its own: it sits on the popover, and `outline`'s
          // `bg-background` is the page's ground, a step darker than the panel
          // under it (the demo's `.color-reset` is transparent).
          className='h-8 w-full bg-transparent text-sm'
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
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      {AI_GROUPS.map((group) => (
        <React.Fragment key={group.labelKey}>
          <BubbleMenuHeading>{t(group.labelKey)}</BubbleMenuHeading>
          {group.items.map((item) => (
            <BubbleMenuRow
              key={item.id}
              data-testid={`doc-bubble-ai-item-${item.id}`}
              onSelect={() => {
                pressedWithNothingBehindIt(`ai ${item.id}`);
              }}
            >
              {t(item.labelKey)}
            </BubbleMenuRow>
          ))}
        </React.Fragment>
      ))}
    </SlotShell>
  );
});
