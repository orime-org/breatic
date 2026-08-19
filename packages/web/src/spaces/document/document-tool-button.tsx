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
 * alone would exist twice in the document at once — and the bubble bar's
 * subtree is always mounted (its plugin hides it with `visibility`, it does not
 * unmount it). Every query for a single button would then match two nodes.
 * Naming the carrier keeps each one addressable.
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
      className={cn('h-7 w-7')}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
});
