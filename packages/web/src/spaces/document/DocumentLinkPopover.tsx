// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The link control: a button on the selection bubble bar, and the panel it
 * opens for creating, viewing, changing and removing a link.
 *
 * Four states, three of them showing a panel. Which one opens is decided from
 * the selection at the moment the button is pressed, and stored — a value
 * derived on every render could not tell "there was never a link here" from
 * "the link just went away", and those two want opposite things.
 *
 * The button is its own kind rather than a ninth `ToolDef`: a `ToolDef` runs a
 * command on click, and this one hands its element to Radix to be the popover
 * trigger.
 */

import * as React from 'react';
import { Link as LinkIcon } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import type { Transaction } from '@tiptap/pm/state';
import {
  useFloating,
  useDismiss,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
  autoUpdate,
  offset,
  inline,
  flip,
  shift,
  type ReferenceType,
} from '@floating-ui/react';

import { useTranslation } from '@web/i18n/use-translation';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { BUBBLE_CONTROL_HEIGHT, BUBBLE_ICON_BUTTON_SIZE } from '@web/spaces/document/document-tool-button';
import {
  resolveLinkSelection,
  resolveLinkInSpan,
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
  type LinkRange,
  type LinkSelection,
} from '@web/spaces/document/document-link';
import {
  trackLink,
  resolveTrackedSpan,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';

/** Which of the panel's three faces is showing, or none. */
type LinkMode = 'closed' | 'create' | 'view' | 'edit';

/**
 * Hands this panel the line the bubble bar anchors to, in viewport coordinates.
 *
 * The bar is the one that knows where the reader is looking. Over a select-all
 * nothing about the selection does: it starts at the top of the document, so a
 * panel measuring from there lands above the fold by however far the reader has
 * scrolled — measured at viewport top -483 after a 600px scroll.
 */
export type AnchorLineReader = () => {
  left: number;
  top: number;
  bottom: number;
} | null;

/** What the panel acts on, taken from the selection when it opened. */
interface LinkTarget {
  range: LinkRange | null;
  href: string | null;
  /**
   * A hold on that same link that co-editors cannot invalidate. Null in
   * `create`, which opened on a selection holding no link, and in an editor
   * built without collaboration.
   */
  tracked: TrackedLink | null;
}

const NO_TARGET: LinkTarget = {
  range: null,
  href: null,
  tracked: null,
};

/**
 * The body's scroll container, which the anchor is measured against and lives
 * inside.
 * @param editor - The editor whose body to find the scroller of.
 * @returns The scroller, or null before the editor is in the document.
 */
function bodyScroller(editor: Editor): HTMLElement | null {
  return editor.view.dom.closest<HTMLElement>('[data-radix-scroll-area-viewport]');
}

/**
 * What floating-ui measures the panel against.
 *
 * A DOM Range over the target itself. Held rather than re-read from
 * `getSelection()`: the selection is emptied the moment the panel takes focus,
 * while a Range keeps tracking its text — measured, it survives focus leaving,
 * moves when a peer inserts ahead of it, and follows a reflow
 * (`engineering/demo/2026-08-25-live-range-probe.mjs`). `getClientRects` is
 * what the `inline` middleware reads to pick a line out of a target that wraps.
 *
 * Over a select-all there is no useful Range: it spans the whole document, so
 * its bottom edge is below the last line and the panel would open off screen.
 * The bar answers that case with the pointer, and this follows it.
 * @param editor - The editor to measure in.
 * @param span - The target's extent in the document, when it has one.
 * @param anchorLine - The bar's own anchor line, in viewport coordinates.
 * @returns The reference, or null while the target cannot be measured.
 * @throws {never}
 */
function panelReference(
  editor: Editor,
  span: LinkRange | null,
  anchorLine: AnchorLineReader,
): ReferenceType | null {
  const { view } = editor;
  const contextElement = view.dom as HTMLElement;
  const extent = span ?? { from: view.state.selection.from, to: view.state.selection.to };
  const range = domRangeOver(editor, extent);
  if (range) {
    return {
      getBoundingClientRect: () => range.getBoundingClientRect(),
      getClientRects: () => range.getClientRects(),
      contextElement,
    };
  }
  const line = anchorLine();
  if (!line) return null;
  const point = new DOMRect(line.left, line.top, 0, line.bottom - line.top);
  return { getBoundingClientRect: () => point, contextElement };
}

/**
 * A live DOM Range over a span of the document.
 *
 * `domAtPos` gives the node and offset ProseMirror renders a position at, which
 * is exactly what a Range's boundary points take.
 * @param editor - The editor to read.
 * @param span - The extent to cover.
 * @returns The range, or null when the positions have no DOM yet.
 * @throws {never}
 */
function domRangeOver(editor: Editor, span: LinkRange): Range | null {
  try {
    const start = editor.view.domAtPos(span.from);
    const end = editor.view.domAtPos(span.to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    // Positions outside the rendered document, which happens while a co-editor's
    // replacement of the whole doc is landing. The caller falls back to the bar.
    return null;
  }
}

/**
 * Where the link a panel opened over is now, after the document changed.
 *
 * With a handle, the answer comes from where it points; a handle that no
 * longer resolves means the text it covered has gone. Without one — an editor
 * built with no shared document, which other suites do — the selection is the
 * only thing left to ask.
 * @param editor - The editor to read.
 * @param tracked - The handle taken when the panel opened, if there is one.
 * @returns The link and its span, or nulls when it is gone.
 * @throws {never}
 */
function followedLink(editor: Editor, tracked: TrackedLink | null): LinkSelection {
  if (!tracked) return resolveLinkSelection(editor.state);
  const span = resolveTrackedSpan(editor, tracked);
  if (!span) return { range: null, href: null };
  return resolveLinkInSpan(editor.state, span.from, span.to);
}

/**
 * The link button and its panel.
 * @param root0 - Props.
 * @param root0.editor - The editor the control reads and writes.
 * @param root0.anchorLine - The bubble bar's own anchor line, for a selection
 *   holding no link.
 * @returns The control.
 */
export function DocumentLinkPopover({
  editor,
  anchorLine,
}: {
  editor: Editor;
  anchorLine: AnchorLineReader;
}): React.JSX.Element {
  const t = useTranslation();
  const [mode, setMode] = React.useState<LinkMode>('closed');
  const [draft, setDraft] = React.useState('');
  const [target, setTarget] = React.useState<LinkTarget>(NO_TARGET);
  const [showInvalid, setShowInvalid] = React.useState(false);

  // Subscribed rather than read while rendering: a co-editor's change arrives
  // with no React render behind it, so a value computed in the render body
  // would show whatever was true last time this happened to re-render.
  const holdsLink = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? resolveLinkSelection(e.state).range !== null : false),
  });

  /** Put the panel away and drop the draft. */
  const close = React.useCallback((): void => {
    setMode('closed');
    setDraft('');
    setShowInvalid(false);
    setTarget(NO_TARGET);
  }, []);

  /** Read the selection and show the face that fits it. */
  const openFromSelection = React.useCallback((): void => {
    const resolved = resolveLinkSelection(editor.state);
    setTarget({
      range: resolved.range,
      href: resolved.href,
      tracked: resolved.range ? trackLink(editor, resolved.range) : null,
    });
    setDraft('');
    setShowInvalid(false);
    setMode(resolved.range ? 'view' : 'create');
  }, [editor]);

  /** Write what is in the draft, and put the panel away. */
  const submit = React.useCallback((): void => {
    if (!isLinkUrlShaped(draft)) {
      setShowInvalid(true);
      return;
    }
    const href = normalizeLinkUrl(draft);
    const range = target.range ?? {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    applyLink(editor, range, href);
    close();
  }, [close, draft, editor, target.range]);

  /** Take the link off, and put the panel away. */
  const unlink = React.useCallback((): void => {
    if (target.range) removeLink(editor, target.range);
    close();
  }, [close, editor, target.range]);

  // A co-editor typing ahead of the link moves it, and the panel follows the
  // link it was opened over. Which link that is comes from the handle taken at
  // open time: re-reading the selection answers "which link does this
  // selection hold", and a peer linking a word earlier in the same selection
  // takes over that answer, so a confirm would write this user's address onto
  // the peer's word. See `document-link-tracking.ts` for why neither the
  // transaction's mapping nor the selection can stand in for the handle.
  React.useEffect(() => {
    if (mode === 'closed') return undefined;
    /**
     * Follow the document.
     * @param props - What the editor passes its transaction handler.
     * @param props.transaction - The transaction that just landed.
     */
    const follow = ({ transaction }: { transaction: Transaction }): void => {
      if (!transaction.docChanged) return;
      // `create` opened on a selection holding no link, and that selection is
      // what it writes to. A link a co-editor makes inside it belongs to them:
      // adopting it would narrow the write to their span and put this user's
      // address over their href, on text this user never selected.
      if (mode === 'create') return;
      const resolved = followedLink(editor, target.tracked);
      if (!resolved.range) {
        close();
        return;
      }
      setTarget((prev) => ({
        ...prev,
        range: resolved.range,
        href: resolved.href ?? prev.href,
      }));
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [close, editor, mode, target.tracked]);

  // Entering `edit` swaps the panel's contents without remounting it, so the
  // focus manager's open-time focus does not fire a second time. `create` gets
  // its focus from that default.
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (mode !== 'edit') return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [mode]);

  const canSubmit = draft.length > 0 && isLinkUrlShaped(draft);
  // Read on every render rather than held in state: it is a plain DOM lookup,
  // and every render that matters here follows a state change that already
  // happened after the editor was in the document.
  const scroller = bodyScroller(editor);

  // The panel hangs inside the scroller and is positioned in the scrolled
  // content's own coordinates, so it travels with the text and the scroller's
  // overflow clips it once the target leaves the body area. Both editors that
  // ship this control do the same: Lexical portals into the editor div inside
  // its scroller, BlockNote into the editor container.
  const { refs, floatingStyles, context } = useFloating({
    open: mode !== 'closed',
    onOpenChange: (open) => {
      if (!open) close();
    },
    strategy: 'absolute',
    placement: 'bottom',
    middleware: [
      offset(8),
      // Reads the target's per-line rectangles, so a target that wraps gets the
      // panel against one line rather than the box drawn around all of them.
      inline(),
      // The box that decides "it does not fit" is the body's visible area, the
      // same one the bar names for its own middleware. `shift` keeps its
      // default axis, which for a bottom placement is the horizontal one: the
      // panel is held inside the body column, and follows its target out of
      // sight vertically the way the line it sits on does.
      ...(scroller ? [flip({ boundary: scroller }), shift({ boundary: scroller })] : []),
    ],
    whileElementsMounted: autoUpdate,
  });
  // The button is not an outside press. `useDismiss` acts on `pointerdown`
  // while the button's own toggle runs on the following `click`, and those are
  // two separate event loops: left to itself, dismiss closes the panel and the
  // click then reads `mode` as `closed` and opens it straight back.
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const { getFloatingProps } = useInteractions([
    useDismiss(context, {
      outsidePress: (event) => !buttonRef.current?.contains(event.target as Node),
    }),
  ]);

  // The reference is rebuilt whenever the target moves to a different span. In
  // between, the Range it holds tracks its own text.
  React.useEffect(() => {
    if (mode === 'closed') return;
    refs.setPositionReference(panelReference(editor, target.range, anchorLine));
  }, [anchorLine, editor, mode, refs, target.range]);

  return (
    <>
      <Button
        ref={buttonRef}
        variant={holdsLink ? 'secondary' : 'ghost'}
        size='icon'
        aria-label={t('spaces.document.commands.link')}
        aria-pressed={holdsLink}
        aria-haspopup='dialog'
        aria-expanded={mode !== 'closed'}
        onClick={() => (mode === 'closed' ? openFromSelection() : close())}
        data-testid='doc-bubble-tool-link'
        // The bar stays out of the tab order entirely, as the eight command
        // buttons beside it do.
        tabIndex={-1}
        className={BUBBLE_ICON_BUTTON_SIZE}
      >
        <LinkIcon className='h-4 w-4' />
      </Button>
      {mode !== 'closed' && scroller ? (
        <FloatingPortal root={scroller}>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              data-testid='doc-link-popover'
              role='dialog'
              className='z-50 w-auto rounded-overlay border border-border bg-popover p-1.5 text-popover-foreground shadow outline-none'
            >
              {mode === 'view' ? (
                <div className='flex items-center gap-1.5'>
                  <a
                    data-testid='doc-link-url'
                    href={target.href ?? undefined}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='max-w-[250px] truncate px-1 text-sm text-content-link underline underline-offset-2'
                  >
                    {target.href}
                  </a>
                  <Button
                    variant='outline'
                    size={null}
                    onClick={() => {
                      setDraft(target.href ?? '');
                      setShowInvalid(false);
                      setMode('edit');
                    }}
                    data-testid='doc-link-edit'
                    className={`${BUBBLE_CONTROL_HEIGHT} bg-transparent px-2.5 text-sm`}
                  >
                    {t('spaces.document.link.edit')}
                  </Button>
                  <Button
                    variant='outline'
                    size={null}
                    onClick={unlink}
                    data-testid='doc-link-remove'
                    className={`${BUBBLE_CONTROL_HEIGHT} bg-transparent px-2.5 text-sm`}
                  >
                    {t('spaces.document.link.remove')}
                  </Button>
                </div>
              ) : (
                <div className='flex flex-col gap-1.5'>
                  <div className='flex items-center gap-1.5'>
                    <Input
                      data-testid='doc-link-input'
                      ref={inputRef}
                      value={draft}
                      aria-invalid={showInvalid}
                      placeholder={t('spaces.document.link.placeholder')}
                      onChange={(event) => {
                        setDraft(event.target.value);
                        setShowInvalid(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submit();
                        }
                      }}
                      className={`${BUBBLE_CONTROL_HEIGHT} w-[250px] bg-background px-2 py-0 text-sm`}
                    />
                    {/* `aria-disabled`, so the press still arrives: the reason an
                  address is refused is a thing this panel has to say, and a
                  button carrying the HTML attribute is handed no click to say
                  it on — nor any focus, which is what would have let the
                  input's blur say it instead. Pressing it runs `submit`, which
                  turns the field red and puts the reason underneath. */}
                    <Button
                      variant='outline'
                      size={null}
                      aria-disabled={!canSubmit}
                      onClick={submit}
                      data-testid='doc-link-confirm'
                      className={`${BUBBLE_CONTROL_HEIGHT} bg-transparent px-2.5 text-sm aria-disabled:opacity-50`}
                    >
                      {t('spaces.document.link.confirm')}
                    </Button>
                  </div>
                  {showInvalid ? (
                    <p
                      data-testid='doc-link-invalid'
                      className='px-0.5 text-xs text-status-error-foreground'
                    >
                      {t('spaces.document.link.invalid')}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  );
}
