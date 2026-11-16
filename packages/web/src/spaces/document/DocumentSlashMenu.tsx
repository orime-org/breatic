// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The slash menu: typing a slash (or its full-width form, or the ideographic
 * comma, `SLASH_TRIGGERS`) at the start of a line or after a space lists the
 * insert menu's entries under the caret, typing on narrows them, and a pick
 * inserts what the plus menu would (inner#1125).
 *
 * BlockNote's suggestion extension tracks the trigger and the query; what is
 * drawn, the keys and the pick are ours, because the library's controller
 * runs its own "close, clear the query, call back" on Enter and click, which
 * keeps the removal of the query out of the pick's undo step and the size
 * grid away from the arrow keys (design 4). The focus never leaves the body:
 * the keys are read off the editor in the capture phase, and a press anywhere
 * on the menu is cancelled.
 */

import { SuggestionMenu } from '@blocknote/core/extensions';
import { useExtension, useExtensionState } from '@blocknote/react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react';
import type { Transaction } from '@tiptap/pm/state';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { MenuRows, menuItemBase, menuSurface } from '@web/components/ui/dropdown-menu';
import { Separator } from '@web/components/ui/separator';
import { englishMessage } from '@web/i18n/locale-bootstrap';
import { useTranslation } from '@web/i18n/use-translation';
import { keyBelongsToInputMethod, type CompositionEnd } from '@web/lib/composition-end';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { isFreeEscape } from '@web/spaces/canvas/use-escape-in-space';
import { bodyLayerMark } from '@web/spaces/document/document-body-focus';
import { domElementOf, viewOf } from '@web/spaces/document/document-editor-view';
import { compositionEndOf } from '@web/spaces/document/document-enter';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import {
  INSERT_ENTRY_IDS,
  insertEntryGroup,
  insertEntryLook,
  insertReach,
  type InsertEntryId,
} from '@web/spaces/document/document-insert-entries';
import { COLUMNS, type InsertChoice, type TableSize } from '@web/spaces/document/document-insert-row';
import { openFormulaBlock } from '@web/spaces/document/document-math';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';
import { asOneUndoStep, undoOf } from '@web/spaces/document/document-proposal-landing';
import { filterInsertEntries, closesForNoMatch, queryWhileComposing } from '@web/spaces/document/document-slash-filter';
import { landSlashMedia, pickInSlashMenu, slashTyped } from '@web/spaces/document/document-slash-pick';
import { SLASH_TRIGGERS, slashMayOpen, slashMenuShown } from '@web/spaces/document/document-slash-trigger';
import { useDocumentMediaPick } from '@web/spaces/document/DocumentMediaPicker';
import { PlainTableSizeGrid, stepCell } from '@web/spaces/document/DocumentTableSizeGrid';

/** The media entries, which a pick hands to the file picker. */
const MEDIA: ReadonlySet<string> = new Set<MediaBlockType>(['image', 'audio', 'video']);

/** The entries offered where no file can be picked. */
const WITHOUT_MEDIA = INSERT_ENTRY_IDS.filter((id) => !MEDIA.has(id));

/** The gap between the menu and what it opens from, as the insert menu's. */
const GAP = 6;

/** How far the menu keeps off the edges of the body. */
const EDGE = 8;

/** Keys that change nothing on their own, so they leave the size grid open. */
const MODIFIERS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** A tracker that has never seen a composition end, for an editor without one. */
const NEVER_ENDED: CompositionEnd = { mark: () => undefined, justEnded: () => false };

/** The row the menu was opened on, read off the caret. */
interface SlashRow {
  /** The row's block id. */
  readonly blockId: string;
  /** Characters into the row's text where the trigger starts. */
  readonly offset: number;
  /** Whether the row holds nothing but the trigger and the query. */
  readonly bare: boolean;
}

/**
 * The row the caret is in, and where the trigger and query sit in it. The
 * query runs from the trigger to the caret, so the trigger starts that many
 * characters back.
 * @param editor - The editor.
 * @param typed - The trigger and the query.
 * @returns The row, or undefined when the caret is in no row.
 */
function slashRow(editor: HandleEditor, typed: string): SlashRow | undefined {
  const { $from } = editor.prosemirrorState.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== 'blockContainer') continue;
    return {
      blockId: String(node.attrs['id']),
      offset: $from.parentOffset - typed.length,
      bare: $from.parent.content.size === typed.length,
    };
  }
  return undefined;
}

