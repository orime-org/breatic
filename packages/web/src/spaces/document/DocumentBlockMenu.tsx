// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The seven rows of the block handle menu, and what each one runs.
 *
 * Every row acts on the block the pointer is over, never on the reader's
 * selection (A5) — which is why each command here is handed that block's id
 * and why none of them moves the caret.
 *
 * Which rows there are, and in what order, is `document-block-menu-rows.ts`;
 * this file is the wiring.
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
import { UNAVAILABLE_KEYBOARD_FOCUS_ONLY } from '@web/spaces/document/document-coming-tool';
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
  DIMENSION_OF_ROW,
  tickedOver,
  type BlockTypeId,
} from '@web/spaces/document/document-block-ticks';
import {
  BLOCK_TYPE_ITEMS,
  blockTypeItem,
} from '@web/spaces/document/document-block-type';
import {
  deleteRow,
  duplicateRow,
  type HandleEditor,
  type PressedBlock,
} from '@web/spaces/document/document-handle-commands';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';
import { INSERT_MENU_ROWS } from '@web/spaces/document/document-insert-menu-items';
import { insertRowForMenu } from '@web/spaces/document/document-insert-row';

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

/**
 * Whether a rule goes after this row.
 *
 * Drawn wherever the order crosses from one of the three dimensions to the
 * next, which is how the bubble bar's own type menu groups the same rows. Read
 * off `DIMENSION_OF_ROW` so a row added to a group lands inside its rules by
 * saying which group it is in — the one place that already has to say so.
 * @param id - The row being drawn.
 * @param next - The row after it, or undefined at the end of the list.
 * @returns True when a rule belongs between the two.
 */
function rulesAfter(id: BlockTypeId, next: BlockTypeId | undefined): boolean {
  return next !== undefined && DIMENSION_OF_ROW[id] !== DIMENSION_OF_ROW[next];
}

/**
 * The keys Radix opens a submenu with, reading left to right.
 *
 * `MenuSubTrigger`'s own handler opens on these three and cancels the event;
 * cancelling them first is what keeps a row out of reach from opening. Every
 * other key is left alone, so arrowing up and down the menu still works on a
 * greyed row — which is the whole reason it is `aria-disabled` rather than
 * Radix's `disabled` (the ARIA authoring practices: "Disabled menu items are
 * focusable but cannot be activated").
 */
const OPENS_SUBMENU = new Set(['ArrowRight', 'Enter', ' ']);

/**
 * What a submenu trigger carries while the hovered row is out of the
 * command's reach.
 *
 * A row that greys owes three things (`document-bubble-slots.tsx`), and in a
 * menu the first of them — take the menu away — means this one must not open
 * at all. GREYING ALONE DOES NOT DO THAT: Radix renders a `MenuSubTrigger` as
 * `MenuItemImpl`, whose `onClick` and `onPointerMove` consult `props.disabled`
 * and `event.defaultPrevented` and nothing else, so `aria-disabled` and a
 * class are invisible to it. Cancelling the event is what it reads.
 *
 * The third thing — say so — is the treatment itself, the same dimming the
 * reader has already met on the bubble bar's own two slots when the selection
 * moved out of reach. No extra words: the commands ARE built, so the comment
 * row's "not open yet" would say something false here.
 * @param unavailable - Whether the command is out of reach on this row.
 * @returns Attributes to spread onto the trigger, empty where it can act.
 */
function whenOutOfReach(
  unavailable: boolean,
): React.ComponentProps<typeof DropdownMenuSubTrigger> {
  if (!unavailable) {
    return {};
  }
  return {
    'aria-disabled': 'true',
    className: UNAVAILABLE_KEYBOARD_FOCUS_ONLY,
    onClick: (event) => {
      event.preventDefault();
    },
    onPointerMove: (event) => {
      event.preventDefault();
    },
    onKeyDown: (event) => {
      if (OPENS_SUBMENU.has(event.key)) {
        event.preventDefault();
      }
    },
  };
}

interface DocumentBlockMenuProps {
  /** The editor to write to. */
  editor: HandleEditor;
  /** The block the pointer is over. */
  block: PressedBlock;
  /** Closes the menu. */
  close: () => void;
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
}

/**
 * Whether two readings say the same thing.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when they match.
 */
function sameFaces(a: StyleFaces, b: StyleFaces): boolean {
  return a.align === b.align && sameColours(a.colour, b.colour);
}

