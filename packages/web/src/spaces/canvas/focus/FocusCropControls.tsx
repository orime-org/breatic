// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Slider } from '@web/components/ui/slider';
import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';
import { useTranslation } from '@web/i18n/use-translation';
import {
  CROP_PRESETS,
  isCropUsable,
  samePreset,
  shapeForPreset,
  toNaturalCrop,
  type CropPreset,
  type CropRect,
} from '@web/lib/crop-math';
import { toast } from '@web/lib/toast';
import { canvasRootOf, useCanvasContext, useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { fromFraction, toFraction } from '@web/spaces/canvas/crop/crop-geometry';
import { cropSourceSelector, intrinsicSize, isCropSource, originalSrc, type CropSourceEl } from '@web/spaces/canvas/focus/crop-source';
import { formatSeconds } from '@web/spaces/canvas/lib/duration';

/**
 * One step of the crop timeline: the duration of a frame at the worst frame
 * rate we expect to meet.
 *
 * This one number decides BOTH how finely a drag lands and how far one arrow
 * key moves (Radix runs the keyboard off the same `step`). Radix's default of
 * 1 would mean whole seconds — 30 frames at a stride; and a value far below a
 * frame would mean several key presses before the picture changes at all.
 */
const TIMELINE_STEP_S = 1 / 24;

/** Shown at both ends of the timeline while the duration is unknown. */
const UNKNOWN_TIME = '--:--';

/** The gap between the picked node and the bar, in screen pixels. */
const BAR_OFFSET = 8;

/**
 * Formats a position with sub-second precision (`m:ss.SS`).
 *
 * The whole point of this timeline is stopping on one frame, and `m:ss` alone
 * cannot tell 4.00s from 4.37s — the user would have no way to read back what
 * they picked. {@link formatSeconds} stays as it is: it answers a different
 * question (how far in / how long the media runs) at a different
 * granularity.
 * @param seconds - Position in seconds.
 * @returns The `m:ss.SS` string.
 */
function formatPreciseTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return `${formatSeconds(0)}.00`;
  const hundredths = Math.floor((seconds % 1) * 100);
  return `${formatSeconds(seconds)}.${String(hundredths).padStart(2, '0')}`;
}

/** What one confirmed marquee hands back to the canvas. */
export interface FocusCropConfirm {
  /** The crop in natural (source-resolution) pixels. */
  crop: CropRect;
  /** The source's intrinsic size (for reference / debugging). */
  natural: { width: number; height: number };
  /**
   * For a video source, the frame the element was parked on when the user
   * confirmed, in seconds; `null` for an image (#1987). Read off the element
   * itself rather than the timeline's display mirror — one source of truth.
   */
  sourceTimeSeconds: number | null;
  /**
   * The src the marquee was drawn + validated against (round-3): the export
   * MUST crop exactly this URL — the graph store can lead the DOM by a
   * commit, and exporting the store's newer content at this marquee's
   * coordinates would crop the wrong image.
   */
  sourceSrc: string;
}

interface FocusCropControlsProps {
  /**
   * Confirm the current marquee (upload runs in the canvas layer). Returns
   * whether the confirm was ACCEPTED — a gate rejection (pool full, source
   * gone) returns false and the marquee is kept, so the user's careful
   * selection survives a fixable rejection (round-3).
   */
  onConfirm: (result: FocusCropConfirm) => boolean;
  /**
   * Return to the PICK state (clear the crop target, keep the session —
   * the banner stays and another node can be picked). Cancel and the
   * no-marquee Esc both land here (user 2026-07-17, decision A: leaving
   * one node's crop must not tear down the whole continuous session).
   */
  onBackToPick: () => void;
}

