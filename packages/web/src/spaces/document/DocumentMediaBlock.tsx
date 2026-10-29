// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an image, video or audio block shows in the body (inner#1127 A7–A9,
 * A16, A17, A19), rendered into its node view's container by
 * `DocumentMediaViews`.
 *
 * Editing controls carry `[data-media-chrome]`, whose events belong to the
 * node view and whose visibility follows current edit permission. Playback
 * controls and copyable caption drafts keep their own presentation lifetime.
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
import { autoUpdate, offset, shift, useFloating } from '@floating-ui/react';
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
import { DocumentMediaImage } from '@web/spaces/document/DocumentMediaImage';
import { Popover, PopoverTrigger, PopoverContent } from '@web/components/ui/popover';
import { MediaControlsPortal, type VideoControlsTarget } from '@web/spaces/canvas/nodes/_shared/media-video-controls';
import { documentBarsOf, mediaEvent, mediaPanelShown, useDocumentBars } from '@web/spaces/document/document-bars';
import { captionDraftsFor } from '@web/spaces/document/document-caption-drafts';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** The media block types. */
import type { MediaBlockType } from '@web/spaces/document/document-media-types';

/** The block's props, as far as this view reads them. */
export interface MediaBlockProps {
  readonly url: string;
  readonly name: string;
  readonly caption: string;
  /** Image and video only. */
  readonly previewWidth?: number;
  /** Image and video only: the pixel size the server read off the stored file (its upright copy for a picture with an EXIF orientation). */
  readonly mediaWidth?: number;
  readonly mediaHeight?: number;
  /** Image and video only. */
  readonly textAlignment?: string;
}

/** What the toolbar and the handles do, against the block as it is now. */
export interface MediaBlockActions {
  /** Reads current editability and target existence at commit time. */
  readonly canEdit?: () => boolean;
  readonly setProps: (props: Partial<Record<'caption' | 'textAlignment' | 'previewWidth', unknown>>) => void;
  readonly remove: () => void;
  readonly download: () => void;
  /** Starts moving the row, the way its handle does. */
  readonly dragStart: (event: DragEvent) => void;
  /** Ends what {@link MediaBlockActions.dragStart} started. */
  readonly dragEnd: () => void;
  /** Selects the block whole and gives the body the keyboard. */
  readonly select: () => void;
  /** Hands the keyboard back to the body, from a control of the block that held it. */
  readonly focusBody: () => void;
  /** Whether an element is inside the body this block is in. */
  readonly bodyHolds: (element: Element) => boolean;
}

interface DocumentMediaBlockProps {
  editor: object;
  blockId: string;
  readOnly: boolean;
  viewport: HTMLElement | null;
  type: MediaBlockType;
  props: MediaBlockProps;
  /** Whether the block is node-selected, which gives it its corner knobs. */
  selected: boolean;
  /** Whether the pointer is on the media or its toolbar, which frames it as selected does. */
  hovered: boolean;
  /** Whether its toolbar is the one bar the document shows (`document-bars.ts`). */
  toolbarShown: boolean;
  /** The container the block is drawn into, which names it to `onHover`. */
  host: HTMLElement;
  /** Told when the pointer arrives on the media or its toolbar, or leaves them. */
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

/** Playback controls that retain their own focus and pointer capture. */
export const MEDIA_PLAYBACK = '[data-media-playback]';

/** Controls whose focus and browser input must not be taken by the body. */
export const MEDIA_CONTROLS = `${MEDIA_CHROME}, ${MEDIA_PLAYBACK}`;

/** What the block shows: the picture or the player. */
export const MEDIA_FRAME = '[data-media-frame]';

/** The caption field, open while the caption is edited. */
export const MEDIA_CAPTION_INPUT = '[data-testid="doc-media-caption-input"]';

/**
 * Whether a press belongs to the block's own controls or the player's.
 * @param target - Where it landed.
 * @returns True when it does.
 */
function ownsPress(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`${MEDIA_CONTROLS}, .nodrag`) !== null;
}

/** The alignments, in the order the toolbar offers them. */
const ALIGNMENTS = [
  { value: 'left', Icon: AlignLeft, labelKey: 'spaces.document.commands.alignLeft' },
  { value: 'center', Icon: AlignCenter, labelKey: 'spaces.document.commands.alignCenter' },
  { value: 'right', Icon: AlignRight, labelKey: 'spaces.document.commands.alignRight' },
] as const;