/**
 * Cancels a press so the body keeps the focus and the caret.
 * @param event - The press.
 */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

/**
 * Claims a key for the menu: the body and every listener after it leave it.
 * @param event - The key.
 */
function claim(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Opens the menu over a trigger an input method committed. The extension's
 * own check runs in `handleTextInput`, which a composition passes through
 * while it is still composing, so the trigger is let through there and caught
 * here once the composition ends: removed and typed again by the extension,
 * which anchors the menu on it (design 5.1).
 * @param editor - The editor.
 * @param menu - The suggestion extension.
 * @param trigger - The trigger the composition ended with.
 */
function openAfterComposition(
  editor: HandleEditor,
  menu: ReturnType<typeof useSlashExtension>,
  trigger: string,
): void {
  const view = viewOf(editor);
  if (view === null || slashMenuShown(menu.store.state)) return;
  const { from, empty } = view.state.selection;
  if (!empty || from < trigger.length) return;
  if (view.state.doc.textBetween(from - trigger.length, from) !== trigger) return;
  const tr = view.state.tr.delete(from - trigger.length, from);
  if (!slashMayOpen(tr)) return;
  view.dispatch(tr);
  menu.openSuggestionMenu(trigger, { deleteTriggerCharacter: true });
}

/**
 * The suggestion extension of an editor.
 * @param editor - The editor.
 * @returns The extension.
 */
function useSlashExtension(editor: HandleEditor): NonNullable<ReturnType<ReturnType<typeof SuggestionMenu>>> {
  return useExtension(SuggestionMenu, { editor: editor as never });
}

interface DocumentSlashMenuProps {
  /** The editor the menu serves. */
  editor: HandleEditor;
}

/**
 * Registers the triggers on the body and shows the menu while one is open.
 * Mounted only on a body the user may edit.
 * @param props - See {@link DocumentSlashMenuProps}.
 * @param props.editor - The editor the menu serves.
 * @returns The menu, or null while it is closed.
 */
export function DocumentSlashMenu({ editor }: DocumentSlashMenuProps): React.JSX.Element | null {
  const menu = useSlashExtension(editor);
  const state = useExtensionState(SuggestionMenu, { editor: editor as never });

  React.useEffect(() => {
    // A trigger committed by an input method is caught after the composition
    // ends (`openAfterComposition`); one passing through mid-composition opens
    // nothing, so the composition is never interrupted.
    /**
     * Whether a typed trigger opens the menu here.
     * @param tr - A transaction on the state the trigger is typed into.
     * @returns True outside a composition, at a line start or after a space.
     */
    const shouldOpen = (tr: Transaction): boolean => viewOf(editor)?.composing !== true && slashMayOpen(tr);
    for (const trigger of SLASH_TRIGGERS) menu.addSuggestionMenu({ triggerCharacter: trigger, shouldOpen });
    return () => {
      for (const trigger of SLASH_TRIGGERS) menu.removeSuggestionMenu(trigger);
    };
  }, [editor, menu]);

  React.useEffect(() => {
    // On the document, since the body may not be mounted yet: the capture
    // phase runs before ProseMirror's own `compositionend`, which writes the
    // committed text in a microtask; two hops land after that write.
    /**
     * Catches a trigger a composition ended with.
     * @param event - The composition's end.
     */
    const onEnd = (event: CompositionEvent): void => {
      const dom = domElementOf(editor);
      if (dom === null || !(event.target instanceof Node) || !dom.contains(event.target)) return;
      const trigger = SLASH_TRIGGERS.find((char) => event.data.endsWith(char));
      if (trigger === undefined) return;
      queueMicrotask(() => {
        queueMicrotask(() => {
          openAfterComposition(editor, menu, trigger);
        });
      });
    };
    document.addEventListener('compositionend', onEnd, true);
    return () => {
      document.removeEventListener('compositionend', onEnd, true);
    };
  }, [editor, menu]);

  if (state === undefined || !slashMenuShown(state)) return null;
  return <OpenSlashMenu editor={editor} menu={menu} trigger={state.triggerCharacter} query={state.query} />;
}

interface OpenSlashMenuProps {
  editor: HandleEditor;
  menu: ReturnType<typeof useSlashExtension>;
  /** The trigger that opened the menu. */
  trigger: string;
  /** What is typed after it, up to the caret. */
  query: string;
}

/** The size grid, open for the query it was opened under. */
interface GridState {
  readonly query: string;
  /** The lit cell, or null while none is. */
  readonly at: TableSize | null;
}

/**
 * The menu while it is open: mounted when it opens, so every opening starts
 * on its first row with nothing remembered.
 * @param props - See {@link OpenSlashMenuProps}.
 * @param props.editor - The editor.
 * @param props.menu - The suggestion extension.
 * @param props.trigger - The trigger that opened the menu.
 * @param props.query - What is typed after it.
 * @returns The menu.
 */
function OpenSlashMenu({ editor, menu, trigger, query }: OpenSlashMenuProps): React.JSX.Element {
  const t = useTranslation();
  const mediaPick = useDocumentMediaPick();

  // While an input method composes, its pinyin or kana is in the query; the
  // menu keeps the query from before the composition until it ends (5.3).
  const [frozen, setFrozen] = React.useState<string | null>(null);
  const composing = frozen !== null;
  const filterQuery = queryWhileComposing({ query, composing, before: frozen ?? query });

  const ids = mediaPick === null ? WITHOUT_MEDIA : INSERT_ENTRY_IDS;
  const items = filterInsertEntries(ids, filterQuery, (id) => {
    const key = insertEntryLook(id).labelKey;
    return [t(key), englishMessage(key) ?? ''];
  });

  const typed = trigger + query;
  const row = slashRow(editor, typed);
  const reach = row === undefined
    ? new Set<InsertEntryId>()
    : insertReach(editor.prosemirrorState.doc, row.blockId, row.bare ? 'fill' : 'below');

  // The highlight belongs to the query it was moved under: a new query starts
  // on the first row again, as BlockNote's does.
  const [moved, setMoved] = React.useState({ query: filterQuery, index: 0 });
  const index = moved.query === filterQuery ? Math.min(moved.index, items.length - 1) : 0;
  const highlight = React.useCallback(
    (next: number): void => {
      setMoved({ query: filterQuery, index: next });
    },
    [filterQuery],
  );

  const [gridState, setGrid] = React.useState<GridState | null>(null);
  const grid = gridState !== null && gridState.query === query ? gridState : null;
  const openGrid = React.useCallback(
    (at: TableSize | null): void => {
      setGrid({ query, at });
    },
    [query],
  );
  const closeGrid = React.useCallback((): void => {
    setGrid(null);
  }, []);

  // Closes three characters past the last query that matched (5.3).
  const lastUseful = React.useRef(0);
  const matched = items.length > 0;
  React.useEffect(() => {
    if (closesForNoMatch({ query: filterQuery, matched, lastUsefulLength: lastUseful.current, composing })) {
      menu.closeMenu();
    } else if (matched && !composing) {
      lastUseful.current = filterQuery.length;
    }
  }, [composing, filterQuery, matched, menu]);

  const pick = React.useCallback(
    (id: InsertEntryId, table?: TableSize): void => {
      const now = slashRow(editor, typed);
      if (now === undefined) {
        menu.closeMenu();
        return;
      }
      // Read again at the press: the row may have changed since the render.
      const out = insertReach(editor.prosemirrorState.doc, now.blockId, now.bare ? 'fill' : 'below');
      if (out.has(id)) {
        if (id === COLUMNS) toast.warning(t('spaces.document.columns.unavailable'));
        return;
      }
      if (id === 'table' && table === undefined) {
        openGrid({ rows: 1, cols: 1 });
        return;
      }
      const record = slashTyped(editor, now.blockId, typed, now.offset);
      menu.closeMenu();
      if (record === undefined) return;
      if (MEDIA.has(id)) {
        // The query stays until files are chosen; closing the picker without
        // one leaves the line as it is (5.9).
        mediaPick?.(id as MediaBlockType, (blocks) => {
          let landed = false;
          asOneUndoStep(undoOf(editor), () => {
            landed = landSlashMedia(editor, record, blocks);
          });
          return landed;
        });
        return;
      }
      let formula: string | undefined;
      asOneUndoStep(undoOf(editor), () => {
        formula = pickInSlashMenu(editor, record, table === undefined ? (id as InsertChoice) : { table });
      });
      // The focus is already in the body, so the box can open straight away.
      if (formula !== undefined) openFormulaBlock(editor, formula);
    },
    [editor, mediaPick, menu, openGrid, t, typed],
  );

  // The keys, read before the body sees them, while the menu is open.
  const latest = React.useRef({ items, index, grid, pick, highlight, openGrid, closeGrid, reach });
  latest.current = { items, index, grid, pick, highlight, openGrid, closeGrid, reach };
  React.useEffect(() => {
    const dom = domElementOf(editor);
    if (dom === null) return undefined;
    const ended = compositionEndOf(editor) ?? NEVER_ENDED;
    /**
     * The menu's keys, taken before the body sees them.
     * @param event - The key.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (keyBelongsToInputMethod(event, ended)) return;
      const now = latest.current;
      if (now.grid !== null) {
        const at = now.grid.at;
        if (event.key === 'Escape' || (event.key === 'ArrowLeft' && (at?.cols ?? 1) === 1)) {
          claim(event);
          now.closeGrid();
          return;
        }
        if (event.key === 'Enter') {
          claim(event);
          if (at !== null) now.pick('table', at);
          return;
        }
        // The first arrow on a grid the pointer opened lights its first cell.
        const next = stepCell(at ?? { rows: 1, cols: 1 }, event.key);
        if (next !== undefined) {
          claim(event);
          now.openGrid(at === null ? { rows: 1, cols: 1 } : next);
          return;
        }
        // Anything else goes to the body, as typing: the grid gives way to it.
        if (!MODIFIERS.has(event.key)) now.closeGrid();
        return;
      }
      const count = now.items.length;
      const current = now.items[now.index];
      switch (event.key) {
        case 'ArrowUp':
          claim(event);
          if (count > 0) now.highlight((now.index - 1 + count) % count);
          return;
        case 'ArrowDown':
          claim(event);
          if (count > 0) now.highlight((now.index + 1) % count);
          return;
        case 'PageUp':
          claim(event);
          if (count > 0) now.highlight(0);
          return;
        case 'PageDown':
          claim(event);
          if (count > 0) now.highlight(count - 1);
          return;
        case 'Enter':
          // Swallowed with nothing to pick, so the line is not split.
          claim(event);
          if (current !== undefined) now.pick(current);
          return;
        case 'ArrowRight':
          if (current === 'table' && !now.reach.has('table')) {
            claim(event);
            now.openGrid({ rows: 1, cols: 1 });
          }
          return;
        case 'Escape':
          // The query stays in the line (5.7).
          if (!isFreeEscape(event)) return;
          claim(event);
          menu.closeMenu();
          return;
        default:
      }
    };
    // While an input method composes, the menu keeps what it showed (5.3).
    /** Holds the query from before the composition. */
    const onStart = (): void => {
      setFrozen(menu.store.state?.query ?? '');
    };
    /** Lets the query follow the line again. */
    const onEnd = (): void => {
      setFrozen(null);
    };
    dom.addEventListener('keydown', onKey, true);
    dom.addEventListener('compositionstart', onStart);
    dom.addEventListener('compositionend', onEnd);
    return () => {
      dom.removeEventListener('keydown', onKey, true);
      dom.removeEventListener('compositionstart', onStart);
      dom.removeEventListener('compositionend', onEnd);
    };
  }, [editor, menu]);

  // Anchored on the trigger the extension decorates, read at every
  // measurement: the extension refreshes it on scroll before the menu moves.
  const { refs, floatingStyles, isPositioned, update } = useFloating({
    open: true,
    strategy: 'absolute',
    placement: 'bottom-start',
    middleware: [
      offset(GAP),
      flip({ padding: EDGE }),
      shift({ padding: EDGE }),
      size({
        padding: EDGE,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${String(Math.max(0, availableHeight))}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  React.useLayoutEffect(() => {
    refs.setPositionReference({
      getBoundingClientRect: () => menu.store.state?.referencePos ?? new DOMRect(),
      contextElement: domElementOf(editor) ?? undefined,
    });
  }, [editor, menu, refs]);
  const referencePos = menu.store.state?.referencePos;
  React.useEffect(() => {
    update();
  }, [referencePos, update]);

  // The size grid stands beside the table row, as a submenu does.
  const gridFloat = useFloating({
    open: grid !== null,
    strategy: 'absolute',
    placement: 'right-start',
    middleware: [offset({ mainAxis: 4 + 5, alignmentAxis: -5 }), flip({ padding: EDGE }), shift({ padding: EDGE })],
    whileElementsMounted: autoUpdate,
  });

  // The lit row stays in sight, scrolling the menu's own list only.
  const rowsRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const lit = rowsRef.current?.querySelector<HTMLElement>('[data-highlighted]');
    const scroller = lit?.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (lit === undefined || lit === null || scroller === null || scroller === undefined) return;
    const box = lit.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top) scroller.scrollTo({ top: scroller.scrollTop + box.top - view.top });
    else if (box.bottom > view.bottom) scroller.scrollTo({ top: scroller.scrollTop + box.bottom - view.bottom });
  }, [index, filterQuery]);

  const onGridPick = React.useCallback(
    (at: TableSize): void => {
      pick('table', at);
    },
    [pick],
  );
  const onGridHover = React.useCallback(
    (at: TableSize): void => {
      openGrid(at);
    },
    [openGrid],
  );

  const scroller = domElementOf(editor)?.closest<HTMLElement>('[data-radix-scroll-area-viewport]') ?? undefined;
  const layer = bodyLayerMark(editor, { block: row?.blockId ?? '' });

  return (
    <FloatingPortal root={scroller}>
      <div
        ref={refs.setFloating}
        // Faded in once placed, so the first frame at the library's origin is not seen.
        style={{ ...floatingStyles, opacity: isPositioned ? 1 : 0 }}
        data-testid='doc-slash-menu'
        // Nothing on the menu takes the focus from the body: rows, scrollbar,
        // rules, padding and the empty line alike (5.4).
        onMouseDownCapture={keepFocus}
        className={cn(menuSurface, 'min-w-[10rem]')}
        {...layer}
      >
        <MenuRows rowsClassName='flex flex-col gap-1'>
          <div ref={rowsRef} className='contents'>
            {items.length === 0 ? (
              <div data-testid='doc-slash-empty' className='px-2 py-1.5 text-sm text-muted-foreground'>
                {t('spaces.document.slashMenu.empty')}
              </div>
            ) : (
              items.map((id, at) => {
                const { Icon, labelKey } = insertEntryLook(id);
                const out = reach.has(id);
                const ruled = at > 0 && insertEntryGroup(items[at - 1] ?? id) !== insertEntryGroup(id);
                return (
                  <React.Fragment key={id}>
                    {ruled ? <Separator className='-mx-1 w-auto' /> : null}
                    <Button
                      ref={id === 'table' ? gridFloat.refs.setReference : undefined}
                      variant={null}
                      size={null}
                      tabIndex={-1}
                      data-testid={`doc-slash-row-${id}`}
                      data-highlighted={at === index ? '' : undefined}
                      aria-disabled={out ? 'true' : undefined}
                      className={cn(
                        menuItemBase,
                        'w-full justify-start font-normal data-[highlighted]:bg-accent',
                        out && 'cursor-not-allowed opacity-50',
                        id === 'table' && grid !== null && 'bg-accent',
                      )}
                      onMouseEnter={() => {
                        // A row out of reach does not light up under the
                        // pointer, as in the insert menu.
                        if (out) return;
                        highlight(at);
                        if (id === 'table') openGrid(null);
                        else closeGrid();
                      }}
                      onMouseDown={() => {
                        if (id === 'table' && !out) openGrid(null);
                        else pick(id);
                      }}
                    >
                      <Icon />
                      {t(labelKey)}
                    </Button>
                  </React.Fragment>
                );
              })
            )}
          </div>
        </MenuRows>
      </div>
      {grid === null ? null : (
        <div
          ref={gridFloat.refs.setFloating}
          style={gridFloat.floatingStyles}
          data-testid='doc-slash-table-grid'
          onMouseDownCapture={keepFocus}
          className={menuSurface}
          {...layer}
        >
          <MenuRows>
            <PlainTableSizeGrid at={grid.at} onHover={onGridHover} onPick={onGridPick} />
          </MenuRows>
        </div>
      )}
    </FloatingPortal>
  );
}
