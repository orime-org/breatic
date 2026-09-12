// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The bar's four hover-opened slots: block type, alignment, colour, AI.
 *
 * All four share the shell in {@link DocumentBubbleMenu} — open and close,
 * focus, the wheel, scroll-closes-it all live there. This file is only about
 * what each slot looks like and what its menu holds.
 *
 * Block type, alignment and colour all reach their commands. The AI slot is
 * drawn the way the demo draws it and writes a line to the console when
 * pressed, the menu closing after it either way (user 2026-08-27).
 *
 * Three things carry the greyed treatment `document-coming-tool.tsx` defines:
 * the block type menu over a selection no row can act on, judged only while
 * the menu is down; the alignment slot over a selection alignment does not
 * reach; and the colour slot over a selection that takes no marks (R7).
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
import {
  MIXED_ALIGNMENT,
  NO_ALIGNABLE_BLOCK,
  alignFace,
  runAlignment,
  type Alignment,
} from '@web/spaces/document/document-align-run';
import {
  COLOUR_HUES,
  NO_COLOUR,
  clearColours,
  colourFace,
  setColour,
  type ColourFace,
} from '@web/spaces/document/document-colour-run';
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
  /** Which end of the opener the menu lines up with. */
  align?: 'start' | 'end';
  /**
   * Whether the slot can act on the selection, for the slots that grey.
   *
   * Three things follow from it, and every slot that greys owes all three:
   * take a menu away where the selection has moved somewhere the slot cannot
   * act, draw the opener as unavailable, and say so. Written out per slot they
   * drift — the alignment and colour copies already gave different reasons for
   * the same three lines — and #113 brings a third carrier for these same
   * commands. A slot that always acts leaves this out.
   *
   * Taking the menu away covers a hover of a slot already grey as well as a
   * slot that greys under an open menu: an opener that refused outright made
   * no difference either way, measured in a real browser with a
   * `MutationObserver` on the body — the menu never reaches the DOM, because
   * React runs this effect before it paints.
   */
  appliesHere?: boolean;
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
 * @param props.align - Which end of the opener the menu lines up with.
 * @param props.container - Which element the menu mounts inside.
 * @param props.scroller - The body's scroller.
 * @param props.openId - Which slot is open.
 * @param props.onOpenChange - Open or close one slot.
 * @param props.appliesHere - Whether the slot can act on the selection.
 * @returns The slot.
 */
function SlotShell({
  id,
  label,
  face,
  openerProps,
  children,
  contentClassName,
  align,
  container,
  scroller,
  openId,
  onOpenChange,
  appliesHere,
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

  const open = openId === id;
  const unavailable = appliesHere === false;
  React.useEffect(() => {
    if (open && unavailable) onOpenChange(id, false);
  }, [open, unavailable, id, onOpenChange]);

  return (
    <DocumentBubbleMenu
      id={id}
      container={container}
      contentClassName={contentClassName}
      align={align}
      scroller={scroller}
      open={open}
      onOpenChange={change}
      trigger={
        <Button
          {...openerProps}
          variant='ghost'
          size={null}
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          aria-disabled={unavailable ? 'true' : undefined}
          className={cn(SLOT, openerProps?.className, unavailable && UNAVAILABLE)}
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
              // No fill marks the row the selection is in. The tick is that
              // mark here, and it says something a single-valued fill cannot:
              // an ordered heading ticks Ordered AND its heading level at
              // once (A5), while `item.id === current` names one row.
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
const ALIGN_ITEMS: readonly {
  readonly id: Alignment;
  readonly labelKey: string;
  readonly Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'left', labelKey: 'spaces.document.commands.alignLeft', Icon: TextAlignStart },
  { id: 'center', labelKey: 'spaces.document.commands.alignCenter', Icon: TextAlignCenter },
  { id: 'right', labelKey: 'spaces.document.commands.alignRight', Icon: TextAlignEnd },
];

/**
 * The alignment slot: three rows, one of them the one the selection is on.
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
  const label = t('spaces.document.commands.align');
  // One reading covers both states the slot draws: whether it is live, and
  // which row is lit. Two readers would walk the covered blocks twice per
  // keystroke and could disagree about what is under the selection.
  const face = useEditorSnapshot(editor, alignFace);
  const active = face === MIXED_ALIGNMENT ? undefined : face;
  return (
    <SlotShell
      id={id}
      label={label}
      face={<TextAlignStart className='h-4 w-4' />}
      appliesHere={face !== NO_ALIGNABLE_BLOCK}
      contentClassName={ROWS}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      {ALIGN_ITEMS.map((item) => (
        <BubbleMenuRow
          key={item.id}
          data-testid={`${id}-item-${item.id}`}
          data-active={item.id === active ? 'true' : undefined}
          onSelect={() => {
            runAlignment(editor, item.id);
          }}
        >
          <item.Icon />
          {t(item.labelKey)}
          {/* The tick marks the row in force, the way the block type menu
              marks its own: a fill would sit one step of grey from the hover
              fill, leaving two similar greys on screen at once. */}
          <span className='ml-auto flex size-4 shrink-0 items-center justify-center'>
            {item.id === active ? (
              <Check strokeWidth={3} className='size-4' />
            ) : null}
          </span>
        </BubbleMenuRow>
      ))}
    </SlotShell>
  );
});

