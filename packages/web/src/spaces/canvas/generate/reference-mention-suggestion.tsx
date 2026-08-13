// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The `@` suggestion wiring for the reference-mention node: typing `@` opens a
 * caret-anchored popup of the current connection reference pool, and picking a
 * row inserts a reference-mention atom carrying the stable `sourceNodeId` plus a
 * snapshot thumbnail / label (design 2026-07-10 §2.2). The pool is read through
 * a getter so the editor is never rebuilt when incoming edges change; the popup
 * is positioned by floating-ui and rendered via TipTap's ReactRenderer.
 */

import type { Editor } from '@tiptap/core';
import { autoUpdate, computePosition, offset } from '@floating-ui/dom';
import type { Transaction } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import {
  SuggestionPluginKey,
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from '@tiptap/suggestion';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { referenceMentionContent } from '@web/spaces/canvas/generate/reference-mention';
import {
  insertRefusal,
  type ReferenceModeContext,
} from '@web/spaces/canvas/generate/reference-usability';
import { wasLastChangeLocalUserInput } from '@web/spaces/canvas/generate/reference-mention-local-input';
import {
  ReferenceMentionList,
  type ReferenceMentionListRef,
} from '@web/spaces/canvas/generate/reference-mention-list';

/** A React-ref-shaped holder the open popup writes its `refresh()` into. */
type RefreshHandleRef = { current: (() => void) | null };

/**
 * Default mode context: references are in play and every modality is on offer.
 * Used when no getter is wired, so a caller that does not know the mode is not
 * silently narrowed down to nothing.
 */
const ANY_MODE: ReferenceModeContext = { takesReferences: true };

/**
 * Builds the `@` suggestion options for the reference-mention node.
 * @param input - Wiring inputs.
 * @param input.getPool - Reads the CURRENT reference pool (incoming edges); a
 *   getter so the editor need not rebuild when the pool changes.
 * @param input.emptyLabel - Localized empty-state text for the popup.
 * @param input.getModeContext - Live getter for what the active mode does with
 *   references; rows the mode cannot consume are left out of the picker
 *   entirely — absent from the list, not listed and greyed (user
 *   2026-08-13). A getter
 *   because the mode lives on the canvas node, not in the prompt doc.
 *   Optional (default: offer everything).
 * @param input.refreshRef - Ref the open popup writes a `refresh()` into so the
 *   React layer can refresh a visible popup on a remote mode/pool change (residual 2).
 * @param input.isLocalUserInput - Whether the last transaction was a local user
 *   keystroke; defaults to {@link wasLastChangeLocalUserInput}, injectable for tests (residual 1).
 * @returns The suggestion options (without `editor`, supplied by the extension).
 */
export function makeReferenceSuggestion(input: {
  getPool: () => ReferenceRailItem[];
  emptyLabel: string;
  getModeContext?: () => ReferenceModeContext;
  refreshRef?: RefreshHandleRef;
  isLocalUserInput?: (editor: Editor) => boolean;
}): Omit<SuggestionOptions<ReferenceRailItem>, 'editor'> {
  const isLocalUserInput = input.isLocalUserInput ?? wasLastChangeLocalUserInput;
  /**
   * Filters the LIVE pool to the rows offerable for a query under the CURRENT
   * mode. Extracted so every popup show path computes from the same live inputs
   * (`getPool` + `getModeContext`): the plugin's `items()` on each keystroke,
   * AND the focus re-show below. `@tiptap/suggestion` only re-runs `items()` on a
   * query / range change (its `handleChange`), so a mode toggle — which lives on
   * the canvas node, not the prompt doc — never triggered a recompute; a popup
   * hidden (by clicking the mode picker) and re-shown on refocus then kept the
   * pre-toggle list. Computing here on every show path fixes that (#1799/#1800).
   * @param query - The text typed after `@`.
   * @returns The matching pool rows (capped at 8).
   */
  const computeItems = (query: string): ReferenceRailItem[] => {
    const q = query.toLowerCase();
    const modeCtx = input.getModeContext?.() ?? ANY_MODE;
    return (
      input
        .getPool()
        // The SAME call the rail's insert button makes (#1945), which is the
        // point: a row the picker offers must be a row the rail would insert,
        // and they used to answer separately — the rail asked whether the row
        // could connect to an image node, and this filter asked its own copy
        // of that plus a t2i special case. Both were the image panel's
        // question, and on the video panel `audio → video` is a live
        // connection rather than the legacy edge that question assumes.
        .filter((r) => insertRefusal(r.sourceNodeType, modeCtx) === null)
        .filter((r) => (r.sourceNodeName || '').toLowerCase().includes(q))
        .slice(0, 8)
    );
  };
  return {
    char: '@',
    // @tiptap/suggestion defaults allowedPrefixes to [" "], which only fires `@`
    // when preceded by a space or at block start — so typing `@` right after
    // text (e.g. directly after a CJK character, where no space precedes it)
    // never opened the picker. null lets `@` trigger after any character
    // (Notion / Feishu behaviour).
    allowedPrefixes: null,
    // The plugin's own resolver. Its RESULT is not what the popup renders —
    // every show path calls `computeItems` itself (see `showFor`), because the
    // rows the plugin hands back arrive a microtask late and an empty list
    // arrives first. Keeping it wired anyway is deliberate on two counts: the
    // plugin drives its `loading` state and its abort handling off this call,
    // and it is the one public seam through which the filtering rule (the
    // rail's own insertRefusal) can be tested. Both paths run the same
    // function, so there is no second source of truth to drift — only the
    // same cheap filter run twice.
    items: ({ query }): ReferenceRailItem[] => computeItems(query),
    command: ({ editor, range, props }): void => {
      // No trailing space (user 2026-07-10): the gap between adjacent chips
      // stays clickable + visible via the chip-boundary caret plugin
      // (reference-mention-caret.ts).
      editor
        .chain()
        .focus()
        .insertContentAt(range, referenceMentionContent(props))
        .run();
    },
    render: () => {
      let component: ReactRenderer<ReferenceMentionListRef> | null = null;
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
       * re-show path reads these to recompute a FRESH list from the live pool +
       * mode, so a popup hidden by a mode / model click never re-shows a stale
       * list (#1799 / #1800).
       */
      let latestProps: SuggestionProps<ReferenceRailItem> | null = null;
      /**
       * Whether the user DISMISSED the popup (clicked a control outside it).
       * Tracked SEPARATELY from `el.style.display` so a remote collaborator's
       * edit — which fires onUpdate exactly like local typing (a peer inserting
       * before the `@` shifts the range) — refreshes the list CONTENT without
       * resurrecting a popup the user closed (collaboration residual 1). Set on
       * outside-click; cleared when the user re-engages (refocus OR a local edit).
       */
      let dismissed = false;
      /**
       * Updates the popup's list CONTENT only — never its visibility. The pick
       * command is read live from {@link latestProps} (bound to the current `@`
       * range). Split from visibility so a remote change can refresh content while
       * leaving a dismissed / visible popup's shown-state untouched.
       *
       * Takes a QUERY, not a row array, and resolves the rows itself. That is
       * deliberate: `@tiptap/suggestion` resolves items through an async
       * pipeline and hands the callbacks an EMPTY `props.items` until it
       * settles, so a call site free to pass its own array can quietly feed the
       * popup the wrong source. Accepting only a query makes that impossible.
       * @param query - The text typed after `@`.
       */
      const updateContent = (query: string): void => {
        component?.updateProps({
          items: computeItems(query),
          command: (item: ReferenceRailItem) => latestProps?.command(item),
          emptyLabel: input.emptyLabel,
        });
      };

      /**
       * Toggles the popup's VISIBILITY only, based on whether anything matched
       * (I3: zero matches → hidden, so plain `@` typing is never interrupted by an
       * empty box). WHETHER to call it is decided at each call site — a local start
       * / refocus / edit always may, and a remote content change may too but only
       * for a NON-dismissed popup (never resurrecting a dismissed one). The
       * dismissed / remote gating lives at the call sites, not here.
       * Takes a QUERY for the same reason {@link updateContent} does.
       * @param query - The text typed after `@`.
       */
      const showFor = (query: string): void => {
        if (el) el.style.display = computeItems(query).length > 0 ? '' : 'none';
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
       * the list from the live pool so a mode / pool change since the popup was
       * hidden is reflected. No-op unless the popup is hidden AND the plugin is
       * active with an empty selection. Never resurrects a popup that is not
       * plugin-active, so a genuine exit (space / delete / cursor-leave) stays gone.
       * @param editor - The prompt editor (its settled state is read live).
       */
      const reshowIfActiveHidden = (editor: Editor): void => {
        if (!el || el.style.display !== 'none') return;
        const st = SuggestionPluginKey.getState(editor.state) as
          | { active?: boolean; query?: string }
          | undefined;
        if (st?.active !== true || !editor.state.selection.empty) return;
        dismissed = false;
        updateContent(st.query ?? '');
        showFor(st.query ?? '');
      };

      /**
       * Anchors the popup to the caret and KEEPS it anchored via floating-ui
       * autoUpdate: a one-shot computePosition would leave the popup at stale
       * coordinates when the surface moves without a keystroke (canvas pan/zoom
       * moves the NodeToolbar-anchored editor; the prompt is its own scroll
       * container). The virtual reference returns the LIVE caret rect each call;
       * animationFrame polling is needed because the canvas pans via CSS
       * transform, not scroll events (adversarial 2026-07-10).
       * @param clientRect - The suggestion's live caret rect getter.
       */
      const place = (
        clientRect: SuggestionProps<ReferenceRailItem>['clientRect'],
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
              // NO flip / shift (user 2026-07-20): this popup is anchored INSIDE
              // the ReactFlow canvas, and must track its caret and clip at the
              // viewport edge — NOT slide/flip to stay on screen. Collision
              // middleware kept the list pinned in the viewport while the caret
              // panned off, detaching it from the `@` (the list floated far from
              // its anchor). Same clip-not-jump contract the canvas Radix floats
              // use via avoidCollisions={false} (ratio / camera / model pickers).
              placement: 'bottom-start',
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
        onStart: (props: SuggestionProps<ReferenceRailItem>): void => {
          latestProps = props;
          // Seeded from the live pool, NOT from `props.items`. @tiptap/suggestion
          // resolves items through an async pipeline (so a remote resolver can be
          // awaited and aborted): every callback is handed `initialItems ?? []`
          // first — and we configure no `initialItems`, so that is always EMPTY —
          // with the real rows arriving on a later onUpdate. `computeItems` is
          // the single source for every path here; see {@link showFor}.
          component = new ReactRenderer(ReferenceMentionList, {
            props: {
              items: computeItems(props.query),
              command: (item: ReferenceRailItem) => latestProps?.command(item),
              emptyLabel: input.emptyLabel,
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
          // Residual 2 (mode / pool changed REMOTELY): a collaborator toggling
          // the node's mode or editing references fires NO transaction on this
          // client (mode lives on the canvas node, not the prompt doc), so the
          // plugin never re-runs items() and a VISIBLE popup keeps its stale list.
          // Expose a refresh the React layer calls when the `mode` / `references`
          // props change; it recomputes CONTENT from the live pool + mode, but
          // only while the popup is actually visible (a hidden / dismissed popup
          // needs no refresh).
          if (input.refreshRef) {
            input.refreshRef.current = (): void => {
              // Refresh a NON-dismissed popup's content + visibility (I3) from the
              // live pool. Guard on `dismissed`, NOT on current display: a prior
              // refresh that HID it on an emptied pool must still be able to
              // RE-SHOW it when the pool refills (a remote edge add/remove fires no
              // prosemirror transaction, so onUpdate can't heal it) — guarding on
              // display would latch it hidden forever. A user-dismissed popup
              // stays hidden.
              if (el && !dismissed && latestProps) {
                updateContent(latestProps.query);
                showFor(latestProps.query);
              }
            };
          }
          // Clicking outside the popup AND the editor (a canvas node / panel
          // control) does NOT move the ProseMirror selection, so the suggestion
          // would otherwise stay open floating over the UI. Just HIDE the popup
          // — do NOT exitSuggestion (B2, user 2026-07-12): exitSuggestion marks
          // the active `@` range permanently dismissed, so after a blur-and-back
          // the user's continued typing never re-opened the picker until the
          // editor remounted (close/reopen panel). Hiding keeps the plugin
          // active, so re-focusing and typing re-shows it via onUpdate; a
          // genuine break of the `@` match (space, deleting the `@`, cursor
          // leaving the range) still exits the plugin naturally → onExit removes
          // the popup. Capture phase so we see the click before ReactFlow stops it.
          onOutsidePointerDown = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (
              el &&
              target &&
              !el.contains(target) &&
              !props.editor.view.dom.contains(target)
            ) {
              dismissed = true; // user closed it — a remote edit must not re-open
              el.style.display = 'none';
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
            if (!el || el.style.display !== 'none') return;
            const pos = props.editor.view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            if (!pos || pos.pos !== props.editor.state.selection.from) return;
            reshowIfActiveHidden(props.editor);
          };
          props.editor.view.dom.addEventListener('click', onEditorClick);
          // Decide the initial visibility. A LOCAL start — the user typed `@` —
          // shows (I3: hidden when nothing matches). Anything else reaching
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
          const keepOpen = isLocalUserInput(props.editor);
          dismissed = !keepOpen;
          if (keepOpen) {
            showFor(props.query);
          } else {
            el.style.display = 'none';
          }
          place(props.clientRect);
        },
        onUpdate: (props: SuggestionProps<ReferenceRailItem>): void => {
          latestProps = props;
          // ALWAYS refresh the list content so a visible
          // popup stays current. But change VISIBILITY only on a genuine LOCAL
          // KEYSTROKE: a remote peer's edit — OR a machine-derived local dispatch
          // (the edge-driven cascade-clear deleting a chip before the `@`) —
          // shifts the range and fires onUpdate identically to local typing, and
          // must NOT resurrect a dismissed popup or pop a hidden one (residual 1;
          // the round-4 hole was that the old "not remote" test let the local
          // cascade through). A local keystroke is also the user re-engaging, so
          // it clears any dismissal.
          updateContent(props.query);
          if (isLocalUserInput(props.editor)) {
            // Local keystroke = the user re-engaging → clear any dismissal and
            // apply the normal I3 visibility (empty → hidden, else shown).
            dismissed = false;
            showFor(props.query);
          } else if (!dismissed) {
            // Non-keystroke content change to a VISIBLE (non-dismissed) popup →
            // keep I3 (a peer emptying the pool still hides it) but NEVER re-open
            // a popup the user dismissed (residual 1).
            showFor(props.query);
          }
          place(props.clientRect);
        },
        onKeyDown: (props: SuggestionKeyDownProps): boolean => {
          if (props.event.key === 'Escape') return true;
          return component?.ref?.onKeyDown(props.event) ?? false;
        },
        onExit: (props: SuggestionProps<ReferenceRailItem>): void => {
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
          dismissed = false;
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
