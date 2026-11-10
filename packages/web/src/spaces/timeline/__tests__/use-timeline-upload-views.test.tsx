// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What an upload placeholder shows follows the current facts whenever the Timeline body is shown, including changes
 * that happened while a hidden Space tab had its subscriptions removed (#1434 design §4.1).
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t, type TimelineClip } from '@breatic/shared';

import type { TimelineUploadEntry, TimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { timelineUploadText, timelineUploadView, useTimelineUploadViews } from '@web/spaces/timeline/use-timeline-upload-views';

const CLIPS = [{ id: 'clip-1', kind: 'upload', upload: { uploadId: 'upload-1', name: 'a.mp4', durationSeconds: 2 } } as unknown as TimelineClip];

/**
 * A controller whose one upload the test moves between states.
 * @param initial - The state it starts in.
 * @returns The controller and a setter that notifies its listeners.
 */
function controller(initial: TimelineUploadEntry): { uploads: TimelineUploads; set: (next: TimelineUploadEntry) => void } {
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

describe('useTimelineUploadViews', () => {
  it('shows a failure that happened while the Timeline was hidden once it is shown again', () => {
    const { uploads, set } = controller({ phase: 'uploading', progress: 0.4 });
    /**
     * The state and retry of the one placeholder.
     * @returns Its text.
     */
    function View(): React.JSX.Element {
      const view = useTimelineUploadViews('timeline-doc', uploads, CLIPS).get('clip-1');
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
    /**
     * The progress of the one placeholder.
     * @returns Its text.
     */
    function View(): React.JSX.Element {
      const view = useTimelineUploadViews('timeline-doc', uploads, CLIPS).get('clip-1');
      return <span data-testid='view'>{`${view?.state}:${String(view?.progress)}`}</span>;
    }
    const screen = render(<View />);
    act(() => set({ phase: 'uploading', progress: 0.5 }));
    expect(screen.getByTestId('view').textContent).toBe('uploading:0.5');
  });
});

describe('timelineUploadText', () => {
  it.each(['tooLarge', 'unsupportedType'] as const)('names the file when its upload failed as %s', (reason) => {
    const text = timelineUploadText(t, { state: 'failed', progress: null, reason, retryable: false }, 'beach.mp4');
    expect(text).toContain('beach.mp4');
    expect(text).not.toContain('{');
  });
});

describe('timelineUploadView (design §4.1 display table)', () => {
  const asset = { assetId: 'asset-1' } as never;
  it.each([
    ['the uploader while it runs', { phase: 'uploading', progress: 0.42 }, 'granted', null, { state: 'uploading', progress: 0.42, reason: null, retryable: false }],
    ['the uploader after a failure', { phase: 'failed', reason: 'transfer', retryable: true }, 'granted', 'uploading', { state: 'failed', progress: null, reason: 'transfer', retryable: true }],
    ['the uploader once uploaded without edit access', { phase: 'done', asset }, 'denied', null, { state: 'waiting', progress: null, reason: null, retryable: false }],
    ['the uploader once uploaded with edit access, until it is written', { phase: 'done', asset }, 'granted', null, { state: 'uploading', progress: null, reason: null, retryable: false }],
    ['a collaborator while another page uploads', undefined, 'granted', 'uploading', { state: 'uploading', progress: null, reason: null, retryable: false }],
    ['a collaborator after the uploader failed', undefined, 'granted', 'failed', { state: 'failed', progress: null, reason: null, retryable: false }],
    ['anyone once nobody claims it', undefined, 'granted', null, { state: 'unfinished', progress: null, reason: null, retryable: false }],
  ] as const)('shows %s', (_case, entry, access, claim, expected) => {
    expect(timelineUploadView(entry, access, claim)).toEqual(expected);
  });
});
