// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The `@` suggestion wiring shared by every editor with reference chips:
 * typing `@` opens a caret-anchored popup of rows the caller supplies, and
 * picking one inserts the content the caller builds for it. Rows are read
 * through a resolver on every show, so the editor is never rebuilt when what
 * can be picked changes; the popup is positioned by floating-ui and rendered
 * via TipTap's ReactRenderer.
 */

import type { Editor } from '@tiptap/core';
import { autoUpdate, computePosition, offset, type Placement } from '@floating-ui/dom';
import type { Transaction } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import {
  exitSuggestion,
  findSuggestionMatch,
  SuggestionPluginKey,
  type SuggestionKeyDownProps,
  type SuggestionMatch,
  type SuggestionOptions,
  type SuggestionProps,
  type Trigger,
} from '@tiptap/suggestion';
import type * as React from 'react';

import {
  MentionList,
  type MentionListProps,
  type MentionListRef,
} from '@web/features/reference-mention/mention-list';
import { wasLastChangeLocalUserInput } from '@web/features/reference-mention/reference-mention-local-input';

/**
 * What opens the list: `@`, and the full-width at sign (U+FF20) a Chinese,
 * Japanese or Korean input method types in full-width mode.
 */
const AT_SIGNS = ['@', '\uFF20'] as const;

/**
 * The `@` match nearest the caret, whichever at sign opened it.
 * @param config - The plugin's trigger config for this position.
 * @returns The match, or null when the caret is in none.
 */
function matchEitherAtSign(config: Trigger): SuggestionMatch {
  let nearest: SuggestionMatch = null;
  for (const char of AT_SIGNS) {
    const match = findSuggestionMatch({ ...config, char });
    if (match && (!nearest || match.range.from > nearest.range.from)) nearest = match;
  }
  return nearest;
}

/** A React-ref-shaped holder the open popup writes its `refresh()` into. */
export type RefreshHandleRef = { current: (() => void) | null };

/** What an editor tells the shared `@` list. */
export interface MentionSuggestionInput<T> {
  /**
   * The rows for a query, and — when there are none — which empty-state
   * sentence is true. Called on every show, so it reads live inputs.
   */
  resolveList: (query: string) => { items: T[]; emptyLabel: string };
  /** The node content a picked row is inserted as. */
  content: (item: T) => { type: string; attrs: Record<string, unknown> };
  /** A stable key for a row. */
  itemKey: (item: T) => string;
  /** What a row shows. */
  renderItem: (item: T) => React.ReactNode;
  /** Where the popup sits against the caret. */
  placement: Placement;
  /**
   * Ref the open popup writes a `refresh()` into. The caller runs it when what
   * `resolveList` reads changes without an edit in this editor, which the
   * plugin would otherwise never see.
   */
  refreshRef?: RefreshHandleRef;
  /** Whether the last transaction was a local keystroke; injectable for tests. */
  isLocalUserInput?: (editor: Editor) => boolean;
}

/**
 * Builds the `@` suggestion options.
 * @param input - What the editor supplies.
 * @returns The suggestion options (without `editor`, supplied by the extension).
 */
