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
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { ReactRenderer } from '@tiptap/react';
import type {
  SuggestionKeyDownProps,
  SuggestionOptions,
  SuggestionProps,
} from '@tiptap/suggestion';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { referenceMentionContent } from '@web/spaces/canvas/generate/reference-mention';
import { canConnect } from '@web/spaces/canvas/lib/connection-rules';
import {
  ReferenceMentionList,
  type ReferenceMentionListRef,
} from '@web/spaces/canvas/generate/reference-mention-list';

/**
 * Whether the LAST transaction applied to the editor came from a REMOTE
 * collaborator (or a yUndo), rather than this user's own keystroke. The
 * collaborative prompt binds y-prosemirror, whose y-sync plugin records
 * `isChangeOrigin` on its plugin state for every applied transaction
 * (sync-plugin sets it true when replaying a peer's update). Read by the
 * y-sync key NAME (`y-sync$`) — not by importing `ySyncPluginKey`, which is a
 * transitive dep whose key identity can drift to `y-sync$1` under a duplicate
 * copy (same robustness as {@link collab-undo-selection}). Returns false with
 * no collaboration (a bare / non-collaborative editor has no y-sync plugin).
 *
 * The `@` suggestion uses this to keep a user-DISMISSED popup dismissed and a
 * visible popup's VISIBILITY unchanged when a peer edits the shared prompt: a
 * remote edit that shifts the `@` range fires the plugin's onUpdate exactly
 * like local typing, and without this discriminator it would resurrect a popup
 * the user closed (the collaboration residual).
 * @param editor - The prompt editor.
 * @returns True when the last applied transaction was a remote peer change.
 */
export function wasLastChangeRemote(editor: Editor): boolean {
  const sync = editor.state.plugins
    .find((pl) => (pl as unknown as { key?: string }).key === 'y-sync$')
    ?.getState(editor.state) as
    | { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean }
    | undefined;
  // A PEER change, not this user's own undo/redo: y-prosemirror sets
  // isChangeOrigin=true for BOTH a remote peer edit AND the local Y.UndoManager
  // applying an undo/redo, distinguishing them only by isUndoRedoOperation
  // (`origin instanceof Y.UndoManager`, true only for THIS client's undo). Treat
  // a local undo as a LOCAL re-engagement (so it can re-show a dismissed popup),
  // reserving "remote" for a true peer change.
  return sync?.isChangeOrigin === true && sync.isUndoRedoOperation !== true;
}

/** A React-ref-shaped holder the open popup writes its `refresh()` into. */
type RefreshHandleRef = { current: (() => void) | null };

/**
 * Builds the `@` suggestion options for the reference-mention node.
 * @param input - Wiring inputs.
 * @param input.getPool - Reads the CURRENT reference pool (incoming edges); a
 *   getter so the editor need not rebuild when the pool changes.
 * @param input.emptyLabel - Localized empty-state text for the popup.
 * @param input.imageRefsDisabled - Live getter; when it returns true (t2i),
 *   image references are excluded from the picker. Optional (default: keep all).
 * @param input.refreshRef - Ref the open popup writes a `refresh()` into so the
 *   React layer can refresh a visible popup on a remote mode/pool change (residual 2).
 * @param input.isRemoteChange - Whether the last transaction was a remote peer
 *   change; defaults to {@link wasLastChangeRemote}, injectable for tests (residual 1).
 * @returns The suggestion options (without `editor`, supplied by the extension).
 */