/**
 * The corner knobs of a selected picture or video, and the side each one
 * pulls. Each takes a press on a 24px square centred on its corner, the
 * smallest target WCAG 2.5.8 allows; the stylesheet draws its 8px square.
 */
const CORNERS = [
  { corner: 'nw', side: 'left', place: '-left-3 -top-3', cursor: 'cursor-nwse-resize' },
  { corner: 'ne', side: 'right', place: '-right-3 -top-3', cursor: 'cursor-nesw-resize' },
  { corner: 'sw', side: 'left', place: '-bottom-3 -left-3', cursor: 'cursor-nesw-resize' },
  { corner: 'se', side: 'right', place: '-bottom-3 -right-3', cursor: 'cursor-nwse-resize' },
] as const;

/**
 * The selection bar's rule between groups (16px tall, 5px either side once the
 * bar's 2px gap is counted), drawn after the last alignment: an element of its
 * own inside the block would put line breaks in the page's selection of the
 * block.
 */
const GROUP_RULE_AFTER =
  'relative mr-[9px] after:absolute after:-right-[6px] after:top-1/2 after:h-4 after:w-px after:-translate-y-1/2 after:bg-border';

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
  tabbable?: boolean;
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
 * @param props.tabbable - Whether keyboard traversal reaches this action.
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
  tabbable = false,
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
          tabIndex={tabbable ? 0 : -1}
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
 * @param props.hovered - Whether the pointer is on the media or its toolbar.
 * @param props.toolbarShown - Whether its toolbar is on screen.
 * @param props.host - Its container.
 * @param props.onHover - Told when the pointer arrives or leaves.
 * @param props.actions - What its controls do.
 * @param props.viewport - The document-owned vertical scroll boundary.
 * @returns The block's content.
 */