/**
 * Whether two readings of the colour panel say the same thing.
 *
 * `colourFace` builds its answer per read, so the reference is never the same
 * object twice; compared by value, the panel re-renders only when one of the
 * three answers moves.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when they match.
 */
function sameColours(a: ColourFace, b: ColourFace): boolean {
  return (
    a.appliesHere === b.appliesHere && a.text === b.text && a.fill === b.fill
  );
}

/**
 * One cell of either colour row: 30 square, 6px apart, the letter at 15px
 * (the demo's `.color-cell`). `text-base` is the step that carries 15px
 * (`theme/tokens.css:397`).
 */
const COLOUR_CELL =
  'flex size-[var(--btn-inline)] items-center justify-center rounded-content-sm'
  + ' border border-border cursor-default hover:border-active-border text-base';

/**
 * The cell the selection already carries.
 *
 * A neutral ring outside the cell's own border, which is the two rules this
 * mark answers to at once. `active-border` is the single source for a border
 * that says "selected" in a neutral colour (`packages/web/CLAUDE.md`), and a
 * ring leaves the cell's own outline in place — so the marked cell has the
 * same structure as every other one, with a second line around it. The canvas
 * colour picker marks its own cell the same way (`GroupBackgroundPicker:91`).
 *
 * A mark drawn in `status-selected` would have been palette violet, which the
 * panel also offers as its sixth choice: on that cell the mark and the value
 * became one colour.
 */
const COLOUR_CELL_ON = 'ring-1 ring-active-border';

/**
 * The cell that takes this row's colour off, in both rows.
 *
 * The slash is what reads as "none" at a glance. The text row's cell used to
 * carry a plain ink `A`, which among seven coloured ones reads as an eighth
 * choice — black — rather than as taking the colour away. One mark for one
 * action, in the leftmost cell of either row.
 */
const CLEARS_THE_ROW =
  'relative overflow-hidden'
  + ' after:absolute after:-inset-x-1 after:top-1/2 after:border-t'
  + ' after:border-muted-foreground after:[content:""]'
  + ' after:[transform:rotate(-38deg)]';

/** What one cell of the colour panel needs to draw and answer for itself. */
interface ColourCellProps {
  /** The cell's test id. */
  testId: string;
  /** Whether this is the colour in force over the selection. */
  selected: boolean;
  /** What the cell shows the colour with: the letter A, or the swatch alone. */
  face?: React.ReactNode;
  /** How the cell paints the colour it stands for. */
  style?: React.CSSProperties;
  /** Anything the cell draws on top of the shared shape. */
  className?: string;
  /** What a press writes. */
  onPick: () => void;
}

/**
 * One cell of the colour panel.
 *
 * Both rows are a "take it off" cell followed by the seven hues, and the four
 * of them differ only in what they paint and what they write — so the shape,
 * the selected ring and the press live here once.
 * @param props - See {@link ColourCellProps}.
 * @param props.testId - The cell's test id.
 * @param props.selected - Whether this is the colour in force.
 * @param props.face - What the cell shows the colour with.
 * @param props.style - How the cell paints the colour it stands for.
 * @param props.className - Anything drawn on top of the shared shape.
 * @param props.onPick - What a press writes.
 * @returns The cell.
 */
