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
 * keeps the removal of the query out of the pick's undo step (design 4). The
 * focus never leaves the body:
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
  INSERT_ENTRY_IDS_WITHOUT_MEDIA,
  MEDIA_ENTRY_IDS,
  insertEntryLook,
  insertReach,
  ruleBetween,
  type InsertEntryId,
} from '@web/spaces/document/document-insert-entries';
import { COLUMNS, type InsertChoice, type TableSize } from '@web/spaces/document/document-insert-row';
import { openFormulaBlock } from '@web/spaces/document/document-math';
import { UNAVAILABLE_KEYBOARD_FOCUS_ONLY } from '@web/spaces/document/document-unavailable-control';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';
import { asOneUndoStep, undoOf } from '@web/spaces/document/document-proposal-landing';
import { filterInsertEntries, closesForNoMatch } from '@web/spaces/document/document-slash-filter';
import { landSlashMedia, pickInSlashMenu, slashTyped } from '@web/spaces/document/document-slash-pick';
import { SLASH_TRIGGERS, slashMayOpen, slashMenuShown } from '@web/spaces/document/document-slash-trigger';
import { useDocumentMediaPick } from '@web/spaces/document/DocumentMediaPicker';


/** The gap between the menu and what it opens from, as the insert menu's. */
const GAP = 6;

/** How far the menu keeps off the edges of the body. */
const EDGE = 8;

/**
 * The table Table puts in: an empty 3x3, as Confluence's and Outline's slash
 * menus do; its size is changed afterwards with the row and column handles
 * (design 5.8).
 */
const SLASH_TABLE: TableSize = { rows: 3, cols: 3 };

/** A tracker that has never seen a composition end, for an editor without one. */
const NEVER_ENDED: CompositionEnd = { mark: () => undefined, justEnded: () => false };

/** The row the menu was opened on, read off the caret. */
interface SlashRow {
  /** The row's block id. */
  readonly blockId: string;
  /** Positions into the row's content where the trigger starts. */
  readonly offset: number;
  /** Whether the row holds nothing but the trigger and the query. */
  readonly bare: boolean;
}

/**
 * The row the caret is in, and where the trigger and query sit in it. The
 * query runs from the trigger to the caret, so the trigger starts that many
 * positions back.
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

/** Where the pointer was at the last move the document saw, or null before any. */
type PointerAt = React.RefObject<{ readonly x: number; readonly y: number } | null>;

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
 * here once the composition ends. The menu opens the way `handleTextInput`
 * opens it, with the extension's meta on a transaction that writes nothing,
 * so the line and the undo history stay as the input method left them
 * (design 5.1).
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
  const plugin = menu.prosemirrorPlugins?.[0];
  if (view === null || plugin === undefined || slashMenuShown(menu.store.state)) return;
  const { from, empty } = view.state.selection;
  if (!empty || from < trigger.length) return;
  if (view.state.doc.textBetween(from - trigger.length, from) !== trigger) return;
  if (!slashMayOpen(view.state.tr.delete(from - trigger.length, from))) return;
  view.dispatch(view.state.tr.setMeta(plugin, { triggerCharacter: trigger }).scrollIntoView());
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
  const pointer: PointerAt = React.useRef(null);

  React.useEffect(() => {
    // At the bubble phase of the document, after the menu's own handlers have
    // compared the move with the one before it.
    /**
     * Records where the pointer is.
     * @param event - A move.
     */
    const onMove = (event: MouseEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('mousemove', onMove);
    };
  }, []);

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
  // The extension draws a fresh id for every opening and carries it unchanged
  // while that menu stays open, so a trigger typed with a menu already open
  // remounts the menu.
  const opening = menu.prosemirrorPlugins?.[0]?.getState(editor.prosemirrorState) as { decorationId?: string } | undefined;
  return (
    <OpenSlashMenu
      key={opening?.decorationId}
      editor={editor}
      pointer={pointer}
      menu={menu}
      trigger={state.triggerCharacter}
      query={state.query}
    />
  );
}