export const DocumentMediaBlock = React.memo(function DocumentMediaBlock({
  editor,
  blockId,
  readOnly,
  viewport,
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
  const drafts = captionDraftsFor(editor);
  const subscribeDraft = React.useCallback((listener: () => void): (() => void) => drafts.subscribe(listener), [drafts]);
  const draft = React.useSyncExternalStore(subscribeDraft, () => drafts.get(blockId));
  const editingCaption = draft?.phase === 'editing' || draft?.phase === 'suspended';
  const bars = useDocumentBars(editor);
  const [floatingActions, setFloatingActions] = React.useState<HTMLDivElement | null>(null);
  const [inlineActions, setInlineActions] = React.useState<HTMLDivElement | null>(null);
  const [floatingTransport, setFloatingTransport] = React.useState<HTMLDivElement | null>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const closeEpochs = React.useRef(new WeakMap<EventTarget, number>());
  const trigger = React.useRef<HTMLDivElement>(null);
  const migratingActions = React.useRef(false);
  const leaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionFocused = React.useRef(false);
  const previousReadOnly = React.useRef(readOnly);
  const handoffAfterRoleChange = readOnly && !previousReadOnly.current && actionFocused.current;
  const [fullscreen, setFullscreen] = React.useState(false);
  const fullscreenId = React.useId();
  const [narrower, setNarrower] = React.useState(false);
  // The width the media is laid out at, which the preview is judged against.
  const [shownWidth, setShownWidth] = React.useState<number | null>(null);
  const [transportMinWidth, setTransportMinWidth] = React.useState(MIN_WIDTH.video);
  // The address whose picture has loaded or failed for good.
  const [settledFor, setSettledFor] = React.useState<string | null>(null);
  const toolbarRef = React.useRef<HTMLDivElement | null>(null);
  // The toolbar floats over the body like the selection bubble bar, and the
  // same way it takes no focus: the keys go on reaching the body.
  const [toolbarEl, setToolbarEl] = React.useState<HTMLDivElement | null>(null);
  const holdToolbar = React.useCallback((el: HTMLDivElement | null): void => {
    toolbarRef.current = el;
    setToolbarEl(el);
  }, []);
  const floating = type === 'video' && (shownWidth === null || shownWidth < transportMinWidth);
  const panelShown = floating && mediaPanelShown(bars, host);
  usePressKeepsFocus(floating ? null : toolbarEl);
  // Set when the caption field closes on a key, so its blur does not commit
  // a second time, or commit what Escape threw away.
  const closedOnKey = React.useRef(false);
  // An input method confirms and cancels its candidates with Enter and Escape.
  const captionComposition = React.useMemo(compositionEnd, []);
  // Where the keyboard was when the full-screen picture opened, to go back
  // to: the body, an element outside it, or nowhere. Read as it opens, while
  // whatever held the keyboard is still on the page.
  const fullscreenOpener = React.useRef<'body' | HTMLElement | null>(null);
  const openFullscreen = React.useCallback((): void => {
    const held = document.activeElement;
    fullscreenOpener.current =
      held === null || held === held.ownerDocument.body
        ? null
        : actions.bodyHolds(held)
          ? 'body'
          : held instanceof HTMLElement
            ? held
            : null;
    setFullscreen(true);
  }, [actions]);
  // Above the media, unless the scroller has no room there — then on the
  // media itself, along its top. Never under it: below the media sit its
  // caption and the next block, and a bar there reads as theirs.
  const [side, setSide] = React.useState<'top' | 'inside'>('top');
  const placeToolbar = React.useCallback((): void => {
    const element = frame.current;
    const bar = toolbarRef.current;
    const scroller = viewport;
    if (element === null || bar === null || scroller === null) return;
    const room = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    setSide(room >= bar.offsetHeight + TOOLBAR_GAP ? 'top' : 'inside');
  }, [viewport]);
  // A table clips what reaches past it (its scroller scrolls sideways), so in
  // a cell the toolbar's layer is placed against the viewport, `fixed`, at
  // the same place against the media and kept inside the body. It stays in
  // the block's own elements: React reads a pointer moving between portals
  // nested in portals as leaving them.
  const [inCell, setInCell] = React.useState(false);
  React.useLayoutEffect(() => {
    setInCell(host.closest(`[data-node-type='${DOC_TABLE}']`) !== null);
  }, [host]);
  const { refs: layerRefs, floatingStyles: layerStyles } = useFloating({
    open: inCell,
    placement: 'top',
    strategy: 'fixed',
    middleware: [
      offset(side === 'top' ? 0 : ({ rects }) => -rects.floating.height - TOOLBAR_GAP),
      shift({ boundary: viewport ?? undefined }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const { setReference, setFloating } = layerRefs;
  const holdBox = React.useCallback((el: HTMLDivElement | null): void => {
    frame.current = el;
    setReference(el);
  }, [setReference]);
  const holdLayer = React.useCallback((el: HTMLDivElement | null): void => {
    setInlineActions(el);
    setFloating(el);
  }, [setFloating]);
  // Placed when it shows, and again on every scroll while it is up: the room
  // above the media changes as the body moves under it.
  React.useEffect(() => {
    if (!toolbarShown) return undefined;
    placeToolbar();
    const scroller = viewport;
    if (scroller === null) return undefined;
    scroller.addEventListener('scroll', placeToolbar, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', placeToolbar);
    };
  }, [toolbarShown, placeToolbar, viewport]);
  // The pointer is on the block while it is on what the block shows or on
  // its toolbar; the caption under it is the block's text, and answers
  // neither the hover nor a click (`document-media-row-press.ts`).
  const pointerOn = React.useCallback((): void => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    placeToolbar();
    onHover(host, true);
  }, [placeToolbar, onHover, host]);
  const pointerOff = React.useCallback((): void => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    if (!floating) { onHover(host, false); return; }
    mediaEvent(editor, { type: 'leave', host });
    const duration = parseFloat(getComputedStyle(host).getPropertyValue('--duration-fast')) || 0;
    leaveTimer.current = setTimeout(() => onHover(host, false), duration);
  }, [onHover, host, floating, editor]);
  const captionField = React.useRef<HTMLInputElement>(null);
  React.useLayoutEffect(() => {
    previousReadOnly.current = readOnly;
    if (!handoffAfterRoleChange || editingCaption || documentBarsOf(editor).media.activity?.kind === 'seeking') return;
    mediaEvent(editor, { type: 'outside', host });
    const destination = trigger.current ?? host.querySelector<HTMLElement>('[data-testid="play-toggle"]');
    if (destination !== null) destination.focus({ preventScroll: true });
    else actions.focusBody();
  }, [readOnly, handoffAfterRoleChange, editingCaption, editor, host, actions]);
  const captionSession = React.useRef(0);
  if (editingCaption && draft !== undefined) captionSession.current = draft.session;
  /** Saves the last DOM value when this presentation is hidden or removed. */
  const detachCaption = React.useCallback((): void => {
    const value = captionField.current?.value;
    drafts.event(blockId, { type: 'detach', session: captionSession.current, value });
  }, [drafts, blockId]);
  React.useLayoutEffect(() => detachCaption, [detachCaption]);
  React.useEffect(() => () => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    mediaEvent(editor, { type: 'release', host });
  }, [editor, host]);
  const captionIntent = bars.media.intent;
  React.useLayoutEffect(() => {
    if (!editingCaption) return;
    closedOnKey.current = false;
    // Only the caption button's handoff takes focus, also into a field that
    // is already open; a draft shown again (its block restored, the view
    // remounted) leaves focus where the user is.
    if (captionIntent?.host !== host || floating) return;
    captionField.current?.focus();
    mediaEvent(editor, { type: 'complete-caption', host, epoch: captionIntent.epoch });
  }, [editingCaption, floating, captionIntent, editor, host]);
  React.useEffect(() => {
    if (type !== 'video') return undefined;
    /**
     * Releases ownership when focus reaches a separate user surface.
     * @param event - The actual focus destination.
     */
    const outsideFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Node && !host.contains(target) && !panel.current?.contains(target)) mediaEvent(editor, { type: 'outside', host });
    };
    document.addEventListener('focusin', outsideFocus);
    return () => document.removeEventListener('focusin', outsideFocus);
  }, [type, editor, host]);
  React.useEffect(() => {
    if (!panelShown) return undefined;
    const scroller = viewport;
    if (scroller === null) return undefined;
    /** Releases a panel whose media has left the document viewport. */
    const follow = (): void => {
      const box = frame.current?.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      if (box !== undefined && box.height > 0 && viewport.height > 0 && (box.bottom <= viewport.top || box.top >= viewport.bottom)) mediaEvent(editor, { type: 'release', host });
    };
    scroller.addEventListener('scroll', follow, { passive: true });
    return () => scroller.removeEventListener('scroll', follow);
  }, [panelShown, editor, host, viewport]);
  const onControlFocus = React.useCallback((focused: boolean, relatedTarget: EventTarget | null): void => {
    const inside = relatedTarget instanceof Element && (panel.current?.contains(relatedTarget) || toolbarRef.current?.contains(relatedTarget) ||
      (host.contains(relatedTarget) && relatedTarget.closest('[data-testid="controls"]') !== null));
    if (!focused && inside) return;
    mediaEvent(editor, { type: 'focus', host, focused });
  }, [editor, host]);
  const onSeekingChange = React.useCallback((active: boolean, release: () => void): void => {
    if (active) mediaEvent(editor, { type: 'seek-start', host, release });
    else mediaEvent(editor, { type: 'seek-end', host, focused: host.contains(document.activeElement) || panel.current?.contains(document.activeElement) === true });
  }, [editor, host]);
  const videoControls = React.useMemo<VideoControlsTarget>(() => ({
    destination: floating ? panelShown ? floatingTransport : null : 'inline',
    surface: floating ? 'popover' : 'video',
    preserveFocus: bars.media.activity?.host === host,
    onFocusChange: onControlFocus,
    onSeekingChange,
  }), [floating, panelShown, floatingTransport, bars.media.activity, host, onControlFocus, onSeekingChange]);

  // Alignment changes nothing on screen when the media is as wide as the
  // body, so it is offered only when it is narrower (A9).
  React.useLayoutEffect(() => {
    const element = frame.current;
    if (!sized || element === null) return undefined;
    /** Reads whether the media is narrower than its row. */
    const measure = (): void => {
      const row = element.parentElement;
      setNarrower(row !== null && element.offsetWidth < row.clientWidth);
      setShownWidth(element.offsetWidth > 0 ? element.offsetWidth : null);
      const style = getComputedStyle(element);
      const button = parseFloat(style.getPropertyValue('--btn-inline'));
      const gap = parseFloat(style.getPropertyValue('--space-4'));
      if (button > 0 && gap > 0) setTransportMinWidth(2 * button + 40 + 4 * gap);
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
  const { mediaWidth, mediaHeight } = props;
  // Until it loads, a picture or video has no width of its own: the box holds
  // the one it will be shown at, its own pixel width capped by the row (A23).
  // A picture with no stored size fills the row only while it loads.
  const boxWidth = width ?? mediaWidth;
  const waiting = settledFor !== props.url;
  const fillsRow = type === 'image' && boxWidth === undefined && waiting;
  const mediaSize = React.useMemo(
    () =>
      type === 'video' && mediaWidth !== undefined && mediaHeight !== undefined
        ? { width: mediaWidth, height: mediaHeight }
        : undefined,
    [type, mediaWidth, mediaHeight],
  );
  const alignment = props.textAlignment ?? 'center';

  /**
   * Starts a drag on one side's handle; the width is written once, on release.
   * @param side - Which side.
   * @param event - The press.
   */
  const startResize = (side: 'left' | 'right', event: React.PointerEvent<HTMLElement>): void => {
    const element = frame.current;
    if (element === null || readOnly || actions.canEdit?.() === false) return;
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
      const requested = Math.max(MIN_WIDTH[type === 'video' ? 'video' : 'image'], raw);
      return Math.round(maxWidth > 0 ? Math.min(requested, maxWidth) : requested);
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
    const current = drafts.get(blockId);
    if (current === undefined) return;
    drafts.event(blockId, { type: 'input', session: captionSession.current, value });
    drafts.event(blockId, { type: 'commit', session: captionSession.current, caption: props.caption,
      readOnly: readOnly || actions.canEdit?.() === false, exists: current.exists,
      write: (caption) => actions.setProps({ caption }),
    });
  };

  const body =
    type === 'image' ? (
      <DocumentMediaImage
        url={props.url}
        shownWidth={shownWidth}
        mediaWidth={props.mediaWidth}
        mediaHeight={props.mediaHeight}
        waiting={waiting}
        onSettle={setSettledFor}
        onDoubleClick={openFullscreen}
      />
    ) : (
      <MediaPlayer modality={type} src={props.url} size={mediaSize} videoControls={type === 'video' ? videoControls : undefined} />
    );

  const toolbar = (
    <div
      ref={holdToolbar}
      data-testid='doc-media-toolbar'
      inert={readOnly}
      // Rendered through a portal, so React counts entering it as leaving the
      // layer it sits in; it holds the hover itself.
      onPointerEnter={pointerOn}
      onPointerLeave={pointerOff}
      onFocusCapture={() => {
        if (!migratingActions.current) { actionFocused.current = true; onControlFocus(true, null); }
      }}
      onBlurCapture={(event) => {
        if (!migratingActions.current) {
          actionFocused.current = event.currentTarget.contains(event.relatedTarget);
          onControlFocus(false, event.relatedTarget);
        }
      }}
      data-side={side}
      data-shown={toolbarShown ? 'true' : undefined}
      className={cn(floating && panelShown ? 'flex items-center gap-0.5 p-0.5' : BUBBLE_BAR_CLASS, (!toolbarShown || readOnly || (floating && !panelShown)) && 'invisible')}
    >
      {sized &&
            narrower &&
            ALIGNMENTS.map(({ value, Icon, labelKey }) => (
              <ToolButton
                tabbable={floating && panelShown}
                key={value}
                label={t(labelKey)}
                action='align'
                testId={`doc-media-align-${value}`}
                pressed={alignment === value}
                className={value === 'right' ? GROUP_RULE_AFTER : undefined}
                onPress={() => {
                  actions.setProps({ textAlignment: value });
                }}
              >
                <Icon />
              </ToolButton>
            ))}
      <ToolButton
        tabbable={floating && panelShown}
        label={t('spaces.document.media.caption')}
        action='caption'
        testId='doc-media-caption-button'
        onPress={() => {
          // An open field already holds the keyboard with the block selected.
          if (!editingCaption) actions.select();
          mediaEvent(editor, { type: 'caption', host });
          const intent = documentBarsOf(editor).media.intent;
          if (panel.current !== null && intent?.host === host) closeEpochs.current.set(panel.current, intent.epoch);
          drafts.event(blockId, { type: 'open', caption: props.caption, readOnly: readOnly || actions.canEdit?.() === false, exists: true });
        }}
      >
        <Type />
      </ToolButton>
      {type === 'image' && (
        <ToolButton
          tabbable={floating && panelShown}
          label={t('spaces.document.media.fullscreen')}
          action='fullscreen'
          testId='doc-media-fullscreen'
          onPress={() => {
            actions.select();
            openFullscreen();
          }}
        >
          <Maximize2 />
        </ToolButton>
      )}
      <ToolButton
        tabbable={floating && panelShown}
        label={t('spaces.document.media.download')}
        action='download'
        testId='doc-media-download'
        onPress={actions.download}
      >
        <Download />
      </ToolButton>
      <ToolButton
        tabbable={floating && panelShown}
        label={t('spaces.document.media.delete')}
        action='delete'
        testId='doc-media-delete'
        // The red every delete row in the body uses (block and table
        // menus), kept on hover.
        className='text-status-error-foreground hover-enabled:text-status-error-foreground'
        onPress={() => { actions.focusBody(); mediaEvent(editor, { type: 'release', host }); actions.remove(); }}
      >
        <Trash2 />
      </ToolButton>
    </div>
  );
  const mediaFrame = (
    <div
      data-testid='doc-media-frame'
      data-media-frame=''
      onPointerEnter={pointerOn}
      onPointerLeave={pointerOff}
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
                className={`absolute h-6 w-6 ${place} ${cursor}`}
                onPointerDown={(event) => {
                  startResize(towards, event);
                }}
              />
            ))}
    </div>
  );

  return (
    <div
      data-testid='doc-media-row'
      // The full-screen picture is a layer this block opened: the body keeps
      // its selection while the focus is in it.
      aria-controls={fullscreen ? fullscreenId : undefined}
      className={`flex w-full ${sized ? (JUSTIFY[alignment] ?? 'justify-center') : ''}`}
    >
      <div
        ref={holdBox}
        data-testid='doc-media-box'
        data-media-box=''
        data-controls-mode={type === 'video' ? floating ? 'floating' : 'inline' : undefined}
        data-hovered={hovered ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        className={cn(
          'relative max-w-full',
          (!sized || fillsRow) && 'w-full',
        )}
        style={{
          ...(type === 'video' && { minWidth: `min(${MIN_WIDTH.video}px, 100%)` }),
          ...(sized && boxWidth !== undefined && { width: `${boxWidth}px`, '--doc-media-width': `${boxWidth}px` }),
        }}
      >
        {/* Above the media, the gap between it and its bar is padding on this
            layer, not a margin, so a pointer crossing it stays inside the
            block and the bar stays up. It takes the pointer only while the bar is shown, so
            the line above the media is clickable the rest of the time. */}
        <div
          ref={holdLayer}
          data-media-chrome=''
          onPointerEnter={pointerOn}
          onPointerLeave={pointerOff}
          style={inCell ? layerStyles : undefined}
          className={cn(
            toolbarShown ? 'pointer-events-auto' : 'pointer-events-none',
            inCell
              // Over the table's row and column handles (10), as the
              // selection bubble bar is: both are summoned by the reader's
              // hand and go when it leaves.
              ? ['z-20', side === 'top' && 'pb-2']
              : ['absolute left-1/2 z-10 -translate-x-1/2', side === 'top' ? 'bottom-full pb-2' : 'top-2'],
          )}
        />
        {/* The media itself, which is what a frame goes around: the caption
            under it is the block's text, not its content area. */}
        {type === 'video' ? (
          <Popover open={panelShown} onOpenChange={(open) => {
            if (open) mediaEvent(editor, { type: 'open', host, origin: 'keyboard' });
            else mediaEvent(editor, { type: 'outside', host });
          }}>
            <PopoverTrigger asChild>
              <Button asChild variant={null} size={null} className='block w-full whitespace-normal rounded-none p-0'>
                <div ref={trigger} data-testid='doc-media-video-trigger' role='button' tabIndex={floating ? 0 : -1}
                  className='outline-none focus-visible:ring-1 focus-visible:ring-ring'
                  onClick={(event) => { event.preventDefault(); }}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && event.key === 'Enter' && floating) {
                      event.preventDefault(); event.stopPropagation(); mediaEvent(editor, { type: 'open', host, origin: 'keyboard' });
                      panel.current?.focus({ preventScroll: true });
                    }
                  }}
                >{mediaFrame}</div>
              </Button>
            </PopoverTrigger>
            <PopoverContent ref={panel} data-testid='doc-media-video-panel' tabIndex={-1}
              collisionBoundary={viewport} collisionPadding={4} side='top' sideOffset={8}
              className='w-max p-1'
              style={{ minWidth: `calc(${transportMinWidth}px + 2 * (var(--space-2) + 1px))` }}
              onPointerEnter={pointerOn} onPointerLeave={pointerOff}
              onFocusCapture={() => onControlFocus(true, null)}
              onBlurCapture={(event) => onControlFocus(false, event.relatedTarget)}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                if (documentBarsOf(editor).media.request?.origin === 'keyboard') panel.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const state = documentBarsOf(editor).media;
                const epoch = event.target === null ? undefined : closeEpochs.current.get(event.target);
                if (state.intent?.host === host && state.intent.epoch === epoch && captionField.current?.isConnected) {
                  captionField.current.focus(); mediaEvent(editor, { type: 'complete-caption', host, epoch: state.intent.epoch });
                } else if (state.close?.host === host && state.close.reason === 'escape' && state.close.epoch === epoch) trigger.current?.focus({ preventScroll: true });
              }}
              onEscapeKeyDown={(event) => {
                event.preventDefault(); mediaEvent(editor, { type: 'escape', host });
                if (panel.current !== null) closeEpochs.current.set(panel.current, documentBarsOf(editor).media.epoch);
              }}
              onInteractOutside={(event) => {
                const target = event.detail.originalEvent.target;
                if (target instanceof Node && host.contains(target)) event.preventDefault();
                else mediaEvent(editor, { type: 'outside', host });
              }}
            >
              {!readOnly && <div ref={setFloatingActions} data-media-chrome='' />}
              <div ref={setFloatingTransport} className='@container' />
            </PopoverContent>
          </Popover>
        ) : mediaFrame}
        <MediaControlsPortal destination={floating && panelShown && !readOnly ? floatingActions : inlineActions} migrating={migratingActions} preserveFocus={bars.media.activity?.host === host}>{toolbar}</MediaControlsPortal>
        {editingCaption ? (
          <input
            data-media-chrome={readOnly ? undefined : ''}
            ref={captionField}
            data-testid='doc-media-caption-input'
            autoComplete='off'
            value={draft?.value ?? props.caption}
            readOnly={readOnly || draft?.phase === 'suspended'}
            onChange={(event) => drafts.event(blockId, { type: 'input', session: captionSession.current, value: event.currentTarget.value })}
            onCompositionStart={(event) => drafts.event(blockId, { type: 'composition-start', session: captionSession.current, value: event.currentTarget.value })}
            onCompositionUpdate={(event) => drafts.event(blockId, { type: 'input', session: captionSession.current, value: event.currentTarget.value })}
            placeholder={t('spaces.document.media.captionPlaceholder')}
            className='nodrag mt-1.5 w-full border-0 border-b border-border bg-transparent py-0.5 text-center text-sm text-foreground outline-none'
            onCompositionEnd={(event) => { captionComposition.mark(); drafts.event(blockId, { type: 'composition-end', session: captionSession.current, value: event.currentTarget.value }); }}
            onKeyDown={(event) => {
              if (keyBelongsToInputMethod(event.nativeEvent, captionComposition)) return;
              if (event.key !== 'Enter' && event.key !== 'Escape') return;
              event.preventDefault(); event.stopPropagation();
              closedOnKey.current = true;
              const { value } = event.currentTarget;
              // The keyboard goes back to the body while the field still holds
              // it: a focused field leaving the page reads as the reader
              // leaving the body, which lets go of the block.
              actions.focusBody();
              if (event.key === 'Enter') commitCaption(value);
              else drafts.event(blockId, { type: 'cancel', session: captionSession.current, caption: props.caption });
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
        {editingCaption && readOnly && <p className='text-xs text-muted-foreground'>{t('spaces.document.media.captionReadOnly')}</p>}
      </div>
      {type === 'image' && (
        <Dialog open={fullscreen} onOpenChange={setFullscreen}>
          <DialogContent
            id={fullscreenId}
            aria-describedby={undefined}
            // The keyboard goes back where it was when the picture opened.
            // Back in the body it goes through the editor, which writes the
            // kept selection to the page as the body takes the focus.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const opener = fullscreenOpener.current;
              fullscreenOpener.current = null;
              if (opener === 'body') actions.focusBody();
              else if (opener?.isConnected === true) opener.focus();
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
