// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The rows of the block handle menu, and what each one runs: the seven of a
 * block's grip, or the six of a table's entry.
 *
 * Every row acts on the block the pointer is over, never on the reader's
 * selection (A5) — which is why each command here is handed that block's id
 * and why none of them moves the caret.
 *
 * Which rows there are, and in what order, is `document-block-menu-rows.ts`;
 * the strip hands the list in, and this file is the wiring.
 */

import * as React from 'react';
import type { Selection } from '@tiptap/pm/state';

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import {
  BLOCK_MENU_ROWS,
  type BlockMenuRow,
} from '@web/spaces/document/document-block-menu-rows';
import { runBlockType } from '@web/spaces/document/document-block-run';
import {
  NO_ALIGNABLE_BLOCK,
  alignFaceOver,
  runAlignment,
  type AlignFace,
} from '@web/spaces/document/document-align-run';
import {
  clearColours,
  colourFaceOver,
  sameColours,
  setColour,
  type ColourFace,
  type ColourHue,
  type ColourKind,
} from '@web/spaces/document/document-colour-run';
import {
  ALIGN_ITEMS,
  alignFaceIcon,
} from '@web/spaces/document/document-align-items';
import { DocumentColourPanel } from '@web/spaces/document/document-colour-panel';
import { MenuTick } from '@web/spaces/document/document-menu-tick';
import {
  TYPE_MENU_WIDTH,
  itemWithin,
  rulesAfter,
  whenOutOfReach,
} from '@web/spaces/document/document-block-menu-parts';
import {
  blocksUnder,
  blocksUnderFor,
  tickedOver,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';
import {
  BLOCK_TYPE_ITEMS,
} from '@web/spaces/document/document-block-type';
import {
  deleteRow,
  duplicateRow,
  indentReach,
  indentRow,
  type HandleEditor,
  type IndentReach,
  type PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import { openCommentDraft } from '@web/spaces/document/document-comment-entries';
import { canCommentOver } from '@web/spaces/document/document-comment-target';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import {
  insertBelow,
  type InsertChoice,
} from '@web/spaces/document/document-insert-row';
import { DocumentInsertChoices } from '@web/spaces/document/DocumentInsertChoices';
import { useRowNow } from '@web/spaces/document/use-row-now';

/**
 * How far from the menu's edge its submenus sit.
 *
 * A panel that hangs off a surface keeps a visible gap from that surface's
 * edge, and user 2026-08-27 put the width of it at 4px. This menu opens its
 * submenus to the SIDE, so the gap is between the panel's right edge and the
 * submenu's left.
 *
 * `sideOffset` measures from the TRIGGER, and this trigger is a row sitting
 * inside the panel's own 4px padding and 1px border. Those 5px come out of the
 * gap — measured with no offset at all, the submenu stood 4.67px INSIDE the
 * panel — so 9 puts the visible gap at 4. The bubble bar reaches its own 4px
 * the same way (`document-bubble-menu.tsx`).
 */
const SUBMENU_SIDE_OFFSET = 4 + 5;

interface DocumentBlockMenuProps {
  /** The editor to write to. */
  editor: HandleEditor;
  /** The block the pointer is over. */
  block: PressedBlock;
  /** Closes the menu. */
  close: () => void;
  /** The rows to draw, in order. */
  rows?: readonly BlockMenuRow[];
}

/**
 * The rows the block type submenu offers for this block.
 * @param editor - The editor to read from.
 * @param blockId - The block the pointer is over.
 * @returns Which rows that block already carries.
 */
function ticksFor(editor: HandleEditor, blockId: string): Set<BlockTypeId> {
  return editor.transact((tr) =>
    tickedOver(tr.doc, selectionOverBlockContent(tr.doc, blockId)),
  );
}

/** What the two style rows read off the hovered block. */
interface StyleFaces {
  /** Which alignment row is lit, or that alignment reaches nothing. */
  readonly align: AlignFace;
  /** Which colour cells are marked, and whether a press reaches anything. */
  readonly colour: ColourFace;
  /** Whether this row holds words a comment could mark (A3). */
  readonly canComment: boolean;
  /** Which way the row can be indented. */
  readonly indent: IndentReach;
  /** Whether the eight rows that set a block's type reach this row. */
  readonly holdsText: boolean;
  /**
   * Whether the Quote row reaches this row. It reads the quote's own working
   * set, which also holds a divider (#124, A8), so the row greys exactly where
   * pressing it would write nothing.
   */
  readonly quotable: boolean;
}

/**
 * Whether two readings say the same thing.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when they match.
 */
function sameFaces(a: StyleFaces, b: StyleFaces): boolean {
  return (
    a.align === b.align &&
    a.canComment === b.canComment &&
    a.indent.in === b.indent.in &&
    a.indent.out === b.indent.out &&
    a.holdsText === b.holdsText &&
    a.quotable === b.quotable &&
    sameColours(a.colour, b.colour)
  );
}

/**
 * What the two style rows read off the hovered block.
 *
 * Both readings walk the block's own content rather than the editor's state,
 * and that is not a refinement: the handle is on screen only while the reader
 * holds no selection (`DocumentBlockHandle.tsx`'s `holdsSelection` guard), so a
 * state-based reading
 * would answer about the reader's caret on every single press.
 * @param editor - The editor to read from.
 * @param blockId - The block the pointer is over.
 * @returns What each row draws and whether it can act.
 */
function facesFor(editor: HandleEditor, blockId: string): StyleFaces {
  return editor.transact((tr) => {
    const over = selectionOverBlockContent(tr.doc, blockId);
    return {
      align: alignFaceOver(tr.doc, over),
      colour: colourFaceOver(tr.doc, over),
      canComment: canCommentOver(tr.doc, over),
      indent: indentReach(tr.doc, blockId),
      holdsText: blocksUnder(tr.doc, over).length > 0,
      quotable: blocksUnderFor(tr.doc, over, 'quote').length > 0,
    };
  });
}

/**
 * The same reading, held by value across renders.
 *
 * It is rebuilt on every render, and the colour panel is memoised — so a fresh
 * object each time would leave that memo unable to bail, which
 * `packages/web/CLAUDE.md` names as a defect of its own. The previous reading
 * is kept while it says the same thing. Written during render because that is
 * when the comparison happens, the way `useEditorSnapshot` keeps its own.
 * @param editor - The editor to read from.
 * @param blockId - The block the pointer is over.
 * @returns The reading, stable while nothing it says has moved.
 */
function useFacesOf(editor: HandleEditor, blockId: string): StyleFaces {
  const held = React.useRef<StyleFaces | null>(null);
  const next = facesFor(editor, blockId);
  if (held.current === null || !sameFaces(held.current, next)) {
    held.current = next;
  }
  return held.current;
}

/**
 * The menu's rows.
 * @param props - See {@link DocumentBlockMenuProps}.
 * @param props.editor - The editor to write to.
 * @param props.block - The block the pointer is over.
 * @param props.close - Closes the menu.
 * @param props.rows - The rows to draw; a block's grip rows when left out.
 * @returns The rows.
 */
export function DocumentBlockMenu({
  editor,
  block,
  close,
  rows = BLOCK_MENU_ROWS,
}: DocumentBlockMenuProps): React.JSX.Element {
  const t = useTranslation();
  const ticked = ticksFor(editor, block.id);
  const faces = useFacesOf(editor, block.id);

  const rowNow = useRowNow(editor, block.id);

  /**
   * The range standing for this row, read off the document as it is now.
   *
   * Built and handed to the command without being dispatched, so the reader's
   * own caret, selection and stored marks stay where they were
   * (`document-hovered-block.ts`). Read at press time for the reason
   * {@link rowNow} is: the menu stays open however long the reader takes.
   * @returns The range, or undefined once the row is gone.
   */
  const rangeNow = React.useCallback((): Selection | undefined => {
    const live = rowNow();
    return live === undefined
      ? undefined
      : editor.transact((tr) => selectionOverBlockContent(tr.doc, live.id));
  }, [editor, rowNow]);

  const onSetColour = React.useCallback(
    (kind: ColourKind, hue: ColourHue): void => {
      const over = rangeNow();
      if (over !== undefined) {
        setColour(editor, kind, hue, over);
      }
      close();
    },
    [editor, rangeNow, close],
  );

  const onClearColour = React.useCallback(
    (kinds: readonly ColourKind[]): void => {
      const over = rangeNow();
      if (over !== undefined) {
        clearColours(editor, kinds, over);
      }
      close();
    },
    [editor, rangeNow, close],
  );

  /**
   * The insert-below submenu's pick: a row under this one, made into what was
   * picked. Held so the memoised list keeps one `onPick` across renders.
   */
  const onInsertBelow = React.useCallback(
    (choice: InsertChoice): void => {
      const live = rowNow();
      if (live !== undefined) {
        insertBelow(editor, live, choice);
      }
      close();
    },
    [editor, rowNow, close],
  );

  /**
   * Runs one row and closes the menu.
   *
   * Nothing is the right answer to a command whose subject is gone: the reader
   * sees the menu close and the row stay gone, which is what they are looking
   * at anyway.
   * @param row - The row that was pressed.
   */
  function press(row: BlockMenuRow): void {
    const live = rowNow();
    if (live !== undefined) {
      if (row.id === 'duplicate') {
        duplicateRow(editor, live);
      }
      if (row.id === 'delete') {
        deleteRow(editor, live.id);
      }
    }
    close();
  }

  return (
    <>
      {rows.map((row) => {
        const label = t(row.labelKey);
        const Icon = row.Icon;

        if (row.id === 'blockType') {
          return (
            <DropdownMenuSub key={row.id}>
              <DropdownMenuSubTrigger data-testid='doc-block-row-blockType'>
                <Icon />
                {label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={SUBMENU_SIDE_OFFSET}
                className={TYPE_MENU_WIDTH}
                rowsClassName='flex flex-col gap-1'
              >
                {BLOCK_TYPE_ITEMS.map((item, index) => {
                  const ItemIcon = item.Icon;
                  const reachable =
                    item.id === 'quote' ? faces.quotable : faces.holdsText;
                  const ruled = rulesAfter(
                    item.id,
                    BLOCK_TYPE_ITEMS[index + 1]?.id,
                  );
                  return (
                    <React.Fragment key={item.id}>
                      <DropdownMenuItem
                        data-testid={`doc-block-type-${item.id}`}
                        data-ticked={ticked.has(item.id) ? 'true' : undefined}
                        {...itemWithin(reachable, () => {
                          const live = rowNow();
                          if (live !== undefined) {
                            runBlockType(editor, item.id, live.id);
                          }
                          close();
                        })}
                      >
                        <ItemIcon />
                        <span className='flex-1 text-left'>{t(item.labelKey)}</span>
                        {/* What the block already is (A5). */}
                        <MenuTick
                          on={ticked.has(item.id)}
                          testId={`doc-block-type-tickcol-${item.id}`}
                          tickTestId={`doc-block-type-tick-${item.id}`}
                        />
                      </DropdownMenuItem>
                      {ruled ? <DropdownMenuSeparator className='my-0' /> : null}
                    </React.Fragment>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }

        if (row.id === 'insertBelow') {
          return (
            <DropdownMenuSub key={row.id}>
              <DropdownMenuSubTrigger data-testid='doc-block-row-insertBelow'>
                <Icon />
                {label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={SUBMENU_SIDE_OFFSET}
                className={TYPE_MENU_WIDTH}
                rowsClassName='flex flex-col gap-1'
              >
                <DocumentInsertChoices onPick={onInsertBelow} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }

        if (row.id === 'align') {
          const unavailable = faces.align === NO_ALIGNABLE_BLOCK;
          // The face of the block under the pointer, not a still icon: this
          // row is the only entry in the menu that can say, without being
          // opened, what the block it is about already is. The bubble bar's
          // alignment slot draws its opener the same way, off the same
          // reading, so the two carriers of this command agree on screen.
          const AlignIcon = alignFaceIcon(faces.align);
          return (
            <DropdownMenuSub key={row.id}>
              <DropdownMenuSubTrigger
                data-testid='doc-block-row-align'
                {...whenOutOfReach(unavailable)}
              >
                <AlignIcon />
                {label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={SUBMENU_SIDE_OFFSET}
                rowsClassName='flex flex-col gap-1'
              >
                {ALIGN_ITEMS.map((item) => {
                  const ItemIcon = item.Icon;
                  const ticks = item.id === faces.align;
                  return (
                    <DropdownMenuItem
                      key={item.id}
                      data-testid={`doc-block-align-${item.id}`}
                      data-ticked={ticks ? 'true' : undefined}
                      onSelect={() => {
                        const over = rangeNow();
                        if (over !== undefined) {
                          runAlignment(editor, item.id, over);
                        }
                        close();
                      }}
                    >
                      <ItemIcon />
                      <span className='flex-1 text-left'>{t(item.labelKey)}</span>
                      {/* The row the block is on. */}
                      <MenuTick on={ticks} />
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }

        if (row.id === 'color') {
          return (
            <DropdownMenuSub key={row.id}>
              <DropdownMenuSubTrigger
                data-testid='doc-block-row-color'
                {...whenOutOfReach(!faces.colour.appliesHere)}
              >
                <Icon />
                {label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={SUBMENU_SIDE_OFFSET}
                rowsClassName='py-2'
              >
                <DocumentColourPanel
                  idStem='doc-block-color'
                  face={faces.colour}
                  onSet={onSetColour}
                  onClear={onClearColour}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }

        if (row.id === 'indent' || row.id === 'unindent') {
          const inward = row.id === 'indent';
          return (
            <DropdownMenuItem
              key={row.id}
              data-testid={`doc-block-row-${row.id}`}
              {...itemWithin(inward ? faces.indent.in : faces.indent.out, () => {
                const live = rowNow();
                if (live !== undefined) {
                  indentRow(editor, live.id, inward);
                }
                close();
              })}
            >
              <Icon />
              {label}
            </DropdownMenuItem>
          );
        }

        if (row.id === 'comment') {
          // Acts on the whole row, which `selectionOverBlockContent` turns
          // into a range without dispatching a selection — the reader's caret
          // is elsewhere and stays there (A2).
          //
          // A row with no words in it covers no run, so there is nothing for
          // a press to mark and the entry says so rather than looking usable
          // (A3, R7). The treatment is `itemWithin`'s, the menu-item side of
          // the `whenOutOfReach` the colour row beside it uses.
          //
          // THE KEYBOARD STILL HAS TO SEE WHERE IT IS. `aria-disabled` rather
          // than Radix's `disabled` is what the ARIA authoring practices ask
          // of a menu — "Disabled menu items are focusable but cannot be
          // activated" — so an arrow key lands here, and the row's own
          // background is the only thing that says so.
          const reachable = faces.canComment;
          return (
            <DropdownMenuItem
              key={row.id}
              data-testid={`doc-block-row-${row.id}`}
              {...itemWithin(reachable, () => {
                const over = rangeNow();
                if (over === undefined) {
                  close();
                  return;
                }
                openCommentDraft(editor as never, [
                  { from: over.from, to: over.to },
                ]);
                close();
              })}
            >
              <Icon />
              {label}
            </DropdownMenuItem>
          );
        }

        if (row.id === 'delete') {
          // Six things and one that takes a row away. The rule is where the
          // canvas node menu puts its own (`NodeContextMenu.tsx`'s delete):
          // the pointer running down the list meets something before the last
          // row, and the row above this one is a greyed one it slides past.
          //
          // The colour is the repo's error text, the same token every other
          // place that says "this went wrong" uses. It reads 4.00:1 on
          // the menu surface and 3.43:1 on the hover fill (light; 3.87 and
          // 3.37 dark) — below what AA asks of body text, and a known,
          // ratified property of the palette rather than anything this row
          // introduces: the identity hues were settled on screen and
          // `tokens.css` says so in as many words ("a contrast figure
          // describes a coordinate distance; it does not describe how a
          // colour reads"). Backlog #103 holds that question open for the
          // palette as a whole. The red is not carrying the meaning alone
          // here anyway — the word, the bin, and the rule above it each say
          // the same thing (WCAG 1.4.1).
          return (
            <React.Fragment key={row.id}>
              <DropdownMenuSeparator className='my-0' />
              <DropdownMenuItem
                data-testid={`doc-block-row-${row.id}`}
                className='text-status-error-foreground'
                onSelect={() => {
                  press(row);
                }}
              >
                <Icon />
                {label}
              </DropdownMenuItem>
            </React.Fragment>
          );
        }

        return (
          <DropdownMenuItem
            key={row.id}
            data-testid={`doc-block-row-${row.id}`}
            onSelect={() => {
              press(row);
            }}
          >
            <Icon />
            {label}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