interface OpenSlashMenuProps {
  editor: HandleEditor;
  menu: ReturnType<typeof useSlashExtension>;
  /** The trigger that opened the menu. */
  trigger: string;
  /** What is typed after it, up to the caret. */
  query: string;
  /** Where the pointer was at the last move. */
  pointer: PointerAt;
}

/**
 * The menu while it is open: mounted when it opens, so every opening starts
 * on its first row with nothing remembered.
 * @param props - See {@link OpenSlashMenuProps}.
 * @param props.editor - The editor.
 * @param props.menu - The suggestion extension.
 * @param props.trigger - The trigger that opened the menu.
 * @param props.query - What is typed after it.
 * @param props.pointer - Where the pointer was at the last move.
 * @returns The menu.
 */
function OpenSlashMenu({ editor, menu, trigger, query, pointer }: OpenSlashMenuProps): React.JSX.Element {
  const t = useTranslation();
  const mediaPick = useDocumentMediaPick();

  // While an input method composes, its pinyin or kana is in the query; the
  // menu keeps the query from before the composition until it ends (5.3).
  const [frozen, setFrozen] = React.useState<string | null>(null);
  const composing = frozen !== null;
  const filterQuery = frozen ?? query;

  // WebKit sends a move where the pointer already was when the list or the
  // body scrolls under a pointer at rest; it must not light the row that
  // scrolled under it. Dropped at the capture phase of the menu surface.
  const ignoreStillPointer = React.useCallback(
    (event: React.MouseEvent): void => {
      const at = pointer.current;
      if (at !== null && at.x === event.clientX && at.y === event.clientY) event.stopPropagation();
    },
    [pointer],
  );

  const ids = mediaPick === null ? INSERT_ENTRY_IDS_WITHOUT_MEDIA : INSERT_ENTRY_IDS;
  const items = filterInsertEntries(ids, filterQuery, (id) => {
    const key = insertEntryLook(id).labelKey;
    return [t(key), englishMessage(key) ?? ''];
  });

  const typed = trigger + query;
  const row = slashRow(editor, typed);
  const reach = row === undefined
    ? new Set<InsertEntryId>()
    : insertReach(editor.prosemirrorState.doc, row.blockId, row.bare ? 'fill' : 'below');

  // The highlight belongs to the query it was moved under: any change of query
  // starts on the first row again, as BlockNote's does, so a query typed and
  // taken back does not bring an old highlight back.
  const [moved, setMoved] = React.useState({ query: filterQuery, index: 0 });
  if (moved.query !== filterQuery) setMoved({ query: filterQuery, index: 0 });
  const index = Math.min(moved.index, items.length - 1);
  const highlight = React.useCallback(
    (next: number): void => {
      // The same row again keeps the state, so a pointer moving along a lit
      // row renders nothing.
      setMoved((now) => (now.query === filterQuery && now.index === next ? now : { query: filterQuery, index: next }));
    },
    [filterQuery],
  );

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
    (id: InsertEntryId): void => {
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
      const record = slashTyped(editor, now.blockId, typed, now.offset);
      menu.closeMenu();
      if (record === undefined) return;
      if (MEDIA_ENTRY_IDS.has(id)) {
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
        formula = pickInSlashMenu(editor, record, id === 'table' ? { table: SLASH_TABLE } : (id as InsertChoice));
      });
      // The focus is already in the body, so the box can open straight away.
      if (formula !== undefined) openFormulaBlock(editor, formula);
    },
    [editor, mediaPick, menu, t, typed],
  );

  // The keys, read before the body sees them, while the menu is open.
  const latest = React.useRef({ items, index, pick, highlight });
  latest.current = { items, index, pick, highlight };
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

  // Anchored on the trigger the extension decorates, read live at every
  // measurement: the extension's own rect is refreshed only on a transaction
  // or a scroll, and a reflow (a narrower window) moves the trigger too.
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
      getBoundingClientRect: () =>
        domElementOf(editor)?.querySelector('.bn-suggestion-decorator')?.getBoundingClientRect() ??
        menu.store.state?.referencePos ??
        new DOMRect(),
      contextElement: domElementOf(editor) ?? undefined,
    });
  }, [editor, menu, refs]);
  const referencePos = menu.store.state?.referencePos;
  React.useEffect(() => {
    update();
  }, [referencePos, update]);

  // The lit row stays in sight, scrolling the menu's own list only.
  React.useEffect(() => {
    const lit = refs.floating.current?.querySelector<HTMLElement>('[data-highlighted]');
    const scroller = lit?.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (lit === undefined || lit === null || scroller === null || scroller === undefined) return;
    const box = lit.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top) scroller.scrollTo({ top: scroller.scrollTop + box.top - view.top });
    else if (box.bottom > view.bottom) scroller.scrollTo({ top: scroller.scrollTop + box.bottom - view.bottom });
  }, [index, filterQuery, refs]);

  const scroller = domElementOf(editor)?.closest<HTMLElement>('[data-radix-scroll-area-viewport]') ?? undefined;
  const layer = bodyLayerMark(editor, { block: row?.blockId ?? '' });

  return (
    <FloatingPortal root={scroller}>
      <div
        ref={refs.setFloating}
        // Faded in once placed, so the first frame at the library's origin is not seen.
        style={{ ...floatingStyles, opacity: isPositioned ? 1 : 0 }}
        data-testid='doc-slash-menu'
        onMouseMoveCapture={ignoreStillPointer}
        // Nothing on the menu takes the focus from the body: rows, scrollbar,
        // rules, padding and the empty line alike (5.4).
        onMouseDownCapture={keepFocus}
        className={cn(menuSurface, 'min-w-[10rem]')}
        {...layer}
      >
        <MenuRows rowsClassName='flex flex-col gap-1'>
          {items.length === 0 ? (
            <div data-testid='doc-slash-empty' className='px-2 py-1.5 text-sm text-muted-foreground'>
              {t('spaces.document.slashMenu.empty')}
            </div>
          ) : (
            items.map((id, at) => {
              const { Icon, labelKey } = insertEntryLook(id);
              const out = reach.has(id);
              const ruled = ruleBetween(items[at - 1], id);
              /** The pointer on a row: lights it. */
              const hover = (): void => {
                // A row out of reach does not light up under the pointer,
                // as in the insert menu.
                if (!out) highlight(at);
              };
              // Only a pointer that moves lights a row, as Radix menu items
              // do: a list scrolled under a still pointer lights nothing.
              const handlers = {
                onMouseMove: hover,
                onMouseDown: (event: React.MouseEvent): void => {
                  // Only the main button picks, as in the insert menu;
                  // Control with it is the secondary click on a Mac.
                  if (event.button !== 0 || event.ctrlKey) return;
                  pick(id);
                },
              };
              return (
                <React.Fragment key={id}>
                  {ruled ? <Separator className='-mx-1 w-auto' /> : null}
                  <Button
                    variant={null}
                    size={null}
                    tabIndex={-1}
                    data-testid={`doc-slash-row-${id}`}
                    data-highlighted={at === index ? '' : undefined}
                    aria-disabled={out ? 'true' : undefined}
                    className={cn(
                      menuItemBase,
                      'w-full justify-start font-normal data-[highlighted]:bg-accent',
                      out && UNAVAILABLE_KEYBOARD_FOCUS_ONLY,
                    )}
                    {...handlers}
                  >
                    <Icon />
                    {t(labelKey)}
                  </Button>
                </React.Fragment>
              );
            })
          )}
        </MenuRows>
      </div>
    </FloatingPortal>
  );
}
