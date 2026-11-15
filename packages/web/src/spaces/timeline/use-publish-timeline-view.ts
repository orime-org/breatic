// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { FOLLOW_FIELDS, type FollowFieldValue } from '@web/data/yjs/follow-presence';
import { PRESENCE_WRITE_INTERVAL_MS, createPublishThrottle, type PublishThrottle } from '@web/lib/publish-throttle';
import type { TimelinePlaybackAnchor } from '@web/spaces/timeline/use-timeline-playback';

/** What one render of the Timeline tells its followers. */
export interface PublishTimelineViewInput {
  /** The Timeline Space's awareness, or null while it has no connection. */
  awareness: Awareness | null;
  /** The track `ScrollArea` viewport, or null before it mounts. */
  viewport: HTMLElement | null;
  pixelsPerFrame: number;
  /** The width of the sticky track headers covering the lanes' left edge. */
  headerPx: number;
  /** The playhead frame. */
  frame: number;
  intent: 'play' | 'pause';
  anchor: TimelinePlaybackAnchor | null;
}

const FIELD = FOLLOW_FIELDS.timelineView;

/**
 * Publish this Timeline's view as `timelineView` for a follower (#920): the
 * visible frame range, the track scroll, the playhead and the playback state.
 * Writes go through the presence throttle; unmounting, which also happens when
 * the Space body is hidden, withdraws the field at once.
 * @param input - The awareness, track viewport, zoom, playhead and playback state.
 * @throws {never} Never.
 */
export function usePublishTimelineView(input: PublishTimelineViewInput): void {
  const latest = React.useRef(input);
  latest.current = input;
  const throttle = React.useRef<PublishThrottle | null>(null);
  const { awareness, viewport, pixelsPerFrame, headerPx, frame, intent, anchor } = input;

  React.useEffect(() => {
    if (awareness === null || viewport === null) return undefined;
    let published = '';
    /**
     * Write the current view unless it equals the one already out.
     * @throws {never} Never.
     */
    const publish = (): void => {
      const state = awareness.getLocalState();
      if (state === null) return;
      const { pixelsPerFrame: ppf, headerPx: header, frame: playhead, intent: playIntent, anchor: started } = latest.current;
      const startFrame = Math.floor(viewport.scrollLeft / ppf);
      // A viewport without width (not laid out) still publishes a range the schema accepts.
      const endFrame = Math.max(startFrame + 1, Math.ceil((viewport.scrollLeft + viewport.clientWidth - header) / ppf));
      const view = { startFrame, endFrame, trackScrollTop: viewport.scrollTop, frame: playhead, intent: playIntent, anchor: started };
      const key = JSON.stringify(view);
      if (key === published && state[FIELD] !== undefined) return;
      published = key;
      const value: FollowFieldValue<'timelineView'> = { ...view, at: Date.now() };
      awareness.setLocalState({ ...state, [FIELD]: value });
    };
    const pending = createPublishThrottle(publish, PRESENCE_WRITE_INTERVAL_MS);
    throttle.current = pending;
    pending.schedule();
    viewport.addEventListener('scroll', pending.schedule, { passive: true });
    return (): void => {
      viewport.removeEventListener('scroll', pending.schedule);
      pending.cancel();
      throttle.current = null;
      // A withdrawal must land, so it skips the frame-scheduled throttle.
      const state = awareness.getLocalState();
      if (state === null || !(FIELD in state)) return;
      const { [FIELD]: _withdrawn, ...rest } = state;
      awareness.setLocalState(rest);
    };
  }, [awareness, viewport]);

  React.useEffect(() => {
    throttle.current?.schedule();
  }, [pixelsPerFrame, headerPx, frame, intent, anchor]);
}
