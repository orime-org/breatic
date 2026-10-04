// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The colour panel: rows of eight and a reset button.
 *
 * The demo's `.color-panel`. The text row is a default plus the seven hues,
 * each colouring the letter A; the background row is a "none" cell plus the
 * same seven as swatches. In a table a third row of the same swatches fills
 * the cells themselves, and a table handle's menu draws that row alone
 * (inner#1126).
 *
 * NO OVERLAY SHELL OF ITS OWN. Two carriers offer this panel — the bubble
 * bar's colour slot and the block handle's menu — and each wraps it in its own
 * overlay and hands in its own callbacks, so the cells, the marks and the
 * spacing are drawn once rather than redrawn per carrier from the same seven
 * hue names.
 *
 * It takes three things: what the range reads as (which cell carries the
 * mark), and what a press on either row writes. Whether the panel can act at
 * all rides along in the reading, and both carriers judge it before this ever
 * renders — the bar takes its menu away, the block menu's row refuses to open.
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { BubbleMenuHeading } from '@web/spaces/document/document-bubble-rows';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import {
  COLOUR_HUES,
  NO_COLOUR,
  type ColourFace,
  type ColourHue,
  type ColourKind,
} from '@web/spaces/document/document-colour-run';

/**
 * One cell of either colour row: 28 square (`--btn-inline`, the step the
 * controls above it stand on), 6px apart, the letter at 15px. `text-base` is
 * the step that carries 15px (`theme/tokens.css:463`).
 *
 * Both borders read a custom property and fall back to the neutral pair the
 * demo drew (`2026-08-21-editor-command-surface.html:247-251`), so the text
 * row — which sets neither — keeps exactly that. The fill row hands its own
 * hue in through those two properties instead of writing `borderColor`
 * inline: an inline border colour outranks every class, the `hover:` variant
 * included, and it left all seven fill cells reading the same border under
 * the pointer as at rest (measured 2026-09-19, #999).
 */
const COLOUR_CELL =
  'flex size-[var(--btn-inline)] items-center justify-center rounded-content-sm'
  + ' border border-[var(--cell-edge,var(--color-border))] cursor-default'
  + ' hover:border-[var(--cell-edge-over,var(--color-active-border))]'
  + ' text-base';

/**
 * The cell the range already carries.
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
 * The first cell of the fill row, where a block carries no background.
 *
 * The slash is what reads as "none" at a glance, and none is what sits there:
 * a block with no fill shows the page through. The text row's first cell
 * carries no slash — the default ink is a colour of its own, the one the
 * theme picks (user 2026-09-12).
 */
const NO_FILL =
  'relative overflow-hidden'
  + ' after:absolute after:-inset-x-1 after:top-1/2 after:border-t'
  + ' after:border-muted-foreground after:[content:""]'
  + ' after:[transform:rotate(-38deg)]';

/** What one cell of the colour panel needs to draw and answer for itself. */
interface ColourCellProps {
  /** The cell's test id. */
  testId: string;
  /** Whether this is the colour in force over the range. */
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
 * The row for a table cell's own fill (inner#1126): the same none cell and
 * seven swatches as the fill row, written to the cells rather than as a mark
 * on the words in them.
 */
export interface CellFillRow {
  /** The hue the cells carry, {@link NO_COLOUR} for none, undefined when they differ. */
  readonly face: string | undefined;
  /** Puts a hue on the cells. */
  readonly onSet: (hue: ColourHue) => void;
  /** Takes the cells' fill off. */
  readonly onClear: () => void;
}

/** Both mark rows, which every carrier but a table's draws. */
const BOTH_KINDS: readonly ColourKind[] = ['textColor', 'backgroundColor'];

/** What the panel needs from whichever overlay is carrying it. */
export interface ColourPanelProps {
  /** The stem of every test id in the panel. */
  idStem: string;
  /** What the range this panel acts on reads as. */
  face: ColourFace;
  /** Puts a hue on one row. */
  onSet: (kind: ColourKind, hue: ColourHue) => void;
  /** Takes the given rows' colours off. */
  onClear: (kinds: readonly ColourKind[]) => void;
  /** Which mark rows to draw; both when left out. */
  kinds?: readonly ColourKind[];
  /** The cell fill row, drawn after the mark rows when given. */
  cell?: CellFillRow;
}

/** What one swatch row needs. */
interface SwatchRowProps {
  /** The stem of the row's test ids. */
  testStem: string;
  /** The hue in force, {@link NO_COLOUR} for none. */
  active: string | undefined;
  /** What the none cell writes. */
  onNone: () => void;
  /** What a hue writes. */
  onHue: (hue: ColourHue) => void;
}

/**
 * A row of swatches: a none cell and the seven hues as fills.
 * @param props - See {@link SwatchRowProps}.
 * @param props.testStem - The stem of the row's test ids.
 * @param props.active - The hue in force.
 * @param props.onNone - What the none cell writes.
 * @param props.onHue - What a hue writes.
 * @returns The row.
 */
function SwatchRow({ testStem, active, onNone, onHue }: SwatchRowProps): React.JSX.Element {
  return (
    <div className='flex gap-1.5 px-2 pb-3'>
      {/* No background, drawn as the demo's `.color-cell-none` is,
          and likewise the one in force. */}
      <ColourCell
        testId={`${testStem}-none`}
        selected={active === NO_COLOUR}
        className={cn('bg-background', NO_FILL)}
        onPick={onNone}
      />
      {COLOUR_HUES.map((hue) => (
        <ColourCell
          key={hue}
          testId={`${testStem}-${hue}`}
          selected={active === hue}
          // The same token the text this cell produces is filled with
          // (`index.css`), so the swatch and the result read one value. The
          // two edges travel as custom properties {@link COLOUR_CELL} reads:
          // the hue at 40% while the pointer is elsewhere, the hue itself
          // under it — the seven cells stay told apart by their own colour
          // either way, which is what the edge was added for (#905 visual
          // round, finding 1).
          style={
            {
              background: `var(--color-palette-${hue}-highlight)`,
              '--cell-edge': `var(--color-palette-${hue}-border)`,
              '--cell-edge-over': `var(--color-palette-${hue})`,
            } as React.CSSProperties
          }
          onPick={() => {
            onHue(hue);
          }}
        />
      ))}
    </div>
  );
}

/**
 * The colour panel, without an overlay of its own.
 * @param props - See {@link ColourPanelProps}.
 * @param props.idStem - The stem of every test id in the panel.
 * @param props.face - What the range reads as.
 * @param props.onSet - Puts a hue on one row.
 * @param props.onClear - Takes the given rows' colours off.
 * @param props.kinds - Which mark rows to draw.
 * @param props.cell - The cell fill row.
 * @returns The panel.
 */
export const DocumentColourPanel = React.memo(function DocumentColourPanel({
  idStem,
  face,
  onSet,
  onClear,
  kinds = BOTH_KINDS,
  cell,
}: ColourPanelProps): React.JSX.Element {
  const t = useTranslation();
  const { text: activeText, fill: activeFill } = face;
  return (
    <>
      {kinds.includes('textColor') ? (
        <>
          <BubbleMenuHeading>
            {t('spaces.document.commands.textColor')}
          </BubbleMenuHeading>
          <div className='flex gap-1.5 px-2 pb-3'>
            {/* The default sits first, and reads as the one in force while the
            range carries no colour (the demo marks it `data-selected`). It
            draws a plain `A` in the body's own ink: the default is a colour,
            one that follows the theme — dark on a light ground, light on a
            dark one — where the fill row's first cell is the absence of one
            (user 2026-09-12). */}
            <ColourCell
              testId={`${idStem}-text-default`}
              selected={activeText === NO_COLOUR}
              face='A'
              className='font-semibold'
              onPick={() => {
                onClear(['textColor']);
              }}
            />
            {COLOUR_HUES.map((hue) => (
              <ColourCell
                key={hue}
                testId={`${idStem}-text-${hue}`}
                selected={activeText === hue}
                face='A'
                className='font-semibold'
                style={{ color: `var(--color-palette-${hue})` }}
                onPick={() => {
                  onSet('textColor', hue);
                }}
              />
            ))}
          </div>
        </>
      ) : null}
      {kinds.includes('backgroundColor') ? (
        <>
          <BubbleMenuHeading>
            {/* Beside a cell fill row the text's own background says which
                of the two fills it is. */}
            {t(cell === undefined ? 'spaces.document.commands.fillColor' : 'spaces.document.table.textHighlight')}
          </BubbleMenuHeading>
          <SwatchRow
            testStem={`${idStem}-fill`}
            active={activeFill}
            onNone={() => {
              onClear(['backgroundColor']);
            }}
            onHue={(hue) => {
              onSet('backgroundColor', hue);
            }}
          />
        </>
      ) : null}
      {cell !== undefined ? (
        <>
          <BubbleMenuHeading>{t('spaces.document.table.cellFill')}</BubbleMenuHeading>
          <SwatchRow
            testStem={`${idStem}-cell`}
            active={cell.face}
            onNone={cell.onClear}
            onHue={cell.onSet}
          />
        </>
      ) : null}
      {/* Takes every row it draws off the range (the demo's `.color-reset`). */}
      <div className='px-2 pb-1 pt-0.5'>
        <Button
          variant='outline'
          size={null}
          data-testid={`${idStem}-reset`}
          tabIndex={-1}
          // No fill of its own: it sits on the popover, and `outline`'s
          // `bg-background` is the page's ground, a step darker than the panel
          // under it (the demo's `.color-reset` is transparent).
          className='h-8 w-full bg-transparent text-sm'
          onClick={() => {
            if (kinds.length > 0) onClear(kinds);
            cell?.onClear();
          }}
        >
          {t('spaces.document.commands.colorReset')}
        </Button>
      </div>
    </>
  );
});
