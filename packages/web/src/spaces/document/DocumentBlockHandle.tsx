// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The strip beside the row under the pointer: the drag handle, or a plus on
 * an empty paragraph.
 *
 * Handed to `SideMenuController` in place of the library's own strip, which
 * cannot serve here for two reasons: its handle draws a `react-icons` glyph at
 * a fixed size where the demo asks for lucide at 16 (A2), and its handle sits
 * inside `Components.Generic.Menu.Trigger` (`DragHandleButton.tsx:44`), which
 * comes from a `ComponentsContext` this build does not provide. A menu
 * trigger is also the one thing the handle must not be: Radix's calls
 * `preventDefault()` on `onPointerDown`, which stops the browser from ever
 * starting a drag (A11) — hence the arrangement below.
 *
 * THE STRIP IS ONE BUTTON, and which one depends on the row (#1097, user
 * 2026-10-02). On an empty paragraph it is a plus: its menu lists what the
 * insert-below submenu lists, the pick landing on that line itself, and ends
 * with the grip menu's delete entry, which takes the line away. On every
 * other row it is the drag handle, whose menu carries insert-below among its
 * rows. Neither takes a tooltip (user 2026-09-17) — the strip is pressed the
 * moment the pointer arrives, and a tip that fades in over the row is in the
 * way of the very gesture it describes. The name stays as `aria-label`.
 *
 * The handle carries both of its gestures by keeping them apart: a
 * `pointer-events-none` span is the menu's anchor and receives nothing, while
 * the button beside it is a plain draggable button that opens the menu on
 * click. Radix still owns the menu itself — outside-click, Escape, collision
 * flipping and focus all stay its job.
 */

import { SideMenuExtension } from '@blocknote/core/extensions';
import { GripVertical, Plus, Table } from 'lucide-react';
import type { Node as PMNode } from '@tiptap/pm/model';
import * as React from 'react';
import { NodeSelection } from '@tiptap/pm/state';

import {
  useBlockNoteEditor,
  useExtension,
  useExtensionState,
} from '@blocknote/react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { startRowDrag } from '@web/spaces/document/document-row-drag';
import { deleteRow } from '@web/spaces/document/document-handle-commands';
import {
  BLOCK_MENU_ROWS,
  TABLE_MENU_ROWS,
} from '@web/spaces/document/document-block-menu-rows';
import { itemWithin } from '@web/spaces/document/document-block-menu-parts';
import {
  fillEmptyRow,
  isEmptyParagraph,
  mediaGapOnRow,
  type InsertChoice,
} from '@web/spaces/document/document-insert-row';
import {
  useDocumentMediaPick,
  type MediaKind,
} from '@web/spaces/document/DocumentMediaPicker';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { useStripOnFirstLine } from '@web/spaces/document/document-strip-alignment';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import { DocumentInsertChoices } from '@web/spaces/document/DocumentInsertChoices';
import type { PressedBlock } from '@web/spaces/document/document-handle-commands';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';
import { useRowNow } from '@web/spaces/document/use-row-now';

/**
 * The handle: 24 square, which is the smallest a pointer target may be
 * (WCAG 2.2 SC 2.5.8), around the demo's 16 icon.
 */
const STRIP_BUTTON = 'size-6 shrink-0 [&_svg]:size-4 text-muted-foreground';

/**
 * Which button the strip shows: the drag handle, the plus (#1097), or the
 * table entry (inner#1126 A5). The grip and the table entry both drag the row;
 * they open different menus.
 */
type StripFace = 'grip' | 'plus' | 'table';

/** Quote is out of reach: the line is already in a quote. Module-level so the memo sees one set. */
const QUOTE_GREYED: ReadonlySet<InsertChoice> = new Set<InsertChoice>(['quote']);

/** Each face's test id. */
const TEST_ID: Readonly<Record<StripFace, string>> = {
  grip: 'doc-block-handle',
  plus: 'doc-block-plus',
  table: 'doc-block-table-handle',
};

/**
 * The icon a face draws.
 * @param props - The face.
 * @param props.face - Which face.
 * @returns Its icon.
 */
function FaceIcon({ face }: { face: StripFace }): React.JSX.Element {
  if (face === 'plus') return <Plus />;
  if (face === 'table') return <Table />;
  return <GripVertical />;
}

/** The grip menu's delete row, whose icon and label the plus menu shows too. */
const DELETE_ROW = BLOCK_MENU_ROWS.find((row) => row.id === 'delete')!;

/** What the strip needs to know about its row, read in one pass. */
interface RowReading {
  /** The row is an empty paragraph, so the strip shows the plus. */
  readonly empty: boolean;
  /** The row is in a quote, so the plus menu greys Quote. */
  readonly quoted: boolean;
  /** The row is the document's only block, so deleting it changes nothing. */
  readonly lone: boolean;
  /** The row is a table, so the strip shows the table entry. */
  readonly table: boolean;
}

/**
 * Whether two readings say the same thing.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when every field matches.
 */
function sameReading(a: RowReading, b: RowReading): boolean {
  return (
    a.empty === b.empty && a.quoted === b.quoted && a.lone === b.lone && a.table === b.table
  );
}

