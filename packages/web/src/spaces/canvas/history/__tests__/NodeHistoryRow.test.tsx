// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  render,
  screen,
  act,
  cleanup,
  fireEvent,
  within,
} from '@testing-library/react';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import {
  NodeHistoryRow,
  type HistoryModality,
} from '@web/spaces/canvas/history/NodeHistoryRow';
import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';

// t(key) → key, so assertions target the i18n key the chip renders.
vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

// The audio/video preview mounts a real <audio>/<video>; jsdom lacks play/pause.
// Same polyfill the HoverPreview / MediaPlayer suites use.
beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Opens a row's HoverPreview by hovering its 46px thumbnail trigger and
 * advancing past the open delay (fake timers cross Radix's grace
 * synchronously). The card content is portaled to `document.body`.
 * @param trigger - The thumbnail trigger element to hover.
 * @returns Nothing; the card content is mounted after it resolves.
 */
function openPreview(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10);
  });
}

/**
 * Builds a history-entry fixture. Defaults to a FAILED generation — failed rows
 * have no previewable media (`previewFor` returns null), so no HoverPreview
 * card is mounted and the row renders standalone.
 * @param over - Field overrides merged onto the failed-generation default.
 * @returns A {@link NodeHistoryEntry}.
 */
function entry(over: Partial<NodeHistoryEntry> = {}): NodeHistoryEntry {
  return {
    id: 'h1',
    operatorName: null,
    entryType: 'generation',
    status: 'failed',
    content: null,
    thumbnailUrl: null,
    errorMessage: 'boom',
    metadata: {},
    createdAt: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

/**
 * Renders a row with the given entry.
 * @param e - The history entry to render.
 * @param modality - The host node modality (defaults to image).
 * @returns Nothing.
 */
function renderRow(
  e: NodeHistoryEntry,
  modality: HistoryModality = 'image',
): void {
  render(
    <NodeHistoryRow
      entry={e}
      modality={modality}
      isCurrent={false}
      onRestore={() => {}}
    />,
  );
}

describe('NodeHistoryRow (#1619)', () => {
  // #1 (user 2026-07-22): the type chip states ONLY the type (Generated /
  // Upload), never the outcome. Before the fix a FAILED row's chip rendered
  // `canvas.history.failed` ("Can't restore") and the type key was absent —
  // mislabelling the entry and duplicating the right-slot action.
  it('failed generation row: the type chip states the TYPE, not the failure', () => {
    renderRow(entry({ entryType: 'generation', status: 'failed' }));
    expect(screen.getByText('canvas.history.typeGeneration')).toBeTruthy();
  });

  it('upload row: the type chip states Upload', () => {
    renderRow(entry({ entryType: 'upload', status: 'failed' }));
    expect(screen.getByText('canvas.history.typeUpload')).toBeTruthy();
  });

  // Who-operated (#1619): the operator's joined display name shows next to the
  // time when resolved, and the row falls back to time alone when it is null.
  it('shows the operator name AND its separator next to the time when resolved', () => {
    renderRow(entry({ operatorName: 'Justin' }));
    expect(screen.getByText('Justin')).toBeTruthy();
    // The "·" separator renders WITH the name — both gated on operatorName.
    expect(screen.queryByText('·')).not.toBeNull();
  });

  it('shows only the time — no name, no orphan separator — when unresolved (null)', () => {
    renderRow(entry({ operatorName: null }));
    expect(screen.queryByText('Justin')).toBeNull();
    // A null operator falls back to the time ALONE: the "·" separator must not
    // render on its own. Guards against an unconditional separator leaving a
    // dangling "·" on every unresolved row (Gate-2 caught the vacuous version).
    expect(screen.queryByText('·')).toBeNull();
  });
});

// #1814: the row's hover preview is the unified `HoverPreview` (HoverCard) — an
// image row pops a static big image, while audio / video rows now pop a
// PLAYABLE preview (MediaPlayer) sourced from the result asset (previously the
// image-only preview meant audio had none). The trigger is the 46px thumbnail
// (the row's first grid cell); a row with no previewable media (failed, or a
// success with no content URL) is not wrapped and pops no card.
describe('NodeHistoryRow — unified hover preview (#1814)', () => {
  /**
   * The row's 46px thumbnail trigger (its first grid cell). When the row has a
   * preview it is the HoverCard trigger (carries `data-state`); otherwise it is
   * the bare thumbnail.
   * @returns The trigger element.
   */
  function thumbTrigger(): HTMLElement {
    return screen.getByTestId('node-history-row')
      .firstElementChild as HTMLElement;
  }

  it('image row → static <img> preview, no MediaPlayer', () => {
    vi.useFakeTimers();
    renderRow(
      entry({
        status: 'success',
        content: '/pic.png',
        thumbnailUrl: '/thumb.png',
      }),
      'image',
    );
    openPreview(thumbTrigger());
    const card = screen.getByTestId('hover-preview-content');
    // The preview <img> has an empty alt (decorative), so it has the
    // `presentation` role, not `img` — query it structurally.
    const img = card.querySelector('img') as HTMLImageElement;
    // Preview src is thumbnailUrl ?? content (unchanged from the old thumbSrc).
    expect(img.getAttribute('src')).toBe('/thumb.png');
    expect(within(card).queryByTestId('media-element')).not.toBeInTheDocument();
  });

  it('video row → PLAYABLE MediaPlayer <video> from content, poster = thumbnailUrl', () => {
    vi.useFakeTimers();
    renderRow(
      entry({
        status: 'success',
        content: '/clip.mp4',
        thumbnailUrl: '/cover.jpg',
      }),
      'video',
    );
    openPreview(thumbTrigger());
    const card = screen.getByTestId('hover-preview-content');
    const media = within(card).getByTestId('media-element') as HTMLVideoElement;
    expect(media.tagName).toBe('VIDEO');
    // The video URL (not the cover) feeds the playable element; the cover is
    // its poster.
    expect(media.getAttribute('src')).toBe('/clip.mp4');
  });

  it('audio row → PLAYABLE MediaPlayer <audio> (previously had NO preview)', () => {
    vi.useFakeTimers();
    renderRow(
      entry({ status: 'success', content: '/song.mp3', thumbnailUrl: null }),
      'audio',
    );
    openPreview(thumbTrigger());
    const card = screen.getByTestId('hover-preview-content');
    const media = within(card).getByTestId('media-element') as HTMLAudioElement;
    expect(media.tagName).toBe('AUDIO');
    expect(media.getAttribute('src')).toBe('/song.mp3');
  });

  it('failed row → no preview card (trigger passes through unwrapped)', () => {
    vi.useFakeTimers();
    renderRow(entry({ status: 'failed', content: null }), 'image');
    openPreview(thumbTrigger());
    expect(
      screen.queryByTestId('hover-preview-content'),
    ).not.toBeInTheDocument();
  });

  it('success row with no content URL → no preview card', () => {
    vi.useFakeTimers();
    renderRow(
      entry({ status: 'success', content: null, thumbnailUrl: null }),
      'audio',
    );
    openPreview(thumbTrigger());
    expect(
      screen.queryByTestId('hover-preview-content'),
    ).not.toBeInTheDocument();
  });
});
