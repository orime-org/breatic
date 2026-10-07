// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an image, video or audio block shows in the body (inner#1127 A7–A9,
 * A16, A17, A19), rendered into its node view's container by
 * `DocumentMediaViews`.
 *
 * Everything the reader works with — the toolbar above the media, the caption
 * field, the resize handles — sits under `[data-media-chrome]`. The node view
 * hands every event from there to the browser and to these controls, and the
 * body's stylesheet hides it while the editor is not editable (A11).
 */

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Download,
  Maximize2,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { compositionEnd, keyBelongsToInputMethod } from '@web/lib/composition-end';
import { usePressKeepsFocus } from '@web/lib/use-press-keeps-focus';
import { cn } from '@web/lib/utils';
import { BUBBLE_BAR_CLASS, BUBBLE_ICON_BUTTON_SIZE, PRESSED_CLASS } from '@web/spaces/document/document-tool-button';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

/** The media block types. */
import type { MediaBlockType } from '@web/spaces/document/document-media-types';

/** The block's props, as far as this view reads them. */
export interface MediaBlockProps {
  readonly url: string;
  readonly name: string;
  readonly caption: string;
  /** Image and video only. */
  readonly previewWidth?: number;
  /** Image and video only. */
  readonly textAlignment?: string;
}

/** What the toolbar and the handles do, against the block as it is now. */
export interface MediaBlockActions {
  readonly setProps: (props: Partial<Record<'caption' | 'textAlignment' | 'previewWidth', unknown>>) => void;
  readonly remove: () => void;
  readonly download: () => void;
  /** Starts moving the row, the way its handle does. */
  readonly dragStart: (event: DragEvent) => void;
  /** Ends what {@link MediaBlockActions.dragStart} started. */
  readonly dragEnd: () => void;
  /** Hands the keyboard back to the body, from a control of the block that held it. */
  readonly focusBody: () => void;
}

interface DocumentMediaBlockProps {
  type: MediaBlockType;
  props: MediaBlockProps;
  /** Whether the block is node-selected, which gives it its corner knobs. */
  selected: boolean;
  /** Whether the pointer is on the block, which frames it as selected does. */
  hovered: boolean;
  /** Whether its toolbar is the one bar the document shows (`document-bars.ts`). */
  toolbarShown: boolean;
  /** The container the block is drawn into, which names it to `onHover`. */
  host: HTMLElement;
  /** Told when the pointer arrives on the block or leaves it. */
  onHover: (host: HTMLElement, on: boolean) => void;
  actions: MediaBlockActions;
}

/** The narrowest an image or a video can be dragged to. */
const MIN_WIDTH: Readonly<Record<'image' | 'video', number>> = {
  image: 48,
  // The player's play button, seek bar and full-screen button, the controls
  // it keeps at its narrowest (`MediaPlayer`).
  video: 128,
};

/** The gap between the toolbar and the media's top edge, `pb-2` above it and `top-2` on it. */
const TOOLBAR_GAP = 8;

/** The block's own controls, which the node view hands their events. */
export const MEDIA_CHROME = '[data-media-chrome]';

/**
 * Whether a press belongs to the block's own controls or the player's.
 * @param target - Where it landed.
 * @returns True when it does.
 */
function ownsPress(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`${MEDIA_CHROME}, .nodrag`) !== null;
}

/** The scroller the body is shown in, which clips what sticks out of it. */
const SCROLLER = '[data-radix-scroll-area-viewport]';

/** The alignments, in the order the toolbar offers them. */
const ALIGNMENTS = [
  { value: 'left', Icon: AlignLeft, labelKey: 'spaces.document.commands.alignLeft' },
  { value: 'center', Icon: AlignCenter, labelKey: 'spaces.document.commands.alignCenter' },
  { value: 'right', Icon: AlignRight, labelKey: 'spaces.document.commands.alignRight' },
] as const;

/** The corner knobs of a selected picture or video, and the side each one pulls. */
const CORNERS = [
  { corner: 'nw', side: 'left', place: '-left-1 -top-1', cursor: 'cursor-nwse-resize' },
  { corner: 'ne', side: 'right', place: '-right-1 -top-1', cursor: 'cursor-nesw-resize' },
  { corner: 'sw', side: 'left', place: '-bottom-1 -left-1', cursor: 'cursor-nesw-resize' },
  { corner: 'se', side: 'right', place: '-bottom-1 -right-1', cursor: 'cursor-nwse-resize' },
] as const;

/** Where each alignment puts the media in its row. */
const JUSTIFY: Readonly<Record<string, string>> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
};