function ColourCell({
  testId,
  selected,
  face,
  style,
  className,
  onPick,
}: ColourCellProps): React.JSX.Element {
  return (
    <Button
      variant={null}
      size={null}
      tabIndex={-1}
      data-testid={testId}
      data-selected={selected ? 'true' : undefined}
      className={cn(COLOUR_CELL, selected && COLOUR_CELL_ON, className)}
      style={style}
      onClick={onPick}
    >
      {face}
    </Button>
  );
}

/**
 * The colour slot.
 *
 * Its opener is the letter A and a chevron, the way the demo draws it. The
 * panel holds two
 * rows of eight and a reset button (the demo's `.color-panel`): the text row is
 * a default
 * plus the seven hues, each colouring the letter A; the background row is a
 * "none" cell plus the same seven as swatches.
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
  const label = t('spaces.document.commands.color');
  // One reading covers all three states the panel draws, the way the alignment
  // slot reads its own. Row by row it walked the selection once per row per
  // editor change, and the readings could disagree about what is under it.
  const {
    appliesHere,
    text: activeText,
    fill: activeFill,
  } = useEditorSnapshot(editor, colourFace, sameColours);
  // The panel's cells are buttons laid out in a grid rather than rows built
  // on `BubbleMenuRow`, so closing is theirs to ask for. Ruling C2 has the
  // menu close on every press alike.
  const pick = React.useCallback(
    (run: () => void) =>
      (): void => {
        run();
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
      align='end'
      contentClassName='py-2'
      appliesHere={appliesHere}
      container={container}
      scroller={scroller}
      openId={openId}
      onOpenChange={onOpenChange}
    >
      <BubbleMenuHeading>
        {t('spaces.document.commands.textColor')}
      </BubbleMenuHeading>
      <div className='flex gap-1.5 px-2 pb-3'>
        {/* The default sits first, and reads as the one in force while the
            selection carries no colour (the demo marks it `data-selected`). */}
        <ColourCell
          testId={`${id}-text-default`}
          selected={activeText === NO_COLOUR}
          face='A'
          className={cn('font-semibold', CLEARS_THE_ROW)}
          onPick={pick(() => {
            clearColours(editor, 'textColor');
          })}
        />
        {COLOUR_HUES.map((hue) => (
          <ColourCell
            key={hue}
            testId={`${id}-text-${hue}`}
            selected={activeText === hue}
            face='A'
            className='font-semibold'
            style={{ color: `var(--color-palette-${hue})` }}
            onPick={pick(() => {
              setColour(editor, 'textColor', hue);
            })}
          />
        ))}
      </div>
      <BubbleMenuHeading>
        {t('spaces.document.commands.fillColor')}
      </BubbleMenuHeading>
      <div className='flex gap-1.5 px-2 pb-3'>
        {/* No background, drawn as the demo's `.color-cell-none` is,
            and likewise the one in force. */}
        <ColourCell
          testId={`${id}-fill-none`}
          selected={activeFill === NO_COLOUR}
          className={cn('bg-background', CLEARS_THE_ROW)}
          onPick={pick(() => {
            clearColours(editor, 'backgroundColor');
          })}
        />
        {COLOUR_HUES.map((hue) => (
          <ColourCell
            key={hue}
            testId={`${id}-fill-${hue}`}
            selected={activeFill === hue}
            // The same token the text this cell produces is filled with
            // (`index.css`), so the swatch and the result read one value.
            style={{
              background: `var(--color-palette-${hue}-bg)`,
              borderColor: `var(--color-palette-${hue}-border)`,
            }}
            onPick={pick(() => {
              setColour(editor, 'backgroundColor', hue);
            })}
          />
        ))}
      </div>
      {/* Takes both marks off the selection (the demo's `.color-reset`). */}
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
          onClick={pick(() => {
            clearColours(editor, 'textColor', 'backgroundColor');
          })}
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