export function makeReferenceSuggestion(input: {
  getPool: () => ReferenceRailItem[];
  emptyLabel: string;
  /**
   * Whether source-image references are inert (text-to-image ignores source
   * images). Read live so a mode toggle takes effect without rebuilding the
   * editor. When it returns true, image rows are excluded from the `@` picker so
   * t2i never offers an image reference (user 2026-07-18) — matching the rail,
   * which dims the same rows. Text references stay (they feed the prompt in
   * every mode). Optional; omitted (or false) keeps all connectable refs.
   */
  imageRefsDisabled?: () => boolean;
  /**
   * A ref the popup writes a `refresh()` into while open, so the React layer can
   * refresh the VISIBLE popup's list content when the mode / pool changes
   * REMOTELY (a collaborator toggles the node's mode or edits references). Such
   * a change fires NO ProseMirror transaction on this client — mode lives on the
   * canvas node, not the prompt doc — so `@tiptap/suggestion` never re-runs
   * items(); PromptEditor calls this on its `mode` / `references` props changing
   * (collaboration residual 2). No-op while the popup is hidden. Optional.
   */
  refreshRef?: RefreshHandleRef;
  /**
   * Whether the last applied transaction was a REMOTE peer change. Defaults to
   * {@link wasLastChangeRemote} (reads the live y-sync plugin state); injectable
   * so the visibility-gating logic is unit-testable without a full collaboration
   * setup. When true, onUpdate refreshes the list CONTENT but does not change the
   * popup's VISIBILITY (a remote edit never resurrects a dismissed popup —
   * collaboration residual 1).
   */
  isRemoteChange?: (editor: Editor) => boolean;
}): Omit<SuggestionOptions<ReferenceRailItem>, 'editor'> {
  const isRemoteChange = input.isRemoteChange ?? wasLastChangeRemote;
  /**
   * Filters the LIVE pool to the rows offerable for a query under the CURRENT
   * mode. Extracted so every popup show path computes from the same live inputs
   * (`getPool` + `imageRefsDisabled`): the plugin's `items()` on each keystroke,
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
    const hideImages = input.imageRefsDisabled?.() ?? false;
    return input
      .getPool()
      // Connection rules (spec §9.1): new incompatible wires are rejected at
      // the wire level, but a LEGACY edge (audio/video → image, created
      // before the rules) may survive in old documents. Never offer it in
      // the picker — an @-pick that can't feed image generation dead-ends at
      // execute ("no source image"). The rail still lists the legacy row so
      // the user can see and remove it.
      .filter((r) => canConnect(r.sourceNodeType, 'image'))
      // Text-to-image ignores source images, so image references are invalid:
      // exclude them from the `@` picker (user 2026-07-18) — with only images
      // in the pool the picker never opens. Text refs still feed the prompt.
      .filter((r) => !(hideImages && r.sourceNodeType === 'image'))
      .filter((r) => (r.sourceNodeName || '').toLowerCase().includes(q))
      .slice(0, 8);
  };
  return {
    char: '@',
    // @tiptap/suggestion defaults allowedPrefixes to [" "], which only fires `@`
    // when preceded by a space or at block start — so typing `@` right after
    // text (e.g. directly after a CJK character, where no space precedes it)
    // never opened the picker. null lets `@` trigger after any character
    // (Notion / Feishu behaviour).
    allowedPrefixes: null,
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
      /** Re-shows the popup when the editor regains focus (B2). */
      let onEditorFocus: (() => void) | null = null;
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
       * @param items - The rows to display.
       */
      const updateContent = (items: ReferenceRailItem[]): void => {
        component?.updateProps({
          items,
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
       * @param items - The rows the popup would show.
       */
      const showFor = (items: ReferenceRailItem[]): void => {
        if (el) el.style.display = items.length > 0 ? '' : 'none';
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
              placement: 'bottom-start',
              middleware: [offset(6), flip(), shift({ padding: 8 })],
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
          component = new ReactRenderer(ReferenceMentionList, {
            props: {
              items: props.items,
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
              if (el && el.style.display !== 'none' && latestProps) {
                const items = computeItems(latestProps.query);
                updateContent(items);
                // Re-apply I3: a remote change that empties the pool must hide the
                // visible popup, not leave it showing an empty "no references" box.
                showFor(items);
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
          // Re-show on re-focus (B2 residual, user 2026-07-12): the outside-click
          // handler HIDES the popup (display:none) without exiting the suggestion.
          // Re-focusing the editor (clicking back in) does not fire onUpdate — only
          // typing does — so the popup would stay hidden until a keystroke. On
          // focus, RECOMPUTE the list from the live pool + mode rather than merely
          // un-hiding the cached one: @tiptap/suggestion only re-runs items() on a
          // query / range change, and a mode toggle (stored on the canvas node,
          // not the prompt doc) is neither — so re-showing the stale list kept
          // t2i's text-only rows after switching to i2i and never offered the
          // focus crops i2i should (#1799 / #1800). showFor also re-hides when
          // nothing matches, matching a freshly-opened panel.
          onEditorFocus = (): void => {
            if (!latestProps) return;
            dismissed = false; // re-focusing is the user re-engaging → allow show
            const items = computeItems(latestProps.query);
            updateContent(items);
            showFor(items);
          };
          props.editor.view.dom.addEventListener('focus', onEditorFocus);
          // Show the popup ONLY for a LOCAL start (the user typed `@`), and only
          // when the pool has ≥1 matching row (I3: plain `@` typing must not pop an
          // empty box). A REMOTE-triggered restart also reaches onStart —
          // @tiptap/suggestion re-fires start when a peer's edit both MOVES the
          // range and CHANGES the query (moved && changed → onExit → onStart) — and
          // must NOT pop a picker this user never opened (residual 1: the onUpdate
          // guard alone missed this restart path). A remote start begins dismissed
          // (hidden); a subsequent LOCAL edit clears it and shows via onUpdate.
          dismissed = isRemoteChange(props.editor);
          if (dismissed) {
            el.style.display = 'none';
          } else {
            showFor(props.items);
          }
          place(props.clientRect);
        },
        onUpdate: (props: SuggestionProps<ReferenceRailItem>): void => {
          latestProps = props;
          // props.items is already computed by the plugin (items() → computeItems
          // with the live mode). ALWAYS refresh the list content so a visible
          // popup stays current. But change VISIBILITY only on a LOCAL edit: a
          // remote collaborator's edit shifts the `@` range and fires onUpdate
          // identically to local typing, and must NOT resurrect a dismissed popup
          // or pop a hidden one (collaboration residual 1). A local edit is also
          // the user re-engaging, so it clears any dismissal.
          updateContent(props.items);
          if (!isRemoteChange(props.editor)) {
            // Local edit = the user re-engaging → clear any dismissal and apply
            // the normal I3 visibility (empty → hidden, else shown).
            dismissed = false;
            showFor(props.items);
          } else if (!dismissed) {
            // Remote content change to a VISIBLE (non-dismissed) popup → keep I3
            // (a peer emptying the pool still hides it) but NEVER re-open a popup
            // the user dismissed (residual 1).
            showFor(props.items);
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
          if (onEditorFocus) {
            props.editor.view.dom.removeEventListener('focus', onEditorFocus);
            onEditorFocus = null;
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
