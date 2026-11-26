// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { Minimize2 } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { compositionEnd, keyBelongsToInputMethod } from '@web/lib/composition-end';
import { KEEPS_DIALOG_OPEN } from '@web/lib/keeps-dialog-open';
import { takeStray } from '@web/lib/stray-file-drop';
import { cn } from '@web/lib/utils';

/** Props for {@link TextFullscreen}. */
interface TextFullscreenProps {
  /** The title: the node's name, and the box's when there are several. */
  title: string;
  /** Marks the text as one the user can read but not change. */
  readOnly?: boolean;
  /** Closes it: the exit button, a press on the backdrop or Escape. */
  onClose: () => void;
  /** The text, editable or read-only. */
  children: React.ReactNode;
  /**
   * Answers an Escape the text claims for itself (an open `@` list), so it
   * does not close the layer. Called before the layer decides.
   */
  onEscapeWithin?: () => boolean;
  /** Puts the caret in the text as the layer opens; focus stays on the body when absent. */
  onOpenFocus?: (body: HTMLElement) => void;
  /** Where the focus goes as it closes. */
  onCloseAutoFocus?: (event: Event) => void;
  /** Classes the text's own rules hang on. */
  bodyClassName?: string;
  /** What tests reach for the layer by. */
  testId?: string;
}

/**
 * Stops a React event from reaching the host. React events cross the portal
 * back up the component tree, and a canvas node and the generation panel
 * answer clicks, keys, the context menu and drops of their own.
 * @param event - The event.
 */
function stop(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * Stops a file drag from reaching the host and cancels the browser's own
 * opening of the file.
 * @param event - A `dragover` or a `drop`.
 */
function stopDrop(event: React.DragEvent): void {
  event.stopPropagation();
  takeStray(event.nativeEvent);
}

/**
 * Whether a press outside the layer landed in a popup that belongs to its text.
 * @param event - Radix's outside event.
 * @returns True for a press in such a popup.
 */
function withinKeptPopup(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && target.closest(`[${KEEPS_DIALOG_OPEN}]`) !== null;
}

/**
 * Full screen for a text node's body or a prompt (inner#2115): the text on a
 * large card over a dark backdrop, a title and an exit button on top. The exit
 * button, a press on the backdrop and Escape close it. Escape is decided once,
 * here, where it arrives first: one that belongs to an input method, or that
 * the text claims, leaves it open.
 *
 * Hosts mount it only while open, with an editor of their own inside.
 * @param root0 - Component props.
 * @param root0.title - The title.
 * @param root0.readOnly - Marks the text read-only.
 * @param root0.onClose - Closes it.
 * @param root0.children - The text.
 * @param root0.onEscapeWithin - Answers an Escape the text claims.
 * @param root0.onOpenFocus - Puts the caret in the text as it opens.
 * @param root0.onCloseAutoFocus - Where the focus goes as it closes.
 * @param root0.bodyClassName - Classes for the text's own rules.
 * @param root0.testId - The test id.
 * @returns The layer.
 */
export function TextFullscreen({
  title,
  readOnly = false,
  onClose,
  children,
  onEscapeWithin,
  onOpenFocus,
  onCloseAutoFocus,
  bodyClassName,
  testId = 'text-fullscreen',
}: TextFullscreenProps): React.JSX.Element {
  const t = useTranslation();
  const exitLabel = t('canvas.textFullscreen.exit');
  const ended = React.useMemo(() => compositionEnd(), []);
  const body = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    window.addEventListener('compositionend', ended.mark, true);
    return () => window.removeEventListener('compositionend', ended.mark, true);
  }, [ended]);
  const keepOutside = React.useCallback((event: Event): void => {
    if (withinKeptPopup(event)) event.preventDefault();
  }, []);

  return (
    // Not a control: it only keeps the layer's events from its host.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <span
      className='contents'
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={stop}
      onDragEnter={stop}
      onDragOver={stopDrop}
      onDrop={stopDrop}
    >
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent
          data-testid={testId}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (body.current === null) return;
            if (onOpenFocus) onOpenFocus(body.current);
            else body.current.focus();
          }}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={(event) => {
            if (keyBelongsToInputMethod(event, ended) || onEscapeWithin?.() === true) event.preventDefault();
          }}
          onPointerDownOutside={keepOutside}
          onInteractOutside={keepOutside}
          // No entry zoom: a transform on the content would hold the fixed
          // children to the content's box until the animation ends.
          className='flex h-[85vh] w-[min(92vw,960px)] max-w-none flex-col gap-0 overflow-hidden p-0 data-[state=closed]:animate-none data-[state=open]:animate-none'
        >
          <div className='flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4'>
            <div className='flex min-w-0 items-center gap-2'>
              <DialogTitle className='truncate text-sm font-medium'>{title}</DialogTitle>
              {readOnly ? (
                <span
                  data-testid={`${testId}-read-only`}
                  className='shrink-0 rounded-chrome bg-muted px-1.5 py-0.5 text-xs text-muted-foreground'
                >
                  {t('canvas.textFullscreen.readOnly')}
                </span>
              ) : null}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <DialogClose asChild>
                  <Button
                    variant='chrome-ghost'
                    size='chrome'
                    data-testid={`${testId}-exit`}
                    aria-label={exitLabel}
                    className='shrink-0'
                  >
                    <Minimize2 className='h-4 w-4' />
                  </Button>
                </DialogClose>
              </TooltipTrigger>
              <TooltipContent portal>{exitLabel}</TooltipContent>
            </Tooltip>
          </div>
          <ScrollArea className='min-h-0 flex-1' viewportClassName='h-full'>
            <div
              ref={body}
              tabIndex={-1}
              data-testid={`${testId}-body`}
              className={cn('mx-auto w-full max-w-[44em] px-10 py-8 text-base leading-7 outline-none', bodyClassName)}
            >
              {children}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </span>
  );
}
