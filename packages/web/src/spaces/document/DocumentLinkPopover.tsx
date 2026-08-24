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
import { createPortal } from 'react-dom';
import { Link as LinkIcon } from 'lucide-react';
import { posToDOMRect, type Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import type { Transaction } from '@tiptap/pm/state';

import { useTranslation } from '@web/i18n/use-translation';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { BUBBLE_CONTROL_HEIGHT, BUBBLE_ICON_BUTTON_SIZE } from '@web/spaces/document/document-tool-button';
import {
  resolveLinkSelection,
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
  type LinkRange,
} from '@web/spaces/document/document-link';

/** Which of the panel's three faces is showing, or none. */
type LinkMode = 'closed' | 'create' | 'view' | 'edit';

/** What the panel acts on, taken from the selection when it opened. */
interface LinkTarget {
  range: LinkRange | null;
  href: string | null;
  /** Where to put the panel: the link's box, or the selection's. */
  anchorRect: DOMRect | null;
}

const NO_TARGET: LinkTarget = { range: null, href: null, anchorRect: null };

/**
 * The link button and its panel.
 * @param root0 - Props.
 * @param root0.editor - The editor the control reads and writes.
 * @returns The control.
 */
export function DocumentLinkPopover({ editor }: { editor: Editor }): React.JSX.Element {
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
    const { from, to } = resolved.range ?? editor.state.selection;
    setTarget({
      range: resolved.range,
      href: resolved.href,
      anchorRect: posToDOMRect(editor.view, from, to),
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

  // A co-editor typing ahead of the link moves it. The panel follows by asking
  // the same question again — a transaction's own mapping cannot answer here,
  // because a remote update arrives as one step replacing the whole document
  // and maps every position to its end. The selection is mapped for us: the
  // sync plugin restores it from a relative position, so re-reading it gives
  // the link where it now is, or nothing when the link has gone.
  React.useEffect(() => {
    if (mode === 'closed') return undefined;
    /**
     * Follow the document.
     * @param props - What the editor passes its transaction handler.
     * @param props.transaction - The transaction that just landed.
     */
    const follow = ({ transaction }: { transaction: Transaction }): void => {
      if (!transaction.docChanged) return;
      const resolved = resolveLinkSelection(editor.state);
      if (target.range && !resolved.range) {
        close();
        return;
      }
      const { from, to } = resolved.range ?? editor.state.selection;
      setTarget((prev) => ({
        ...prev,
        range: resolved.range,
        href: resolved.href ?? prev.href,
        anchorRect: posToDOMRect(editor.view, from, to),
      }));
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [close, editor, mode, target.range]);

  // Entering `edit` swaps the panel's contents without remounting it, so
  // Radix's open-time focus does not fire a second time. `create` gets its
  // focus from that default.
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (mode !== 'edit') return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [mode]);

  const canSubmit = draft.length > 0 && isLinkUrlShaped(draft);

  return (
    <Popover
      open={mode !== 'closed'}
      onOpenChange={(open) => {
        // Only the button opens the panel. Radix reports every other way it
        // can go away — Escape, a click outside, a second press on the button
        // — and all of them mean the same thing.
        if (!open) close();
      }}
    >
      {createPortal(
        <PopoverAnchor asChild>
          {/* On the body, and fixed to the viewport coordinates the selection
              measures at.

              It cannot live in the bubble bar, which the plugin takes out of
              the document the moment a transaction arrives while the panel
              holds focus. It cannot live in the editor either: that DOM
              belongs to ProseMirror, which tears it down before React unmounts
              this tree — React then tries to remove this element from a node
              that is no longer its parent, and the whole route throws. The
              body outlives both. */}
          <span
            data-testid='doc-link-anchor'
            aria-hidden='true'
            className='pointer-events-none fixed'
            style={
              target.anchorRect
                ? {
                  left: target.anchorRect.left,
                  top: target.anchorRect.top,
                  width: target.anchorRect.width,
                  height: target.anchorRect.height,
                }
                : undefined
            }
          />
        </PopoverAnchor>,
        document.body,
      )}
      <PopoverTrigger asChild>
        <Button
          variant={holdsLink ? 'secondary' : 'ghost'}
          size='icon'
          aria-label={t('spaces.document.commands.link')}
          aria-pressed={holdsLink}
          onClick={openFromSelection}
          data-testid='doc-bubble-tool-link'
          // The bar stays out of the tab order entirely, as the eight command
          // buttons beside it do.
          tabIndex={-1}
          className={BUBBLE_ICON_BUTTON_SIZE}
        >
          <LinkIcon className='h-4 w-4' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-testid='doc-link-popover'
        align='center'
        className='w-auto p-1.5'
        onCloseAutoFocus={(event) => {
          // Focus goes back to the body on every way out. Radix would return
          // it to the trigger, which sits on a bar that is only on screen
          // while the body holds focus — so the default takes the bar away
          // and strands the caret. Same hand-back the clear-document dialog
          // does.
          event.preventDefault();
          if (editor.isDestroyed) return;
          editor.commands.focus();
        }}
      >
        {mode === 'view' ? (
          <div className='flex items-center gap-1'>
            <a
              data-testid='doc-link-url'
              href={target.href ?? undefined}
              target='_blank'
              rel='noopener noreferrer'
              className='max-w-56 truncate px-1 text-sm text-content-link underline'
            >
              {target.href}
            </a>
            <Button
              variant='ghost'
              size={null}
              onClick={() => {
                setDraft(target.href ?? '');
                setShowInvalid(false);
                setMode('edit');
              }}
              data-testid='doc-link-edit'
              className={`${BUBBLE_CONTROL_HEIGHT} px-2 text-sm`}
            >
              {t('spaces.document.link.edit')}
            </Button>
            <Button
              variant='ghost'
              size={null}
              onClick={unlink}
              data-testid='doc-link-remove'
              className={`${BUBBLE_CONTROL_HEIGHT} px-2 text-sm`}
            >
              {t('spaces.document.link.remove')}
            </Button>
          </div>
        ) : (
          <div className='flex flex-col gap-1'>
            <div className='flex items-center gap-1'>
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
                className={`${BUBBLE_CONTROL_HEIGHT} w-56 text-sm`}
              />
              <Button
                variant='ghost'
                size={null}
                disabled={!canSubmit}
                onClick={submit}
                data-testid='doc-link-confirm'
                className={`${BUBBLE_CONTROL_HEIGHT} px-2 text-sm`}
              >
                {t('spaces.document.link.confirm')}
              </Button>
            </div>
            {showInvalid ? (
              <p
                data-testid='doc-link-invalid'
                className='px-1 text-xs text-status-error-foreground'
              >
                {t('spaces.document.link.invalid')}
              </p>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