/**
 * What the two style rows read off the hovered block.
 *
 * Both readings walk the block's own content rather than the editor's state,
 * and that is not a refinement: the handle is on screen only while the reader
 * holds no selection (`DocumentBlockHandle.tsx:125`), so a state-based reading
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
 * The menu's seven rows.
 * @param props - See {@link DocumentBlockMenuProps}.
 * @param props.editor - The editor to write to.
 * @param props.block - The block the pointer is over.
 * @param props.close - Closes the menu.
 * @returns The rows.
 */
export function DocumentBlockMenu({
  editor,
  block,
  close,
}: DocumentBlockMenuProps): React.JSX.Element {
  const t = useTranslation();
  const ticked = ticksFor(editor, block.id);
  const faces = useFacesOf(editor, block.id);

  /**
   * The row this menu is about, as the document holds it right now.
   *
   * The block the strip hands over is a snapshot taken when the pointer
   * arrived: the library refreshes its state on a document change
   * (`SideMenu.ts:683-688`) but `updateStateFromMousePos` returns early while
   * the hovered element still carries the same `data-id` (`:229-236`). The
   * menu meanwhile stays open however long the reader takes, and a co-editor
   * can change that row or take it away. So every command reads the row again
   * here, by the one thing that does not go stale — its id.
   *
   * Measured 2026-09-18: with the snapshot, a row reading `alpha PLUS` on
   * screen was duplicated as `alpha`.
   * @returns The row, or undefined once it is gone.
   */
  const rowNow = React.useCallback(
    (): PressedBlock | undefined =>
      editor.getBlock(block.id) as PressedBlock | undefined,
    [editor, block.id],
  );

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
      {BLOCK_MENU_ROWS.map((row) => {
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
                className='flex flex-col gap-1'
              >
                {BLOCK_TYPE_ITEMS.map((item, index) => {
                  const ItemIcon = item.Icon;
                  const ruled = rulesAfter(
                    item.id,
                    BLOCK_TYPE_ITEMS[index + 1]?.id,
                  );
                  return (
                    <React.Fragment key={item.id}>
                      <DropdownMenuItem
                        data-testid={`doc-block-type-${item.id}`}
                        data-ticked={ticked.has(item.id) ? 'true' : undefined}
                        onSelect={() => {
                          const live = rowNow();
                          if (live !== undefined) {
                            runBlockType(editor, item.id, live.id);
                          }
                          close();
                        }}
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
                className='flex flex-col gap-1'
              >
                {INSERT_MENU_ROWS.map((id, index) => {
                  const item = blockTypeItem(id);
                  const ItemIcon = item.Icon;
                  const ruled = rulesAfter(id, INSERT_MENU_ROWS[index + 1]);
                  return (
                    <React.Fragment key={id}>
                      <DropdownMenuItem
                        data-testid={`doc-block-insert-${id}`}
                        onSelect={() => {
                          const live = rowNow();
                          if (live !== undefined) {
                            const made = insertRowForMenu(editor, live);
                            runBlockType(editor, id, made, false);
                          }
                          close();
                        }}
                      >
                        <ItemIcon />
                        {t(item.labelKey)}
                      </DropdownMenuItem>
                      {ruled ? <DropdownMenuSeparator className='my-0' /> : null}
                    </React.Fragment>
                  );
                })}
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
                className='flex flex-col gap-1'
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
                className='py-2'
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

        if (row.id === 'comment') {
          // Stands in the menu so the shape is whole, and says it cannot be
          // used: the treatment is the bubble bar's, which the reader has
          // already met on the comment entry there (A10).
          //
          // THE KEYBOARD STILL HAS TO SEE WHERE IT IS. `aria-disabled` rather
          // than Radix's `disabled` is what the ARIA authoring practices ask
          // of a menu — "Disabled menu items are focusable but cannot be
          // activated" — so an arrow key lands here, and the row's own
          // background is the only thing that says so. `onPointerMove` below
          // keeps the POINTER from focusing it, which is the case the bubble
          // bar's own treatment cancels `:focus` for.
          const comingLabel = t('spaces.document.commands.comingLabel', {
            name: label,
          });
          return (
            <DropdownMenuItem
              key={row.id}
              aria-disabled='true'
              data-testid={`doc-block-row-${row.id}`}
              className={UNAVAILABLE_KEYBOARD_FOCUS_ONLY}
              onSelect={(event) => {
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                event.preventDefault();
              }}
            >
              <Icon />
              {comingLabel}
            </DropdownMenuItem>
          );
        }

        if (row.id === 'delete') {
          // Six things and one that cannot be taken back. The rule is where
          // the canvas node menu puts its own (`NodeContextMenu.tsx:302`):
          // the pointer running down the list meets something before the last
          // row, and the row above this one is a greyed one it slides past.
          //
          // The colour is the repo's error text, the same token the four
          // other places that say "this went wrong" use. It reads 4.00:1 on
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
