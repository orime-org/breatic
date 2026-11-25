// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What an upload placeholder shows (inner#1709 design §4.5, §7.3), decided in the Document's `pendingStatus` order:
 * what collab wrote onto the placeholder (`upload.state`, `failure`, `retryable`) first, then this page's record
 * (uploading, handed off, failed here), then other pages' claims, else unfinished. The two waiting states are gone:
 * collab writes the result whatever this page's write access or the Space's size. Failure text comes from the one
 * table the Document and the Timeline share in `data/upload/`, with this page's own reasons mapped first.
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t, type TimelineClip } from '@breatic/shared';

import type { TimelineUploadEntry, TimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { timelineUploadText, timelineUploadView, useTimelineUploadViews } from '@web/spaces/timeline/use-timeline-upload-views';
import { FAILURE_MESSAGE, FILE_FAILURE_REASON } from '@web/data/upload/upload-failure-text';

const UPLOAD_ID = 'b0000000-0000-4000-8000-000000000001';

/**
 * A placeholder record with what collab wrote onto it.
 * @param written - `state`, `failure` and `retryable`, as collab writes them.
 * @returns The clip.
 * @throws {never} Never.
 */
function placeholder(written: Record<string, unknown> = {}): TimelineClip {
  return { id: 'clip-1', kind: 'upload', upload: { uploadId: UPLOAD_ID, name: 'a.mp3', kind: 'audio', durationSeconds: 2, ...written } } as unknown as TimelineClip;
}

/**
 * A controller whose one upload the test moves between states.
 * @param initial - The state it starts in, or none when this page did not run it.
 * @returns The controller and a setter that notifies its listeners.
 */
function controller(initial: TimelineUploadEntry | undefined): { uploads: TimelineUploads; set: (next: TimelineUploadEntry | undefined) => void } {
  let state = initial;
  const listeners = new Set<() => void>();
  const uploads = {
    entry: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => undefined,
    retry: () => undefined,
    dispose: () => undefined,
  } as unknown as TimelineUploads;
  return { uploads, set: (next) => { state = next; listeners.forEach((listener) => listener()); } };
}

afterEach(() => { setLocale('en'); });

describe('useTimelineUploadViews', () => {
  it('shows a failure that happened while the Timeline was hidden once it is shown again', () => {
    const { uploads, set } = controller({ phase: 'uploading', progress: 0.4 });
    const clips = [placeholder()];
    /**
     * The state and retry of the one placeholder.
     * @returns Its text.
     */
    function View(): React.JSX.Element {
      const view = useTimelineUploadViews('timeline-doc', uploads, clips).get('clip-1');
      return <span data-testid='view'>{`${view?.state}:${String(view?.retryable)}`}</span>;
    }
    const screen = render(<React.Activity mode='visible'><View /></React.Activity>);
    expect(screen.getByTestId('view').textContent).toBe('uploading:false');
    screen.rerender(<React.Activity mode='hidden'><View /></React.Activity>);
    act(() => set({ phase: 'failed', reason: 'transfer', retryable: true }));
    screen.rerender(<React.Activity mode='visible'><View /></React.Activity>);
    expect(screen.getByTestId('view').textContent).toBe('failed:true');
  });

  it('follows changes while shown', () => {
    const { uploads, set } = controller({ phase: 'uploading', progress: null });
    const clips = [placeholder()];
    /**
     * The progress of the one placeholder.
     * @returns Its text.
     */
    function View(): React.JSX.Element {
      const view = useTimelineUploadViews('timeline-doc', uploads, clips).get('clip-1');
      return <span data-testid='view'>{`${view?.state}:${String(view?.progress)}`}</span>;
    }
    const screen = render(<View />);
    act(() => set({ phase: 'uploading', progress: 0.5 }));
    expect(screen.getByTestId('view').textContent).toBe('uploading:0.5');
  });

  it.each([
    ['processing', { state: 'processing' }, 'processing:null'],
    ['a server failure', { state: 'failed', failure: 'storageFull', retryable: false }, 'failed:storageFull'],
  ] as const)('shows what collab wrote onto the placeholder, %s, on a page that did not run the upload', (_case, written, expected) => {
    const { uploads } = controller(undefined);
    const clips = [placeholder(written)];
    /**
     * The state and reason of the one placeholder.
     * @returns Its text.
     */
    function View(): React.JSX.Element {
      const view = useTimelineUploadViews('timeline-doc', uploads, clips).get('clip-1');
      return <span data-testid='view'>{`${view?.state}:${String(view?.reason)}`}</span>;
    }
    const screen = render(<View />);
    expect(screen.getByTestId('view').textContent).toBe(expected);
  });
});

describe('timelineUploadView (design §4.5 display table)', () => {
  const none = { progress: null, reason: null, retryable: false };
  it.each([
    ['1: collab wrote a failure; this page holds the file and may retry', { phase: 'handedOff' }, null, { state: 'failed', failure: 'failed', retryable: true },
      { state: 'failed', progress: null, reason: 'failed', retryable: true }],
    ['1: collab wrote a failure that cannot be retried', { phase: 'handedOff' }, null, { state: 'failed', failure: 'unsupportedType', retryable: false },
      { state: 'failed', progress: null, reason: 'unsupportedType', retryable: false }],
    ['1: collab wrote a failure; another page', undefined, null, { state: 'failed', failure: 'storageFull', retryable: true },
      { state: 'failed', progress: null, reason: 'storageFull', retryable: false }],
    ['1: collab wrote a failure over this page\'s running record', { phase: 'uploading', progress: 0.3 }, 'uploading', { state: 'failed', failure: 'tooLarge', retryable: false },
      { state: 'failed', progress: null, reason: 'tooLarge', retryable: false }],
    ['2: collab wrote processing', { phase: 'uploading', progress: 0.9 }, 'uploading', { state: 'processing' }, { state: 'processing', ...none }],
    ['2: collab wrote processing; another page', undefined, null, { state: 'processing' }, { state: 'processing', ...none }],
    ['3: this page uploads', { phase: 'uploading', progress: 0.42 }, null, {}, { state: 'uploading', progress: 0.42, reason: null, retryable: false }],
    ['4: this page handed the bytes off', { phase: 'handedOff' }, null, {}, { state: 'processing', ...none }],
    ['5: this page failed to send the bytes', { phase: 'failed', reason: 'transfer', retryable: true }, 'failed', {},
      { state: 'failed', progress: null, reason: 'failed', retryable: true }],
    ['5: this page failed, its reason mapped to the shared one', { phase: 'failed', reason: 'storage', retryable: false }, 'failed', {},
      { state: 'failed', progress: null, reason: 'storageFull', retryable: false }],
    ['6: another page claims it uploading', undefined, 'uploading', {}, { state: 'uploading', ...none }],
    ['7: another page claims it failed', undefined, 'failed', {}, { state: 'failed', ...none }],
    ['8: nobody claims it', undefined, null, {}, { state: 'unfinished', ...none }],
  ] as const)('row %s', (_case, entry, claim, written, expected) => {
    const upload = (placeholder(written) as unknown as { upload: Record<string, unknown> }).upload;
    expect(timelineUploadView({ entry, claim, upload } as unknown as Parameters<typeof timelineUploadView>[0])).toEqual(expected);
  });
});

describe('timelineUploadText', () => {
  it.each(Object.keys(FAILURE_MESSAGE))('says the shared Document text for the failure reason %s', (reason) => {
    const text = timelineUploadText(t, { state: 'failed', progress: null, reason, retryable: false } as unknown as Parameters<typeof timelineUploadText>[1], 'beach.mp3');
    expect(text).toBe(t(FAILURE_MESSAGE[reason as keyof typeof FAILURE_MESSAGE]));
  });

  it('says the format is not supported in the shared words, without the old video-only sentence', () => {
    setLocale('zh-CN');
    const text = timelineUploadText(t, { state: 'failed', progress: null, reason: 'unsupportedType', retryable: false } as unknown as Parameters<typeof timelineUploadText>[1], 'beach.mp3');
    expect(text).toBe('格式不支持');
    expect(text).not.toContain('视频');
  });

  it('says processing in zh-CN as the design names it', () => {
    setLocale('zh-CN');
    expect(timelineUploadText(t, { state: 'processing', progress: null, reason: null, retryable: false } as unknown as Parameters<typeof timelineUploadText>[1], 'a.mp3')).toBe('处理中');
  });
});

describe('the shared failure tables (design §4.5)', () => {
  it('maps every way a file upload fails on this page to the reason the block and placeholder say', () => {
    expect(FILE_FAILURE_REASON).toEqual({
      storage: 'storageFull', hash: 'hashUnavailable', unsupportedType: 'unsupportedType', rateLimited: 'rateLimited',
      tooLarge: 'tooLarge', upload: 'failed', transfer: 'failed',
    });
  });

  it('names one Document message per failure reason', () => {
    expect(FAILURE_MESSAGE).toEqual({
      failed: 'spaces.document.media.uploadFailed',
      storageFull: 'spaces.document.media.failure.storageFull',
      rateLimited: 'spaces.document.media.failure.rateLimited',
      hashUnavailable: 'spaces.document.media.failure.hashUnavailable',
      unsupportedType: 'spaces.document.media.failure.unsupportedType',
      tooLarge: 'spaces.document.media.failure.tooLarge',
      empty: 'spaces.document.media.failure.empty',
      unreachable: 'spaces.document.media.failure.unreachable',
      spaceFull: 'spaces.sizeCap.reason',
    });
  });
});