/**
 * Hands keyboard focus to the pick banner when the crop bar is about to go
 * away (adversarial 2026-07-17): the bar disappears with focus inside it, and
 * without a hand-off document.activeElement falls to `<body>` — the next Tab
 * restarts from the top of the page. The banner is the surviving surface of
 * the pick state. Only focus that would otherwise be ORPHANED is rescued
 * (inside the bar, or already on `<body>`) — never stolen from a live surface
 * outside it, like the prompt editor (adversarial round-2). Exported for the
 * canvas layer's third path (crop target deleted by a collaborator mid-crop).
 * @param barRoot - The bar's root element (containment check), or null when
 *   it cannot be resolved — then only `<body>` focus is rescued.
 * @param canvasRoot - Where this canvas's banner is looked for
 *   (`canvasRootOf`); another Space's kept canvas can hold a banner too.
 */
export function handOffFocusToPickBanner(barRoot: Element | null, canvasRoot: ParentNode): void {
  const active = document.activeElement;
  if (active && active !== document.body && !(barRoot?.contains(active) ?? false)) {
    return;
  }
  canvasRoot.querySelector<HTMLElement>('[data-testid="reference-pick-banner"]')?.focus();
}

/**
 * The focus crop's controls (#1782, inner#888 §7.4.1): the ratio row, the
 * video timeline and Cancel / Confirm under the picked node, and the keys.
 * The marquee itself is drawn inside the node by the node's crop box; both
 * read and write the one focus crop in the session store. The bar shows
 * while the target is on screen; the keys answer for as long as there is a
 * target, so Esc still peels back to picking when it has scrolled away.
 * @param root0 - Component props.
 * @param root0.onConfirm - Receives the confirmed natural-pixel crop.
 * @param root0.onBackToPick - Returns to the pick state (Cancel / bare Esc).
 * @returns The bar, or null when no node is being cropped.
 */
