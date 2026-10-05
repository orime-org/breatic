// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the generate panel's `@` list offers: the current connection reference
 * pool, narrowed to the rows the active mode can use, and picking a row inserts
 * a reference-mention atom carrying the stable `sourceNodeId` plus a snapshot
 * thumbnail / label (design 2026-07-10 §2.2). The pool and mode are read
 * through getters so the editor is never rebuilt when incoming edges change.
 */

import type { Editor } from '@tiptap/core';
import type { SuggestionOptions } from '@tiptap/suggestion';

import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { referenceMentionContent } from '@web/spaces/canvas/generate/reference-mention';
import { insertRefusal, REFERENCE_KINDS, type ReferenceUsabilityContext } from '@breatic/shared';
import {
  makeMentionSuggestion,
  type RefreshHandleRef,
} from '@web/features/reference-mention/mention-suggestion';
import { referenceKey, renderReferenceRow } from '@web/spaces/canvas/generate/reference-mention-list';

/**
 * Default mode context, used when no getter is wired: references are in play,
 * so the picker offers what any reference-taking mode offers — the text rows
 * and the rows of every kind a pool can take. A caller that does not know the
 * mode still gets the usable rows rather than an empty list; what it cannot
 * get is a row no pool takes, which `insertRefusal` refuses under every
 * context.
 */
const ANY_CONTEXT: ReferenceUsabilityContext = {
  referenceKinds: REFERENCE_KINDS,
  // The picker lives inside the prompt editor, which only mounts when the
  // model consumes a prompt (#1966), so this dimension cannot be false here.
  takesPrompt: true,
};

/**
 * Builds the `@` suggestion options for the reference-mention node.
 * @param input - Wiring inputs.
 * @param input.getPool - Reads the CURRENT reference pool (incoming edges); a
 *   getter so the editor need not rebuild when the pool changes.
 * @param input.emptyLabel - Localized text for "this mode has nothing to offer".
 * @param input.getUsabilityContext - Live getter for what the active mode does with
 *   references; rows the mode cannot consume are left out of the picker
 *   entirely — absent from the list, not listed and greyed (user
 *   2026-08-13). A getter
 *   because the mode lives on the canvas node, not in the prompt doc.
 *   Optional; omitting it assumes a reference-taking mode ({@link ANY_CONTEXT}).
 * @param input.refreshRef - Ref the open popup writes a `refresh()` into; the
 *   panel runs it when a collaborator changes the mode or the pool, which
 *   fires no transaction in this editor.
 * @param input.isLocalUserInput - Whether the last transaction was a local user
 *   keystroke; injectable for tests.
 * @returns The suggestion options (without `editor`, supplied by the extension).
 */
export function makeReferenceSuggestion(input: {
  getPool: () => ReferenceRailItem[];
  emptyLabel: string;
  getUsabilityContext?: () => ReferenceUsabilityContext;
  refreshRef?: RefreshHandleRef;
  isLocalUserInput?: (editor: Editor) => boolean;
}): Omit<SuggestionOptions<ReferenceRailItem>, 'editor'> {
  /**
   * The rows this mode can use at all, before the typed query narrows them.
   *
   * Reads the LIVE inputs (`getPool` + `getUsabilityContext`) on every call, so
   * every popup show path agrees: the plugin's `items()` on each keystroke, and
   * the shared list's re-show (features/reference-mention/mention-suggestion). `@tiptap/suggestion` only re-runs `items()` on a
   * query / range change (its `handleChange`), so a mode toggle — which lives
   * on the canvas node, not the prompt doc — never triggered a recompute; a
   * popup hidden (by clicking the mode picker) and re-shown on refocus then
   * kept the pre-toggle list. Computing here fixes that (#1799/#1800).
   * @returns The rows the active mode accepts.
   */
  const usableRows = (): ReferenceRailItem[] => {
    const usabilityCtx = input.getUsabilityContext?.() ?? ANY_CONTEXT;
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
        .filter((r) => insertRefusal(r.sourceNodeType, usabilityCtx) === null)
    );
  };

  /**
   * What to put in the popup for a query: the rows, and the sentence a bare
   * `@` shows when there are none.
   * @param query - The text typed after `@`.
   * @returns The rows to list and the empty-state text.
   */
  const resolveList = (
    query: string,
  ): { items: ReferenceRailItem[]; emptyLabel: string } => {
    const q = query.toLowerCase();
    const usable = usableRows();
    const items = usable
      .filter((r) => (r.sourceNodeName || '').toLowerCase().includes(q))
      .slice(0, 8);
    return { items, emptyLabel: input.emptyLabel };
  };

  return makeMentionSuggestion<ReferenceRailItem>({
    resolveList,
    content: referenceMentionContent,
    itemKey: referenceKey,
    renderItem: renderReferenceRow,
    // Below the caret: the prompt box sits on the canvas with room under it.
    placement: 'bottom-start',
    ...(input.refreshRef ? { refreshRef: input.refreshRef } : {}),
    ...(input.isLocalUserInput ? { isLocalUserInput: input.isLocalUserInput } : {}),
  });
}
