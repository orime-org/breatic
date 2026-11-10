// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What an upload placeholder shows follows the current facts whenever the Timeline body is shown, including changes
 * that happened while a hidden Space tab had its subscriptions removed (#1434 design §4.1).
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TimelineClip } from '@breatic/shared';

import type { TimelineUploadEntry, TimelineUploads } from '@web/spaces/timeline/timeline-uploads';
import { useTimelineUploadViews } from '@web/spaces/timeline/use-timeline-upload-views';

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
