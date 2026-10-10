// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a table's row handle, column handle and cell button share: the gate
 * that steps them aside for a selection, the two submenus that write a cell
 * attribute, and the rule that a menu whose cell is gone closes.
 */

import { Palette, TextAlignStart } from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { ALIGN_ITEMS } from '@web/spaces/document/document-align-items';
import {
  DocumentColourPanel,
  type CellFillRow,
} from '@web/spaces/document/document-colour-panel';
import {
  NO_COLOUR,
  type ColourFace,
  type ColourHue,
} from '@web/spaces/document/document-colour-run';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import { MenuTick } from '@web/spaces/document/document-menu-tick';
import {
  setCellsAttr,
  sharedCellAttr,
  type CellScope,
} from '@web/spaces/document/document-table-run';
import { tableTargetOf } from '@web/spaces/document/document-table-target';
import { useDocumentBars } from '@web/spaces/document/document-bars';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

/** A cell's fill when it has none, as the table schema writes it. */
const DEFAULT_FILL = 'default';

/** The colour panel's mark rows, none of which a table menu draws. */
const NO_MARK_ROWS: readonly [] = [];

/** The mark rows' reading, which a table menu never shows. */
const NO_MARK_FACE: ColourFace = { appliesHere: true, text: undefined, fill: undefined };

/** What a menu reads off a state. */
interface WithState {
  readonly prosemirrorState: Parameters<typeof tableTargetOf>[0];
}

/**
 * Whether the bubble bar is up, which the table handles stand aside for: a
 * selection the body let go of is not drawn, and nothing stands over it
 * (inner#1127, `document-bars.ts`).
 * @param editor - The editor.
 * @returns True while the bubble bar is up.
 */
export function useHoldsSelection(editor: HandleEditor): boolean {
  return useDocumentBars(editor).bubbleBarUp;
}

/**
 * Runs a command on the cell a table menu holds, if that cell is still there.
 * @param editor - The editor.
 * @param command - What to run, given the cell's position.
 */
export function onTargetCell(editor: HandleEditor, command: (pos: number) => void): void {
  const pos = tableTargetOf(editor.prosemirrorState);
  if (pos !== null) command(pos);
}

/**
 * Closes an open menu once the cell it holds is gone: someone deleted its
 * row, its column or the whole table.
 * @param editor - The editor.
 * @param open - Whether the menu is open.
 * @param close - Closes it.
 */
export function useCloseWhenTargetGone(
  editor: HandleEditor,
  open: boolean,
  close: () => void,
): void {
  const gone = useEditorSnapshot(
    editor as never,
    (current: WithState) => tableTargetOf(current.prosemirrorState) === null,
  );
  React.useEffect(() => {
    if (open && gone) close();
  }, [open, gone, close]);
}

/** What the two attribute submenus need. */
interface CellAttributeMenusProps {
  /** The editor. */
  readonly editor: HandleEditor;
  /** Which cells a choice writes to. */
  readonly scope: CellScope;
  /** The stem of the rows' test ids. */
  readonly stem: string;
}

/** The two submenus' reading of the target. */
interface AttributeFaces {
  readonly align: unknown;
  readonly fill: string | undefined;
}

/**
 * The alignment and cell fill submenus, for the cells a scope covers.
 * @param props - See {@link CellAttributeMenusProps}.
 * @param props.editor - The editor.
 * @param props.scope - Which cells.
 * @param props.stem - The stem of the rows' test ids.
 * @returns The two submenus.
 */
export function CellAttributeMenus({
  editor,
  scope,
  stem,
}: CellAttributeMenusProps): React.JSX.Element {
  const t = useTranslation();
  const faces = useEditorSnapshot(
    editor as never,
    React.useCallback(
      (current: WithState): AttributeFaces => {
        const state = current.prosemirrorState;
        const pos = tableTargetOf(state);
        if (pos === null) return { align: undefined, fill: undefined };
        const fill = sharedCellAttr(state.doc, pos, scope, 'backgroundColor');
        return {
          align: sharedCellAttr(state.doc, pos, scope, 'textAlignment'),
          fill: fill === DEFAULT_FILL ? NO_COLOUR : (fill as string | undefined),
        };
      },
      [scope],
    ),
    (a, b) => a.align === b.align && a.fill === b.fill,
  );

  const cell = React.useMemo<CellFillRow>(
    () => ({
      face: faces.fill,
      onSet: (hue: ColourHue) => {
        onTargetCell(editor, (pos) => {
          setCellsAttr(editor, pos, scope, 'backgroundColor', hue);
        });
      },
      onClear: () => {
        onTargetCell(editor, (pos) => {
          setCellsAttr(editor, pos, scope, 'backgroundColor', DEFAULT_FILL);
        });
      },
    }),
    [editor, faces.fill, scope],
  );

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid={`${stem}align`}>
          <TextAlignStart />
          {t('spaces.document.commands.align')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent rowsClassName='flex flex-col gap-1'>
          {ALIGN_ITEMS.map((item) => {
            const ItemIcon = item.Icon;
            const ticks = faces.align === item.id;
            return (
              <DropdownMenuItem
                key={item.id}
                data-testid={`${stem}align-${item.id}`}
                data-ticked={ticks ? 'true' : undefined}
                onSelect={() => {
                  onTargetCell(editor, (pos) => {
                    setCellsAttr(editor, pos, scope, 'textAlignment', item.id);
                  });
                }}
              >
                <ItemIcon />
                <span className='flex-1 text-left'>{t(item.labelKey)}</span>
                <MenuTick on={ticks} />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid={`${stem}fill`}>
          <Palette />
          {t('spaces.document.table.cellFill')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent rowsClassName='py-2'>
          <DocumentColourPanel
            idStem={`${stem}fill`}
            face={NO_MARK_FACE}
            kinds={NO_MARK_ROWS}
            cell={cell}
            onSet={noop}
            onClear={noop}
          />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

/** The mark rows' handlers, which a table menu never calls. */
function noop(): void {}