export function makeMentionSuggestion<T>(
  input: MentionSuggestionInput<T>,
): Omit<SuggestionOptions<T>, 'editor'> {
  const isLocalUserInput = input.isLocalUserInput ?? wasLastChangeLocalUserInput;
  const resolveList = input.resolveList;
  return {
    char: '@',
    findSuggestionMatch: matchEitherAtSign,
    // @tiptap/suggestion defaults allowedPrefixes to [" "], which only fires `@`
    // when preceded by a space or at block start — so typing `@` right after
    // text (e.g. directly after a CJK character, where no space precedes it)
    // never opened the picker. null lets `@` trigger after any character
    // (Notion / Feishu behaviour).
    allowedPrefixes: null,
    // The plugin's own resolver. Its RESULT is not what the popup renders —
    // every show path calls `resolveList` itself, because the rows the plugin
    // hands back arrive a microtask late and an empty list arrives first. It
    // stays wired because the plugin drives its `loading` state and its abort
    // handling off this call.
    items: ({ query }): T[] => resolveList(query).items,
    command: ({ editor, range, props }): void => {
      editor.chain().focus().insertContentAt(range, input.content(props)).run();
    },
    render: () => {
      let component: ReactRenderer<MentionListRef, MentionListProps<T>> | null = null;
      let el: HTMLDivElement | null = null;
      /** floating-ui autoUpdate teardown — keeps the popup glued to the caret. */
      let stopAutoUpdate: (() => void) | null = null;
      /** Document-level outside-click dismisser. */
      let onOutsidePointerDown: ((event: PointerEvent) => void) | null = null;
      /**
       * Consumer A (#1805): re-shows a hidden popup on a LOCAL caret-placement
       * transaction (selection-only). Held for teardown via editor.off.
       */
      let onEditorTransaction:
        | ((payload: { transaction: Transaction }) => void)
        | null = null;
      /**
       * Consumer B (#1805): re-shows a hidden popup on a SAME-POSITION click
       * back into the active `@` range (the one case that fires no transaction).
       */
      let onEditorClick: ((event: MouseEvent) => void) | null = null;
      /**
       * The latest suggestion props (from onStart / onUpdate): `command` is bound
       * to the live `@` range and `query` is the current filter text. The focus
       * re-show path reads these to recompute a FRESH list, so a popup hidden by
       * a click elsewhere never re-shows a stale one (#1799 / #1800).
       */
      let latestProps: SuggestionProps<T> | null = null;
      /**
       * Whether the popup should be on screen right now.
       *
       * ONE variable, and {@link applyVisibility} is the only thing that writes
       * it into the DOM. It used to be two — a dismissal flag plus whatever
       * `el.style.display` happened to say — because a popup could be hidden
       * for a second reason: zero matches. That reason is gone (#1952, the
       * popup is always shown and says a sentence instead), which left the two
       * always carrying the same answer.
       *
       * False means the user closed it, or something other than the user put
       * an `@` in range. A remote collaborator's edit fires onUpdate exactly
       * like local typing (a peer inserting before the `@` shifts the range),
       * so content refreshes must not touch this (collaboration residual 1).
       */
      let visible = false;
      /**
       * Updates the popup's list CONTENT only — never its visibility. The pick
       * command is read live from {@link latestProps} (bound to the current `@`
       * range). Split from visibility so a remote change can refresh content while
       * leaving a closed / open popup's shown-state untouched.
       *
       * Takes a QUERY, not a row array, and resolves the rows itself. That is
       * deliberate: `@tiptap/suggestion` resolves items through an async
       * pipeline and hands the callbacks an EMPTY `props.items` until it
       * settles, so a call site free to pass its own array can quietly feed the
       * popup the wrong source. Accepting only a query makes that impossible.
       * @param query - The text typed after `@`.
       */
      const updateContent = (query: string): void => {
        const { items, emptyLabel } = resolveList(query);
        component?.updateProps({
          items,
          query,
          command: (item: T) => latestProps?.command(item),
          emptyLabel,
          itemKey: input.itemKey,
          renderItem: input.renderItem,
        });
      };

      /**
       * Writes {@link visible} into the DOM. The only place that touches
       * `el.style.display`, so intent and appearance cannot drift apart.
       */
      const applyVisibility = (): void => {
        if (el) el.style.display = visible ? '' : 'none';
      };

      /**
       * Re-shows a HIDDEN popup when the LOCAL user has placed the caret back
       * inside the still-active `@` range (#1805). The suggestion plugin's OWN
       * settled state is the single range truth: `st.active` is computed by the
       * plugin from the settled selection with its strict bounds, so reading it
       * at a point ORDERED AFTER the caret settles (a transaction, or a click —
       * which fires after mouseup's selection dispatch) needs no timer, no
       * geometry, no gesture heuristic (the v1 focus+timer and v2 posAtCoords /
       * 500ms designs both raced the settle and were killed at Gate 1). Recomputes
       * the list, so a change since the popup was hidden is reflected. No-op unless the popup is hidden AND the plugin is
       * active with an empty selection. Never resurrects a popup that is not
       * plugin-active, so a genuine exit (space / delete / cursor-leave) stays gone.
       * @param editor - The editor (its settled state is read live).
       */
      const reshowIfActiveHidden = (editor: Editor): void => {
        if (!el || visible) return;
        const st = SuggestionPluginKey.getState(editor.state) as
          | { active?: boolean; query?: string }
          | undefined;
        if (st?.active !== true || !editor.state.selection.empty) return;
        visible = true;
        updateContent(st.query ?? '');
        applyVisibility();
      };

      /**
       * Anchors the popup to the caret and KEEPS it anchored via floating-ui
       * autoUpdate: the editor can move without a keystroke (a scroll, or a CSS
       * transform on an ancestor, which fires no scroll event). The virtual
       * reference returns the LIVE caret rect each call, polled every
       * animation frame.
       * @param clientRect - The suggestion's live caret rect getter.
       */
      const place = (
        clientRect: SuggestionProps<T>['clientRect'],
      ): void => {
        if (!el || !clientRect) return;
        const reference = {
          getBoundingClientRect: () => clientRect() ?? new DOMRect(),
        };
        stopAutoUpdate?.();
        stopAutoUpdate = autoUpdate(
          reference,
          el,
          () => {
            // Skip repositioning when the caret rect is momentarily unresolvable
            // — keep the last good position rather than snapping to (0,0) (the
            // `?? new DOMRect()` fallback would otherwise place the popup at the
            // viewport corner). Restores the pre-autoUpdate `if (!rect) return`.
            if (!el || !clientRect()) return;
            void computePosition(reference, el, {
              // No flip / shift (user 2026-07-20): the list stays on its `@` and
              // clips at the viewport edge. Collision middleware would keep it
              // on screen after the caret moved off, away from the `@`.
              placement: input.placement,
              middleware: [offset(6)],
            }).then(({ x, y }) => {
              if (!el) return;
              el.style.left = `${x}px`;
              el.style.top = `${y}px`;
            });
          },
          { animationFrame: true },
        );
      };

      return {
        onStart: (props: SuggestionProps<T>): void => {
          latestProps = props;
          // Seeded from `resolveList`, NOT from `props.items`. @tiptap/suggestion
          // resolves items through an async pipeline (so a remote resolver can be
          // awaited and aborted): every callback is handed `initialItems ?? []`
          // first — and we configure no `initialItems`, so that is always EMPTY —
          // with the real rows arriving on a later onUpdate. `resolveList` is
          // the single source for every path here.
          component = new ReactRenderer(MentionList as React.ComponentType<MentionListProps<T>>, {
            props: {
              ...resolveList(props.query),
              query: props.query,
              command: (item: T) => latestProps?.command(item),
              itemKey: input.itemKey,
              renderItem: input.renderItem,
            },
            editor: props.editor,
          });
          el = document.createElement('div');
          el.style.position = 'absolute';
          el.style.top = '0';
          el.style.left = '0';
          el.style.zIndex = '50';
          el.appendChild(component.element);
          document.body.appendChild(el);
          // What the list reads can change with no transaction in this editor,
          // so the plugin never re-runs items() and an open popup would keep a
          // stale list. The caller runs this refresh when that happens.
          if (input.refreshRef) {
            input.refreshRef.current = (): void => {
              // CONTENT only, and only while on screen. It never opens or closes
              // anything: a popup the user closed stays closed, and an emptied
              // list shows a sentence rather than disappearing (#1952).
              if (el && visible && latestProps) updateContent(latestProps.query);
            };
          }
          // Clicking outside the popup AND the editor does NOT move the ProseMirror selection, so the suggestion
          // would otherwise stay open floating over the UI. Just HIDE the popup
          // — do NOT exitSuggestion (B2, user 2026-07-12): exitSuggestion marks
          // the active `@` range permanently exited, so after a blur-and-back
          // the user's continued typing never re-opened the picker until the
          // editor remounted (close/reopen panel). Hiding keeps the plugin
          // active, so re-focusing and typing re-shows it via onUpdate; a
          // genuine break of the `@` match (space, deleting the `@`, cursor
          // leaving the range) still exits the plugin naturally → onExit removes
          // the popup. Capture phase, so a click whose handler stops
          // propagation is still seen.
          onOutsidePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (
              el &&
              target &&
              !el.contains(target) &&
              !props.editor.view.dom.contains(target)
            ) {
              visible = false; // user closed it — a remote edit must not re-open
              applyVisibility();
            }
          };
          document.addEventListener('pointerdown', onOutsidePointerDown, true);
          // Re-show a hidden popup when the LOCAL user clicks / arrows the caret
          // back into the still-active `@` range (#1805): the outside-click
          // handler HIDES the popup (display:none) without exiting the suggestion
          // (B2), and @tiptap/suggestion only re-fires onUpdate on a query / range
          // change — so a caret placement that neither moves the range nor changes
          // the query left the popup stuck hidden until a keystroke. Two
          // settle-driven consumers cover it (a focus+timer re-show raced the
          // click's selection settle and was killed at Gate 1):
          // Consumer A — a LOCAL caret-placement TRANSACTION (selection-only): the
          // 'transaction' event fires AFTER the tr applied, so the plugin's
          // st.active is the settled in-range verdict. Doc changes flow through
          // the plugin's own onStart/onUpdate; remote / machine selection moves
          // are excluded by isLocalUserInput (residual 1 preserved).
          onEditorTransaction = ({
            transaction,
          }: {
            transaction: Transaction;
          }): void => {
            if (!transaction.selectionSet || transaction.docChanged) return;
            if (!isLocalUserInput(props.editor)) return;
            reshowIfActiveHidden(props.editor);
          };
          props.editor.on('transaction', onEditorTransaction);
          // Consumer B — a SAME-POSITION click back (the one case with NO
          // transaction: the caret never left the range). 'click' fires after
          // mouseup's selection dispatch, so the state is settled. AGREEMENT gate:
          // the click's geometry must match the current caret (posAtCoords ===
          // selection.from) — a moved-caret click either already settled (Consumer
          // A handled it) or will (defer to A). Showing only on agreement makes a
          // flash structurally impossible (nothing shows unless the settled caret
          // already validates the click's own coordinates).
          onEditorClick = (event: MouseEvent): void => {
            if (!el || visible) return;
            const pos = props.editor.view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            if (!pos || pos.pos !== props.editor.state.selection.from) return;
            reshowIfActiveHidden(props.editor);
          };
          props.editor.view.dom.addEventListener('click', onEditorClick);
          // Decide the initial visibility. A LOCAL start — the user typed `@` —
          // shows, whatever the list holds (#1952: an empty list is a sentence,
          // not a disappearance). Anything else reaching
          // onStart must NOT pop a picker this user never opened (residual 1):
          // a remote peer's edit, or a local machine-derived cascade, can put an
          // `@` in range without any intent behind it.
          //
          // There used to be a second way to keep it open, for the case where
          // @tiptap/suggestion re-fired start (onExit → onStart in one update)
          // on an edit that both moved the range and changed the query — that
          // restart would otherwise flicker away a picker in active use. 3.29
          // rewrote view.update() into a three-way choice (started / stopped /
          // updated), so a moved-and-changed edit now yields `updated` alone and
          // that restart cannot happen. Measured against the real plugin: typing,
          // a remote insert before the `@`, and a whole-paragraph setContent all
          // produce update-only sequences; the only EXIT observed (typing a
          // space) is terminal, with no START behind it.
          visible = isLocalUserInput(props.editor);
          applyVisibility();
          place(props.clientRect);
        },
        onUpdate: (props: SuggestionProps<T>): void => {
          latestProps = props;
          // ALWAYS refresh the list content so an open popup stays current. But
          // OPEN one only on a genuine LOCAL KEYSTROKE: a remote peer's edit —
          // OR a machine-derived local dispatch (the edge-driven cascade-clear
          // deleting a chip before the `@`) — shifts the range and fires
          // onUpdate identically to local typing, and must NOT re-open a popup
          // the user closed (residual 1; the round-4 hole was that the old
          // "not remote" test let the local cascade through).
          updateContent(props.query);
          if (isLocalUserInput(props.editor)) {
            // Local keystroke = the user re-engaging, so it re-opens a popup
            // they had closed. A non-local change refreshes content only —
            // there is nothing left for it to decide about visibility now that
            // an empty list is shown rather than hidden.
            visible = true;
            applyVisibility();
          }
          place(props.clientRect);
        },
        onKeyDown: (props: SuggestionKeyDownProps): boolean => {
          // A list the reader closed (or never saw) takes no keys: Enter is
          // theirs again, to send or to break the line.
          if (!visible) return false;
          if (component?.ref?.onKeyDown(props.event) === true) return true;
          // Enter or Tab with nothing to pick ends the `@` there, leaving what
          // was typed as plain text; it neither sends nor breaks the line.
          if (props.event.key === 'Enter' || props.event.key === 'Tab') {
            exitSuggestion(props.view);
            return true;
          }
          return false;
        },
        onExit: (props: SuggestionProps<T>): void => {
          stopAutoUpdate?.();
          stopAutoUpdate = null;
          if (onOutsidePointerDown) {
            document.removeEventListener(
              'pointerdown',
              onOutsidePointerDown,
              true,
            );
            onOutsidePointerDown = null;
          }
          if (onEditorTransaction) {
            props.editor.off('transaction', onEditorTransaction);
            onEditorTransaction = null;
          }
          if (onEditorClick) {
            props.editor.view.dom.removeEventListener('click', onEditorClick);
            onEditorClick = null;
          }
          if (input.refreshRef) input.refreshRef.current = null;
          visible = false;
          latestProps = null;
          el?.remove();
          el = null;
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