export function FocusCropControls({ onConfirm, onBackToPick }: FocusCropControlsProps): React.JSX.Element | null {
  const { spaceId } = useCanvasContext();
  const t = useTranslation();
  const store = useCanvasSessionStore();
  const focus = useCanvasSession((s) => s.focusCrop);
  const barRef = React.useRef<HTMLDivElement>(null);

  const nodeId = focus?.nodeId ?? null;
  const frame = focus?.frame ?? null;

  // The node's media, looked up each time its crop box reports: a remount
  // hands the box a new element and the box writes a new frame for it.
  const sourceEl = React.useMemo((): CropSourceEl | null => {
    if (nodeId === null || frame === null) return null;
    const el = canvasRootOf(spaceId).querySelector(cropSourceSelector(nodeId));
    return isCropSource(el) ? el : null;
  }, [frame, nodeId, spaceId]);

  // The timeline's own value: WHERE THE USER PUT THE HANDLE, seeded from the
  // element when the bar attaches to it. Confirm reads the element, not this.
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(Number.NaN);

  // Park the video and read it, keyed on the element so a remount cannot leave
  // any of the three behind. Seeding is not optional: the element fired
  // `loadedmetadata` long before the user picked it. `seeked` is deliberately
  // NOT subscribed: a media element rounds a written position to its own time
  // base, and feeding that back into the Slider knocks it off the step grid
  // so no arrow key moves it again (measured in the browser).
  React.useEffect(() => {
    if (!(sourceEl instanceof HTMLVideoElement)) return;
    const video = sourceEl;
    // Picking a playing video parks it where it was (user 2026-08-20).
    if (!video.paused) video.pause();
    /** Seed both mirrors from the element. */
    const seed = (): void => {
      setCurrentTime(video.currentTime);
      setDuration(video.duration);
    };
    seed();
    video.addEventListener('loadedmetadata', seed);
    video.addEventListener('durationchange', seed);
    return () => {
      video.removeEventListener('loadedmetadata', seed);
      video.removeEventListener('durationchange', seed);
    };
  }, [sourceEl]);

  /**
   * Move the video to a dragged position: write the element, mirror locally.
   * The REQUESTED position is kept, on the step grid, for the keyboard.
   * @param next - The requested position in seconds.
   */
  const onTimelineChange = React.useCallback(
    ([next]: number[]): void => {
      if (next === undefined || !(sourceEl instanceof HTMLVideoElement)) return;
      sourceEl.currentTime = next;
      setCurrentTime(next);
    },
    [sourceEl],
  );

  /** Drop the marquee and the ratio item holding it — one write, both go. */
  const clearMarquee = React.useCallback((): void => {
    store.getState().setFocusMarquee(null, null);
  }, [store]);

  /**
   * Ends the crop state and returns to the PICK state — the single exit that
   * cancel, Esc stage-two, and an accepted confirm share (user 2026-07-17 A +
   * 2026-07-20): clear the marquee (which also ends any gesture still held on
   * it), hand focus off to the pick banner, leave the crop state.
   */
  const backToPick = React.useCallback((): void => {
    clearMarquee();
    handOffFocusToPickBanner(barRef.current, canvasRootOf(spaceId));
    onBackToPick();
  }, [clearMarquee, onBackToPick, spaceId]);

  // Esc: clear the marquee first; with nothing drawn, or the target off
  // screen, back to picking. On the window, bubble phase: after a drag the
  // focus is on the node, outside this bar, and a capture listener would
  // steal Esc from every popover.
  const active = focus !== null;
  React.useEffect(() => {
    if (!active) return;
    /**
     * Keydown listener implementing the two-stage Esc behavior.
     * @param e - The keyboard event.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      // A consumer that preventDefaulted owns the press; an IME
      // composition-cancel Escape never reaches the crop (round-11).
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229) {
        return;
      }
      if (!regionOwnsKeyboard(document.activeElement, 'space')) return;
      const current = store.getState().focusCrop;
      if (current === null) return;
      // Stage one only while the marquee is on screen (round-9): with the
      // target scrolled away, Esc would silently eat a selection the reader
      // cannot see.
      if (current.frame !== null && current.rect !== null) clearMarquee();
      else backToPick();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, backToPick, clearMarquee, store]);

  if (focus === null || frame === null) return null;

  const box = { width: frame.width, height: frame.height };
  const rect = focus.rect === null ? null : fromFraction(focus.rect, box);
  const preset = focus.preset;
  const isVideoSource = sourceEl instanceof HTMLVideoElement;
  const hasDuration = Number.isFinite(duration) && duration > 0;

  /**
   * The row, each item carrying what it would draw if clicked right now.
   * `null` means the item is unavailable and its button is disabled; a click
   * on a lit item unlights it instead (user 2026-08-22).
   */
  const row = CROP_PRESETS.map((entry) => ({
    ...entry,
    shape: shapeForPreset(entry.preset, rect, box, frame.natural),
  }));

  /**
   * Apply (or unlight, when re-clicked) a preset from the row.
   * @param next - The row item that was clicked.
   * @param shaped - The marquee it draws, from {@link row}.
   */
  const onPresetClick = (next: CropPreset, shaped: CropRect): void => {
    const state = store.getState();
    if (samePreset(preset, next)) {
      state.setFocusMarquee(focus.rect, null);
      return;
    }
    state.setFocusMarquee(toFraction(shaped, box), next);
  };

  /** Confirm the current marquee: map to natural pixels and hand off. */
  const onConfirmClick = (): void => {
    if (rect === null || !isCropUsable(rect, box, frame.natural)) return;
    const el = canvasRootOf(spaceId).querySelector(cropSourceSelector(focus.nodeId));
    // The content may have changed between the last layout and this click:
    // never crop new content at the old marquee's coordinates (round-2).
    if (isCropSource(el) && originalSrc(el) !== focus.content) {
      clearMarquee();
      toast.warning(t('canvas.generatePanel.focusSourceChanged'));
      return;
    }
    if (!isCropSource(el) || intrinsicSize(el).width === 0) {
      // Not decodable yet (a bitmap still loading, a broken URL, a video whose
      // metadata has not arrived — the opening state of every video): say so,
      // and keep the marquee so a retry confirms the same selection (A7a).
      toast.error(t('canvas.generatePanel.focusExportFailed'));
      return;
    }
    const natural = intrinsicSize(el);
    const accepted = onConfirm({
      crop: toNaturalCrop(rect, box, natural),
      natural,
      sourceSrc: focus.content,
      // Off the element, not the display mirror (#1987).
      sourceTimeSeconds: el instanceof HTMLVideoElement ? el.currentTime : null,
    });
    // A gate rejection keeps the marquee (round-3); an accepted one ends the
    // crop state like Cancel (user 2026-07-20).
    if (accepted) backToPick();
  };

  const confirmDisabled = rect === null || !isCropUsable(rect, box, frame.natural);

  return (
    <NodeToolbar nodeId={focus.nodeId} isVisible position={Position.Bottom} offset={BAR_OFFSET}>
      <div
        ref={barRef}
        data-testid='focus-crop-controls'
        // rounded-overlay = the 6px chrome radius (user 2026-07-17 #3). Width
        // follows the content (user 2026-08-21): w-max is the intrinsic width,
        // so the bar neither leaves empty space in short locales nor squeezes
        // its no-wrap items.
        className='nodrag nopan flex w-max flex-col gap-1.5 rounded-overlay border border-border bg-card px-2 py-1.5 text-xs text-foreground shadow-md'
      >
        {isVideoSource ? (
          <div data-testid='focus-crop-timeline' className='flex items-center gap-2'>
            <span data-testid='focus-crop-time-current' className='shrink-0 tabular-nums text-muted-foreground'>
              {hasDuration ? formatPreciseTime(currentTime) : UNKNOWN_TIME}
            </span>
            {hasDuration ? (
              <Slider
                aria-label={t('canvas.generatePanel.focusTimelineLabel')}
                min={0}
                max={duration}
                step={TIMELINE_STEP_S}
                value={[currentTime]}
                onValueChange={onTimelineChange}
                className='min-w-0 flex-1'
              />
            ) : (
              // No Slider at all: the shared component renders its thumb
              // unconditionally, and a handle on a track that cannot be
              // dragged is a lie about what the user can do (user 2026-08-20).
              <div
                data-testid='focus-crop-timeline-placeholder'
                aria-hidden='true'
                className='h-1.5 min-w-0 flex-1 rounded-full bg-muted opacity-50'
              />
            )}
            <span data-testid='focus-crop-time-duration' className='shrink-0 tabular-nums text-muted-foreground'>
              {hasDuration ? formatSeconds(duration) : UNKNOWN_TIME}
            </span>
          </div>
        ) : null}
        <div className='flex items-center gap-1'>
          {row.map(({ key, label, preset: item, shape }) => (
            <Button
              key={key}
              type='button'
              variant={null}
              size={null}
              data-testid={`focus-ratio-${key}`}
              aria-pressed={samePreset(preset, item)}
              disabled={shape === null}
              onClick={() => {
                if (shape) onPresetClick(item, shape);
              }}
              // whitespace-nowrap + shrink-0 (user 2026-07-17 #1): without
              // them the CJK labels wrapped one character per line.
              className={
                'shrink-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 transition-colors ' +
                (item.kind === 'ratio' ? 'tabular-nums ' : '') +
                (samePreset(preset, item) ? 'bg-foreground text-background' : 'text-muted-foreground ') +
                // `Button` keeps hover on a disabled item, so only live items get it.
                (shape !== null && !samePreset(preset, item) ? 'hover:bg-accent hover:text-accent-foreground' : '')
              }
            >
              {label}
            </Button>
          ))}
          <span aria-hidden='true' className='mx-1 h-4 w-px bg-border' />
          <Button
            type='button'
            variant={null}
            size={null}
            data-testid='focus-crop-cancel'
            onClick={backToPick}
            className='shrink-0 whitespace-nowrap rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
          >
            {t('canvas.generatePanel.focusCancel')}
          </Button>
          <Button
            type='button'
            variant={null}
            size={null}
            data-testid='focus-crop-confirm'
            onClick={onConfirmClick}
            disabled={confirmDisabled}
            className='shrink-0 whitespace-nowrap rounded-sm bg-foreground px-2 py-0.5 text-background disabled:cursor-not-allowed disabled:opacity-50'
          >
            {t('canvas.generatePanel.focusConfirm')}
          </Button>
        </div>
      </div>
    </NodeToolbar>
  );
}
