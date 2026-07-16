// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { toast } from 'sonner';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import type { TextNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface TextNodeProps {
  data: TextNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  onChange?: (next: string) => void;
  onRename?: (name: string) => void;
}

/**
 * Editing-only body classes: `nowheel` (the wheel scrolls the text you are
 * editing, not the canvas) + `nodrag` (a pointer press selects text instead of
 * dragging the node) + `cursor-text` (contenteditable has no UA cursor of its
 * own and would inherit the ReactFlow node wrapper's grab hand — user bug
 * 2026-07-04). The editing body scrolls inside a ScrollArea (#1773: overlay
 * scrollbar — appears only while scrolling, no layout space, hover changes
 * color only). The display state has NONE of these — it clips
 * (overflow-hidden) with a fade hint and leaves the wheel to ReactFlow so it
 * zooms the canvas (#1470 / #1479).
 */
const EDIT_BODY_CLASS = 'cursor-text focus:bg-accent/30';

/**
 * Text node — modality body that supports inline contenteditable
 * editing on double-click. State `idle` with no content shows the
 * placeholder; `handling` shows a skeleton; `error` shows the message.
 *
 * Generation behaviour (prompt + model + send) lives in the toolbar
 * left-zone popover (PR 7), not in this node body.
 * @param root0 - Text node props.
 * @param root0.data - Text node payload (content string, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, blocking inline editing and showing the lock indicator.
 * @param root0.onChange - Called with the new text when an inline edit is committed on blur.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @returns The text node element (placeholder or inline-editable body).
 */
export const TextNode = React.memo(function TextNode({
  data,
  selected,
  locked,
  onChange,
  onRename,
}: TextNodeProps): React.JSX.Element {
  const t = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  // Optimistic local draft (#1470): commit() flips `editing` off synchronously,
  // but `data.content` (the async Yjs write) only catches up a tick later. For a
  // FRESH node that gap would render the empty-state placeholder for one frame
  // (the reported flash). Hold the just-typed text here and prefer it for
  // rendering until the prop matches, then drop it — same local-draft pattern as
  // the optimistic-update microtask-race fix.
  const [committedDraft, setCommittedDraft] = React.useState<string | null>(null);
  const shownContent = committedDraft ?? data.content;
  React.useEffect(() => {
    if (committedDraft !== null && data.content === committedDraft) {
      setCommittedDraft(null);
    }
  }, [data.content, committedDraft]);
  // Display state clips overflow (no scrollbar), so a bottom fade hints "there's
  // more" — but only when the content is ACTUALLY clipped, never on short text.
  // Measure scrollHeight vs clientHeight; jsdom reports 0/0 so the fade is a
  // browser-only affordance (the unit tests assert the clip/wrap classes).
  const [clipped, setClipped] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [shownContent, editing]);

  /**
   * Enters inline edit mode and focuses the contenteditable body on the next
   * microtask — unless a node-state gate blocks editing the content: a `locked`
   * node (user froze it) or a `handling` node (a task is writing it) refuses the
   * edit with a warning toast instead of silently doing nothing.
   */
  const startEdit = (): void => {
    const block = evaluateNodeGate(
      { locked: Boolean(locked), handling: data.status === 'handling' },
      'editContent',
    );
    if (block) {
      toast.warning(t(block.toastKey));
      return;
    }
    setEditing(true);
    queueMicrotask(() => ref.current?.focus());
  };

  /**
   * Commits the edited text via `onChange` and leaves edit mode. The committed
   * text is also held locally (`committedDraft`) so the body keeps showing it
   * across the async gap before `data.content` updates (no placeholder flash).
   */
  const commit = (): void => {
    const text = ref.current?.innerText ?? '';
    // Re-gate at commit (adversarial round): startEdit gates ENTERING an edit,
    // but a lock or handling task can land WHILE editing. Never write to a
    // now-frozen node — warn, discard the local edit, and leave edit mode (the
    // body reverts to data.content). Mirrors the generate submit re-check.
    const block = evaluateNodeGate(
      { locked: Boolean(locked), handling: data.status === 'handling' },
      'editContent',
    );
    if (block) {
      toast.warning(t(block.toastKey));
      setEditing(false);
      return;
    }
    if (onChange) onChange(text);
    setCommittedDraft(text);
    setEditing(false);
  };

  const hasContent = shownContent.length > 0;

  return (
    <ContentNodeFrame
      modality='text'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='text-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        // While editing, show the editable body even when empty — a fresh text
        // node entered from the placeholder double-click has no content yet but
        // must render the contenteditable body so the user can start writing.
        hasContent={hasContent || editing}
        placeholder={
          <NodePlaceholder modality='text' onActivate={startEdit} />
        }
        content={
          // Relative wrapper so the display-state fade can overlay the body's
          // bottom edge without affecting layout.
          //
          // Two-state body (#1470 / #1479): always cap at 576px (`max-h-144` =
          // width 288 × 2), start at the empty-state height (`min-h-48` =
          // 192px) and grow with content, and wrap long unbreakable tokens
          // (`break-words`) so text never scrolls horizontally.
          //   - editing → the contenteditable scrolls inside a ScrollArea
          //     (#1773 overlay scrollbar; the max cap moves to the Radix
          //     viewport — the scroller — while min-h stays on the body so the
          //     whole empty area takes the caret). `nowheel` (wheel scrolls
          //     the text) + `nodrag` (pointer selects text) sit on the
          //     ScrollArea root — ReactFlow checks ancestors.
          //   - display → `overflow-hidden` (clip, no scrollbar) + NO
          //     `nowheel`, so the wheel zooms the canvas like other nodes; a
          //     bottom fade hints there's more (double-click to edit+scroll).
          //
          // Editable affordances mount ONLY while editing. A non-editing body
          // must carry neither `contenteditable` (React renders even `={false}`
          // as the literal attribute `contenteditable="false"`) nor a tabindex:
          // ReactFlow's isInputDOMNode flags ANY element with a
          // `contenteditable` attribute as an input — value ignored — and
          // swallows Delete, while a focusable body steals click focus from
          // node selection. Both block deleting a filled node. The edit body
          // remounts on entry (structure swap) — startEdit's queued focus runs
          // after the swap, so focus lands on the fresh element.
          <div className='relative'>
            {editing ? (
              <ScrollArea className='nowheel nodrag' viewportClassName='max-h-144'>
                <div
                  ref={ref}
                  data-testid='text-node-body'
                  role='textbox'
                  tabIndex={0}
                  aria-multiline='true'
                  contentEditable
                  suppressContentEditableWarning
                  onBlur={commit}
                  className={`min-h-48 whitespace-pre-wrap break-words p-3 text-justify text-sm outline-none ${EDIT_BODY_CLASS}`}
                >
                  {shownContent}
                </div>
              </ScrollArea>
            ) : (
              <div
                ref={ref}
                data-testid='text-node-body'
                onDoubleClick={startEdit}
                className='max-h-144 min-h-48 overflow-hidden whitespace-pre-wrap break-words p-3 text-justify text-sm outline-none'
              >
                {shownContent}
              </div>
            )}
            {!editing && clipped ? (
              <div
                data-testid='text-node-fade'
                aria-hidden='true'
                // The NodeShell clips children to its rounded box, so the fade
                // needs no radius of its own.
                className='pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent'
              />
            ) : null}
          </div>
        }
      />
    </ContentNodeFrame>
  );
});