/**
 * The strip, for the block the side menu currently points at.
 * @returns The handle, or null while there is no row to serve.
 */
export function DocumentBlockHandle(): React.JSX.Element | null {
  const t = useTranslation();
  const editor = useBlockNoteEditor();
  const sideMenu = useExtension(SideMenuExtension);
  const block = useExtensionState(SideMenuExtension, {
    selector: (state) => state?.block,
  }) as PressedBlock | undefined;
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Which menu the strip opened, fixed when it opens: picking an entry can
  // turn the line from empty to not (or back) while the menu is still on
  // screen, closing included, and that menu stays the one the reader opened.
  const [menuFace, setMenuFace] = React.useState<StripFace>('grip');
  // Ends the drag started from this handle, while one is under way.
  const endDrag = React.useRef<(() => void) | null>(null);
  // Whether the drag off this handle is running. The handle IS the drag's
  // source element, so it cannot leave the document while the drag is on —
  // and the drag's own first act is to select the row it moves, which is what
  // the gate below would otherwise read as the reader having a selection.
  const [dragActive, setDragActive] = React.useState(false);

  // A1: a reader holding a selection is served by the bubble bar, and the two
  // are never on screen together. The library's side menu answers to the
  // pointer alone (`SideMenu.ts:607` — `onMouseMove` straight to
  // `updateStateFromMousePos`, with no selection in the judgement; it hides
  // only while a key is pressed in the body, `:600-604`), so this gate is
  // ours. The same reading `DocumentEditor` makes for the link toolbar, from
  // the same hook: it subscribes to both change and selection change
  // (`use-editor-snapshot.ts:40-41`) and reads during render, so the strip
  // arriving under a pointer is served without a second mechanism.
  const holdsSelection = useEditorSnapshot(
    // The context's editor type is pinned to the library's own default schema
    // while ours is `BlockNoteEditor<never, never, never>` — the same cast
    // `DocumentBlockControls` makes when it puts the editor into the context.
    editor as never,
    // A whole block selected by a click — a picture, a video — is not a
    // range the strip would stand over, and the strip is how that block is
    // dragged (inner#1127).
    (current) =>
      !current.prosemirrorState.selection.empty &&
      !(current.prosemirrorState.selection instanceof NodeSelection),
  );

  // Read off the document on every change: the side menu's own snapshot is not
  // refreshed while the pointer stays on the same row.
  const rowNow = useRowNow(editor as never, block?.id);
  const row = useEditorSnapshot(
    editor as never,
    React.useCallback(
      (current: { prosemirrorState: { doc: PMNode } }): RowReading => {
        const live = rowNow();
        // The root group, read off ProseMirror: one block in it, and that block
        // is this row holding its content alone, no nested group after it.
        const group = current.prosemirrorState.doc.firstChild;
        const only = group?.childCount === 1 ? group.firstChild : null;
        return {
          empty: isEmptyParagraph(live),
          quoted: live?.props?.[QUOTED] === true,
          lone: only != null && only.attrs.id === live?.id && only.childCount === 1,
          table: live?.type === 'table',
        };
      },
      [rowNow],
    ),
    sameReading,
  );

  // The carrier is placed on the row's top edge; this brings the handle down
  // onto the middle of the row's first line (A2).
  const { ref: strip, offset } = useStripOnFirstLine(
    block?.id,
    editor.prosemirrorView?.dom,
  );

  // While the menu is open the strip has to stay on the row the menu is
  // about, however far the pointer wanders.
  const onMenuOpenChange = React.useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      if (open) {
        sideMenu.freezeMenu();
      } else {
        sideMenu.unfreezeMenu();
      }
    },
    [sideMenu],
  );

  // Held rather than written inline: the menu hands it to the memoised colour
  // panel through two callbacks that list it, so a new identity per render
  // would leave that memo comparing unequal props and unable to bail.
  const closeMenu = React.useCallback((): void => {
    onMenuOpenChange(false);
  }, [onMenuOpenChange]);

  // The plus menu's pick, on the row as the document holds it at the press.
  const onFill = React.useCallback(
    (choice: InsertChoice): void => {
      const live = rowNow();
      if (live !== undefined) fillEmptyRow(editor as never, live, choice);
      closeMenu();
    },
    [editor, rowNow, closeMenu],
  );

  // The plus menu's media entries: the files land above the empty line once
  // they are chosen, and the caret stays in it (inner#1127 A1).
  const mediaPick = useDocumentMediaPick();
  const onFillMedia = React.useMemo(
    () =>
      mediaPick === null
        ? undefined
        : (kind: MediaKind): void => {
          mediaPick(kind, () => {
            const live = rowNow();
            return live === undefined ? null : mediaGapOnRow(editor as never, live);
          });
          closeMenu();
        },
    [mediaPick, editor, rowNow, closeMenu],
  );

  // The plus menu's last entry: the empty line itself goes.
  const onDelete = React.useCallback((): void => {
    const live = rowNow();
    if (live !== undefined) deleteRow(editor as never, live.id);
    closeMenu();
  }, [editor, rowNow, closeMenu]);

  if (block === undefined || (holdsSelection && !dragActive)) {
    return null;
  }

  // The face stays what the reader started with: a drag keeps the face it
  // started from, so the drag's own end runs on the button it began on — on
  // drop the row under the pointer's start point can be an empty paragraph;
  // an open menu keeps the face it opened from.
  const face: StripFace =
    dragActive || menuOpen ? menuFace : row.empty ? 'plus' : row.table ? 'table' : 'grip';
  const drags = face !== 'plus';

  return (
    <div
      ref={strip}
      // Which row this handle is for. The strip stands outside the editable
      // element, so this is the only thing that says so — and what a test
      // measuring the alignment has to read, since the row under the pointer
      // is not always the row a pointer was aimed at (a heading's top margin
      // answers for the row above it).
      data-row-id={block.id}
      // `select-none`: the strip is chrome standing in the gutter, and a
      // selection that reaches a selectable element OUTSIDE the body takes
      // everything in between with it — measured 2026-09-18, a pointer over a
      // selectable strip button selected every row from the first one, at
      // every height, while the bare gutter beyond it gave the line's own
      // start. None of this strip is text, so none of it takes part — the same
      // thing the library does for its own chrome (`.bn-trailing-block`,
      // `.bn-toggle-button`). The handle's own half is also covered by the UA
      // style on `[draggable=true]`; this reaches the rest of the strip.
      className='flex select-none items-center gap-0.5'
      style={{ transform: `translateY(${String(offset)}px)` }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        {/* `flex`, so this wrapper is exactly as tall as the handle. As a
            block box it would hold the button in a LINE box instead, and an
            inline-level box sits on that line's baseline — measured 2026-09-19,
            the wrapper came out 26.5px around a 24px button, the 2.5px of
            descent space all below it. The strip is centred on the row's first
            line as a whole, so those 2.5px put the handle 1.25px above the
            words at every type size. */}
        <div className='relative flex'>
          {/* The anchor, and nothing else. It covers the button's box so the
              menu opens beside the handle, and it answers no pointer events
              so Radix's trigger handlers never run. */}
          <DropdownMenuTrigger asChild>
            <span aria-hidden className='pointer-events-none absolute inset-0' />
          </DropdownMenuTrigger>
          <Button
            variant='ghost'
            size={null}
            aria-label={t(
              drags
                ? 'spaces.document.blockHandle.dragTip'
                : 'spaces.document.blockHandle.insertHere',
            )}
            data-testid={TEST_ID[face]}
            className={drags ? `${STRIP_BUTTON} cursor-grab` : STRIP_BUTTON}
            draggable={drags ? true : undefined}
            onDragStart={(event) => {
              setDragActive(true);
              setMenuFace(face);
              endDrag.current = startRowDrag(editor as never, event.nativeEvent, block.id);
            }}
            onDragEnd={() => {
              setDragActive(false);
              endDrag.current?.();
              endDrag.current = null;
            }}
            onClick={() => {
              if (!menuOpen) setMenuFace(face);
              onMenuOpenChange(!menuOpen);
            }}
          >
            <FaceIcon face={face} />
          </Button>
        </div>
        <DropdownMenuContent
          side='bottom'
          align='start'
          // A menu whose contents are rows keeps a gap between them (user
          // 2026-08-27). The bubble bar's own menus are the family this one
          // joins, and theirs measures 4px.
          rowsClassName='flex flex-col gap-1'
          // Back to the body, at the caret the reader left there: the strip is
          // not a place to be after the menu closes, and typing has to land in
          // the document (A11). A row that took the focus somewhere on purpose
          // keeps it there — the comment row's draft box focuses itself before
          // this runs, and the reader is about to type into it (design §9.4.0).
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const holder = document.activeElement;
            const unclaimed =
              holder === null ||
              holder === document.body ||
              holder.closest('[role="menu"]') !== null ||
              holder.closest(`[data-row-id="${block.id}"]`) !== null;
            if (unclaimed) editor.focus();
          }}
        >
          {menuFace === 'table' ? (
            <DocumentBlockMenu
              editor={editor as never}
              block={block}
              close={closeMenu}
              rows={TABLE_MENU_ROWS}
            />
          ) : menuFace === 'plus' ? (
            <>
              <DocumentInsertChoices
                onPick={onFill}
                onPickMedia={onFillMedia}
                unreachable={row.quoted ? QUOTE_GREYED : undefined}
              />
              {/* The grip menu's delete row, the one command an empty line
                  still needs (A12). Drawn out of reach on the document's only
                  block, which the schema puts straight back. */}
              <DropdownMenuSeparator className='my-0' />
              <DropdownMenuItem
                data-testid='doc-block-plus-delete'
                className={row.lone ? undefined : 'text-status-error-foreground'}
                {...itemWithin(!row.lone, onDelete)}
              >
                <DELETE_ROW.Icon />
                {t(DELETE_ROW.labelKey)}
              </DropdownMenuItem>
            </>
          ) : (
            <DocumentBlockMenu
              editor={editor as never}
              block={block}
              close={closeMenu}
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