interface ToolButtonProps {
  label: string;
  action: string;
  testId: string;
  pressed?: boolean;
  /** Classes added to the button, for a colour of its own. */
  className?: string;
  onPress: () => void;
  children: React.ReactNode;
}

/**
 * One toolbar button, with its name on hover.
 * @param props - See {@link ToolButtonProps}.
 * @param props.label - Its name.
 * @param props.action - What it does, for the toolbar's own reading.
 * @param props.testId - Its test id.
 * @param props.pressed - Whether its state is the block's.
 * @param props.className - Classes added to the button.
 * @param props.onPress - What it does.
 * @param props.children - Its icon.
 * @returns The button.
 */
function ToolButton({
  label,
  action,
  testId,
  pressed,
  className,
  onPress,
  children,
}: ToolButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          className={cn(BUBBLE_ICON_BUTTON_SIZE, '[&_svg]:h-4 [&_svg]:w-4', pressed === true && PRESSED_CLASS, className)}
          data-action={action}
          data-testid={testId}
          data-state={pressed === true ? 'on' : 'off'}
          tabIndex={-1}
          onClick={onPress}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The block.
 * @param props - See {@link DocumentMediaBlockProps}.
 * @param props.type - Image, video or audio.
 * @param props.props - The block's props.
 * @param props.selected - Whether the block is node-selected.
 * @param props.hovered - Whether the pointer is on it.
 * @param props.toolbarShown - Whether its toolbar is on screen.
 * @param props.host - Its container.
 * @param props.onHover - Told when the pointer arrives or leaves.
 * @param props.actions - What its controls do.
 * @returns The block's content.
 */
export const DocumentMediaBlock = React.memo(function DocumentMediaBlock({
  type,
  props,
  selected,
  hovered,
  toolbarShown,
  host,
  onHover,
  actions,
}: DocumentMediaBlockProps): React.JSX.Element {
  const t = useTranslation();
  const sized = type !== 'audio';
  const frame = React.useRef<HTMLDivElement>(null);
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);
  const [editingCaption, setEditingCaption] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [narrower, setNarrower] = React.useState(false);
  const toolbarRef = React.useRef<HTMLDivElement | null>(null);
  // The toolbar floats over the body like the selection bubble bar, and the
  // same way it takes no focus: the keys go on reaching the body.
  const [toolbarEl, setToolbarEl] = React.useState<HTMLDivElement | null>(null);
  const holdToolbar = React.useCallback((el: HTMLDivElement | null): void => {
    toolbarRef.current = el;
    setToolbarEl(el);
  }, []);
  usePressKeepsFocus(toolbarEl);
  // Set when the caption field closes on a key, so its blur does not commit
  // a second time, or commit what Escape threw away.
  const closedOnKey = React.useRef(false);
  // An input method confirms and cancels its candidates with Enter and Escape.
  const captionComposition = React.useMemo(compositionEnd, []);
  // Where the keyboard was when the full-screen picture opened, to go back to.
  const fullscreenOpener = React.useRef<Element | null>(null);
  const openFullscreen = React.useCallback((): void => {
    fullscreenOpener.current = document.activeElement;
    setFullscreen(true);
  }, []);
  // Above the media, unless the scroller has no room there — then on the
  // media itself, along its top. Never under it: below the media sit its
  // caption and the next block, and a bar there reads as theirs.
  const [side, setSide] = React.useState<'top' | 'inside'>('top');
  const placeToolbar = React.useCallback((): void => {
    const element = frame.current;
    const bar = toolbarRef.current;
    const scroller = element?.closest(SCROLLER);
    if (element === null || bar === null || scroller === null || scroller === undefined) return;
    const room = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    setSide(room >= bar.offsetHeight + TOOLBAR_GAP ? 'top' : 'inside');
  }, []);
  // Placed when it shows, and again on every scroll while it is up: the room
  // above the media changes as the body moves under it.
  React.useEffect(() => {
    if (!toolbarShown) return undefined;
    placeToolbar();
    const scroller = frame.current?.closest(SCROLLER);
    if (scroller === null || scroller === undefined) return undefined;
    scroller.addEventListener('scroll', placeToolbar, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', placeToolbar);
    };
  }, [toolbarShown, placeToolbar]);
  const captionField = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (editingCaption) {
      closedOnKey.current = false;
      captionField.current?.focus();
    }
  }, [editingCaption]);

  // Alignment changes nothing on screen when the media is as wide as the
  // body, so it is offered only when it is narrower (A9).
  React.useLayoutEffect(() => {
    const element = frame.current;
    if (!sized || element === null) return undefined;
    /** Reads whether the media is narrower than its row. */
    const measure = (): void => {
      const row = element.parentElement;
      setNarrower(row !== null && element.offsetWidth < row.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement !== null) observer.observe(element.parentElement);
    return () => {
      observer.disconnect();
    };
  }, [sized]);

  const width = dragWidth ?? props.previewWidth;
  const alignment = props.textAlignment ?? 'center';

  /**
   * Starts a drag on one side's handle; the width is written once, on release.
   * @param side - Which side.
   * @param event - The press.
   */
  const startResize = (side: 'left' | 'right', event: React.PointerEvent<HTMLElement>): void => {
    const element = frame.current;
    if (element === null) return;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    // What is on screen, which a narrower body caps below the stored width.
    const startWidth = element.offsetWidth;
    const maxWidth = element.parentElement?.clientWidth ?? 0;
    // A centred block grows on both sides at once.
    const factor = (alignment === 'center' ? 2 : 1) * (side === 'right' ? 1 : -1);
    /**
     * The width the pointer at this x asks for.
     * @param x - The pointer's x.
     * @returns The width, within bounds.
     */
    const widthAt = (x: number): number => {
      const raw = startWidth + (x - startX) * factor;
      const capped = maxWidth > 0 ? Math.min(raw, maxWidth) : raw;
      return Math.round(Math.max(MIN_WIDTH[type === 'video' ? 'video' : 'image'], capped));
    };
    /**
     * Shows the width the drag has reached.
     * @param move - The move.
     */
    const onMove = (move: PointerEvent): void => {
      setDragWidth(widthAt(move.clientX));
    };
    /**
     * Writes the width the drag ended on.
     * @param up - The release.
     */
    const onUp = (up: PointerEvent): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      setDragWidth(null);
      if (up.clientX !== startX) actions.setProps({ previewWidth: widthAt(up.clientX) });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  /**
   * Writes the caption, when it changed.
   * @param value - What the field holds.
   */
  const commitCaption = (value: string): void => {
    setEditingCaption(false);
    if (value !== props.caption) actions.setProps({ caption: value });
  };

  const body =
    type === 'image' ? (
      <img
        src={props.url}
        alt=''
        loading='lazy'
        decoding='async'
        draggable={false}
        className='block h-auto w-full'
        onDoubleClick={openFullscreen}
      />
    ) : (
      <MediaPlayer modality={type} src={props.url} />
    );

  return (
    <div
      data-testid='doc-media-row'
      className={`flex w-full ${sized ? (JUSTIFY[alignment] ?? 'justify-center') : ''}`}
    >
      <div
        ref={frame}
        data-testid='doc-media-box'
        data-media-box=''
        data-hovered={hovered ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        onPointerEnter={() => {
          placeToolbar();
          onHover(host, true);
        }}
        onPointerLeave={() => {
          onHover(host, false);
        }}
        className={cn('relative max-w-full', !sized && 'w-full')}
        style={{
          ...(type === 'video' && { minWidth: `${MIN_WIDTH.video}px` }),
          ...(sized && width !== undefined && { width: `${width}px` }),
        }}
      >
        {/* Above the media, the gap between it and its bar is padding on this
            layer, not a margin, so a pointer crossing it stays inside the
            block and the bar stays up. It takes the pointer only while the bar is shown, so
            the line above the media is clickable the rest of the time. */}
        <div
          data-media-chrome=''
          className={cn(
            'absolute left-1/2 z-10 -translate-x-1/2',
            toolbarShown ? 'pointer-events-auto' : 'pointer-events-none',
            side === 'top' ? 'bottom-full pb-2' : 'top-2',
          )}
        >
          <div
            ref={holdToolbar}
            data-testid='doc-media-toolbar'
            data-side={side}
            data-shown={toolbarShown ? 'true' : undefined}
            className={cn(BUBBLE_BAR_CLASS, !toolbarShown && 'invisible')}
          >
            {sized &&
            narrower &&
            ALIGNMENTS.map(({ value, Icon, labelKey }) => (
              <ToolButton
                key={value}
                label={t(labelKey)}
                action='align'
                testId={`doc-media-align-${value}`}
                pressed={alignment === value}
                onPress={() => {
                  actions.setProps({ textAlignment: value });
                }}
              >
                <Icon />
              </ToolButton>
            ))}
            <ToolButton
              label={t('spaces.document.media.caption')}
              action='caption'
              testId='doc-media-caption-button'
              onPress={() => {
                setEditingCaption(true);
              }}
            >
              <Type />
            </ToolButton>
            {type === 'image' && (
              <ToolButton
                label={t('spaces.document.media.fullscreen')}
                action='fullscreen'
                testId='doc-media-fullscreen'
                onPress={openFullscreen}
              >
                <Maximize2 />
              </ToolButton>
            )}
            <ToolButton
              label={t('spaces.document.media.download')}
              action='download'
              testId='doc-media-download'
              onPress={actions.download}
            >
              <Download />
            </ToolButton>
            <ToolButton
              label={t('spaces.document.media.delete')}
              action='delete'
              testId='doc-media-delete'
              // The red every delete row in the body uses (block and table
              // menus), kept on hover.
              className='text-status-error-foreground hover:text-status-error-foreground'
              onPress={actions.remove}
            >
              <Trash2 />
            </ToolButton>
          </div>
        </div>
        {/* The media itself, which is what a frame goes around: the caption
            under it is the block's text, not its content area. */}
        <div
          data-testid='doc-media-frame'
          data-media-frame=''
          className='relative'
          draggable
          // Decided as the press lands: the corners resize and the player's
          // controls play, and a native drag starting under either would
          // cancel their pointer (a drag begins with `pointercancel`).
          onPointerDownCapture={(event) => {
            event.currentTarget.draggable = !ownsPress(event.target);
          }}
          onDragStart={(event) => {
            actions.dragStart(event.nativeEvent);
          }}
          onDragEnd={actions.dragEnd}
        >
          {body}
          {sized &&
            selected &&
            CORNERS.map(({ corner, side: towards, place, cursor }) => (
              <span
                key={corner}
                data-media-chrome=''
                data-media-knob=''
                data-testid={`doc-media-resize-${corner}`}
                className={`absolute h-2 w-2 rounded-sm border bg-background ${place} ${cursor}`}
                onPointerDown={(event) => {
                  startResize(towards, event);
                }}
              />
            ))}
        </div>
        {editingCaption ? (
          <input
            data-media-chrome=''
            ref={captionField}
            data-testid='doc-media-caption-input'
            autoComplete='off'
            defaultValue={props.caption}
            placeholder={t('spaces.document.media.captionPlaceholder')}
            className='mt-1.5 w-full border-0 border-b border-border bg-transparent py-0.5 text-center text-sm text-foreground outline-none'
            onCompositionEnd={captionComposition.mark}
            onKeyDown={(event) => {
              if (keyBelongsToInputMethod(event.nativeEvent, captionComposition)) return;
              if (event.key !== 'Enter' && event.key !== 'Escape') return;
              closedOnKey.current = true;
              const { value } = event.currentTarget;
              // The keyboard goes back to the body while the field still holds
              // it: a focused field leaving the page reads as the reader
              // leaving the body, which lets go of the block.
              actions.focusBody();
              if (event.key === 'Enter') commitCaption(value);
              else setEditingCaption(false);
            }}
            onBlur={(event) => {
              // A key already closed it, or the window went to another app and
              // the field is still the reader's to come back to.
              if (closedOnKey.current || !event.currentTarget.ownerDocument.hasFocus()) return;
              commitCaption(event.currentTarget.value);
            }}
          />
        ) : props.caption !== '' ? (
          <div
            data-testid='doc-media-caption'
            className='mt-1.5 text-center text-sm text-muted-foreground'
          >
            {props.caption}
          </div>
        ) : null}
      </div>
      {type === 'image' && (
        <Dialog open={fullscreen} onOpenChange={setFullscreen}>
          <DialogContent
            aria-describedby={undefined}
            // The dialog has no trigger to return to: the keyboard goes back
            // where it was when the picture opened, or to the body.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const opener = fullscreenOpener.current;
              fullscreenOpener.current = null;
              if (opener instanceof HTMLElement && opener.isConnected && opener !== opener.ownerDocument.body) {
                opener.focus();
              } else {
                actions.focusBody();
              }
            }}
            className='max-w-[min(96vw,1600px)] items-center border-0 bg-transparent shadow-none'
          >
            <DialogTitle className='sr-only'>{props.name}</DialogTitle>
            <img
              src={props.url}
              alt=''
              data-testid='doc-media-fullscreen-image'
              className='max-h-[90vh] max-w-full object-contain'
            />
            <DialogClose asChild>
              <Button
                variant='chrome-ghost'
                size='icon'
                className='absolute right-2 top-2'
                aria-label={t('spaces.document.media.close')}
              >
                <X />
              </Button>
            </DialogClose>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
});
