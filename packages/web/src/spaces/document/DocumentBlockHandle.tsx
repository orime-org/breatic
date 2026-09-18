// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The strip beside the row under the pointer: the drag handle, alone.
 *
 * Handed to `SideMenuController` in place of the library's own strip, which
 * cannot serve here: its handle draws a `react-icons` glyph at a fixed size
 * where the demo asks for lucide at 16 (A2).
 *
 * THE HANDLE IS THE WHOLE STRIP (user 2026-09-18): everything the plus offered
 * is in this handle's own menu, as its insert-below row. It takes no tooltip
 * either (user 2026-09-17) — it is pressed the moment the pointer arrives, and
 * a tip that fades in over the row is in the way of the very gesture it
 * describes. The name stays as `aria-label`.
 *
 * ONE GESTURE (user 2026-09-18, design §8): pressing the handle opens its
 * menu. It is not a drag source — a drag off it moved the row by replaying an
 * HTML snapshot taken at mousedown, which destroyed whatever a co-editor typed
 * into that row while the drag was in flight.
 */

import { SideMenuExtension } from '@blocknote/core/extensions';
import { GripVertical } from 'lucide-react';
import * as React from 'react';

import {
  useBlockNoteEditor,
  useExtension,
  useExtensionState,
} from '@blocknote/react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { useStripOnFirstLine } from '@web/spaces/document/document-strip-alignment';
import { DocumentBlockMenu } from '@web/spaces/document/DocumentBlockMenu';
import type { PressedBlock } from '@web/spaces/document/document-handle-commands';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

/**
 * The handle: 24 square, which is the smallest a pointer target may be
 * (WCAG 2.2 SC 2.5.8), around the demo's 16 icon.
 */
const STRIP_BUTTON = 'size-6 shrink-0 [&_svg]:size-4 text-muted-foreground';

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
    (current) => !current.prosemirrorState.selection.empty,
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

  if (block === undefined || holdsSelection) {
    return null;
  }

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
      // `.bn-toggle-button`). With the handle no longer `draggable`, this is
      // the only thing holding it out of the reader's selection.
      className='flex select-none items-center gap-0.5'
      style={{ transform: `translateY(${String(offset)}px)` }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            variant='ghost'
            size={null}
            aria-label={t('spaces.document.blockHandle.openMenu')}
            data-testid='doc-block-handle'
            className={STRIP_BUTTON}
          >
            <GripVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side='bottom'
          align='start'
          // Back to the body, at the caret the reader left there: the strip is
          // not a place to be after the menu closes, and typing has to land in
          // the document (A11).
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editor.focus();
          }}
        >
          <DocumentBlockMenu
            editor={editor as never}
            block={block}
            close={() => {
              onMenuOpenChange(false);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
