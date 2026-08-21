// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One command, rendered as a toggle — and the definition every carrier reads.
 *
 * This lives on its own because more than one carrier shows the same commands:
 * the top bar is always there, the selection bubble bar follows the selection,
 * and the ruling allows that (menu-system ruling §9.1 — one object may have
 * several entry points; what a command must NOT do is appear in a carrier
 * whose object differs from its own).
 *
 * ## Why the carrier prefixes the test id
 *
 * Both carriers render the same `ToolDef`s, so an id built from the command
 * alone names two buttons for as long as the bubble bar is on screen — which
 * is exactly when anything wants to address one of them. A query by command
 * would match both, and the existing toolbar tests that count buttons or take
 * one by id would break the moment a test made a selection. Naming the carrier
 * keeps each one addressable.
 *
 * These buttons come and go with the selection. `SelectionBubbleBar` renders
 * them only while one exists, because each of them dry-runs its command on
 * every transaction and the bar spends almost all of its life hidden. So the
 * window in which two buttons share a command is the window in which a
 * selection exists — which is also the only window anything wants to address
 * one of them in.
 *
 * (The bar's own element is a separate matter: the plugin removes it from the
 * document on hide — `dist/index.js:377-379` sets `visibility` and then calls
 * `element.remove()` — and appends the same element back on the next
 * `show()`. That element is the plugin's, not React's.)
 */

import * as React from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import type { Bold } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

/** Which carrier a button belongs to — the first half of its test id. */
export type ToolCarrier = 'toolbar' | 'bubble';

/** A toggle whose pressed state mirrors what is under the cursor. */
export interface ToolDef {
  id: string;
  labelKey: string;
  Icon: typeof Bold;
  isActive: (e: Editor) => boolean;
  /**
   * Whether the command can run against the current selection.
   *
   * Asked of the command the button runs, never of where the caret is. R7 asks
   * for one thing — no control that looks usable and does nothing when pressed
   * — and a dry run of the command itself is the only answer that tracks the
   * selection shapes as they actually are: caret-position heuristics answer
   * wrongly for selections that start at the document rather than inside any
   * block, and for blocks that refuse formatting (a code block takes no
   * marks).
   *
   * The dry run is CONSERVATIVE for the two list commands over a body heading
   * or code block — it says no where the command works. That is a body-editing
   * shortcoming, it is out of this slice, and it is the safe direction: R7
   * forbids a live button that does nothing, not a dark button that would have
   * worked.
   */
  canRun: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

/**
 * A single command button.
 * @param root0 - Button props.
 * @param root0.tool - The command definition.
 * @param root0.editor - The editor the command acts on.
 * @param root0.carrier - Which carrier is rendering it.
 * @param root0.readOnly - True disables it, whatever the command says.
 * @returns The button element.
 */
export const ToolButton = React.memo(function ToolButton({
  tool,
  editor,
  carrier,
  readOnly = false,
}: {
  tool: ToolDef;
  editor: Editor;
  carrier: ToolCarrier;
  readOnly?: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      active: e ? tool.isActive(e) : false,
      available: e ? tool.canRun(e) : false,
    }),
    // Compared field by field: the selector builds a fresh object on every
    // transaction, so identity would report a change on every keystroke and
    // re-render all six buttons for nothing.
    equalityFn: (a, b) =>
      b !== null && a.active === b.active && a.available === b.available,
  });
  const Icon = tool.Icon;
  return (
    <Button
      variant={state.active ? 'secondary' : 'ghost'}
      size='icon'
      aria-label={t(tool.labelKey)}
      aria-pressed={state.active}
      disabled={readOnly || !state.available}
      onClick={() => tool.run(editor)}
      data-testid={`doc-${carrier}-tool-${tool.id}`}
      // The bubble bar stays out of the tab order entirely (ruling §5.2): it
      // floats over the body, and anything floating over the body that takes
      // focus collides with the body's own focus. The top bar sits beside the
      // body and is always there, so it keeps its tab stops — it is the
      // keyboard route to these same six commands, together with their
      // shortcuts.
      tabIndex={carrier === 'bubble' ? -1 : undefined}
      // The bubble bar sits over the text, so its buttons are a notch shorter
      // than the top bar's — but only shorter. The demo's `.pop .tb-btn`
      // (`:209`) overrides height alone, leaving `.tb-btn`'s own
      // `min-width: 28px` (`:138-139`) in force, so the button stays 28 wide.
      className={cn(carrier === 'bubble' ? 'h-[26px] w-7' : 'h-7 w-7')}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
});
