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
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

/** The media block types. */
export type MediaBlockType = 'image' | 'video' | 'audio';

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
}

interface DocumentMediaBlockProps {
  type: MediaBlockType;
  props: MediaBlockProps;
  /** Whether the block is node-selected, which keeps its toolbar up. */
  selected: boolean;
  actions: MediaBlockActions;
}

/** The narrowest an image or a video can be dragged to. */
const MIN_WIDTH = 48;

/** The alignments, in the order the toolbar offers them. */
const ALIGNMENTS = [
  { value: 'left', Icon: AlignLeft, labelKey: 'spaces.document.commands.alignLeft' },
  { value: 'center', Icon: AlignCenter, labelKey: 'spaces.document.commands.alignCenter' },
  { value: 'right', Icon: AlignRight, labelKey: 'spaces.document.commands.alignRight' },
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
 * @param props.onPress - What it does.
 * @param props.children - Its icon.
 * @returns The button.
 */
function ToolButton({
  label,
  action,
  testId,
  pressed,
  onPress,
  children,
}: ToolButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='icon'
          className='h-[var(--btn-inline)] w-[var(--btn-inline)] [&_svg]:h-4 [&_svg]:w-4'
          data-action={action}
          data-testid={testId}
          data-state={pressed === true ? 'on' : 'off'}
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
 * @param props.actions - What its controls do.
 * @returns The block's content.
 */
export function DocumentMediaBlock({
  type,
  props,
  selected,
  actions,
}: DocumentMediaBlockProps): React.JSX.Element {
  const t = useTranslation();
  const sized = type !== 'audio';
  const frame = React.useRef<HTMLDivElement>(null);
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);
  const [editingCaption, setEditingCaption] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [narrower, setNarrower] = React.useState(false);
  const captionField = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (editingCaption) captionField.current?.focus();
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
  });

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
    const startWidth = props.previewWidth ?? element.offsetWidth;
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
      return Math.round(Math.max(MIN_WIDTH, capped));
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
      actions.setProps({ previewWidth: widthAt(up.clientX) });
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
        onDoubleClick={() => {
          setFullscreen(true);
        }}
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
        data-testid='doc-media-frame'
        data-selected={selected ? 'true' : undefined}
        className={`group/media relative max-w-full ${sized ? '' : 'w-full'}`}
        style={sized && width !== undefined ? { width: `${width}px` } : undefined}
      >
        <div
          data-media-chrome=''
          data-testid='doc-media-toolbar'
          className='invisible absolute bottom-full left-1/2 z-10 mb-2 flex -translate-x-1/2 group-hover/media:visible group-data-[selected=true]/media:visible items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-sm'
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
              onPress={() => {
                setFullscreen(true);
              }}
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
            onPress={actions.remove}
          >
            <Trash2 />
          </ToolButton>
        </div>
        {body}
        {sized &&
          (['left', 'right'] as const).map((side) => (
            <span
              key={side}
              data-media-chrome=''
              data-testid={`doc-media-resize-${side}`}
              className={`invisible absolute top-1/2 group-hover/media:visible group-data-[selected=true]/media:visible h-10 w-1.5 -translate-y-1/2 cursor-ew-resize rounded-full bg-foreground/50 ${side === 'left' ? 'left-1.5' : 'right-1.5'}`}
              onPointerDown={(event) => {
                startResize(side, event);
              }}
            />
          ))}
        {editingCaption ? (
          <input
            data-media-chrome=''
            ref={captionField}
            data-testid='doc-media-caption-input'
            autoComplete='off'
            defaultValue={props.caption}
            placeholder={t('spaces.document.media.captionPlaceholder')}
            className='mt-1.5 w-full border-0 border-b border-border bg-transparent py-0.5 text-center text-sm text-foreground outline-none'
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitCaption(event.currentTarget.value);
              if (event.key === 'Escape') setEditingCaption(false);
            }}
            onBlur={(event) => {
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
}
