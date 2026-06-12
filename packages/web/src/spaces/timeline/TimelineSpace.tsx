// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Film } from 'lucide-react';
import type * as React from 'react';

import type { SpaceBodyProps } from '@web/spaces';
import type { TimelineTrack } from '@web/spaces/timeline/types';

interface TimelineSpaceProps extends SpaceBodyProps {
  tracks?: ReadonlyArray<TimelineTrack>;
  pixelsPerMs?: number;
}

/**
 * Timeline space — placeholder for the M3+ rebuild. PR 13 ships a
 * structural surface (tracks rail + ruler + empty-state) so the rest of
 * the project can mount a TimelineSpace without `null` checks; the real
 * editor (canvas-native primitives, transport controls, scrubbing) lands
 * during the M3+ media polish PR.
 * @param root0 - Timeline space props (space body props plus track data).
 * @param root0.spaceId - ID of the timeline space, stamped on the root element for selectors.
 * @param root0.projectId - ID of the owning project, stamped on the root element for selectors.
 * @param root0.tracks - Timeline tracks to render; empty renders the empty-state surface.
 * @param root0.pixelsPerMs - Horizontal scale factor mapping clip milliseconds to pixels.
 * @returns The timeline surface element (empty state or tracks rail with clips).
 */
export function TimelineSpace({
  spaceId,
  projectId,
  tracks = [],
  pixelsPerMs = 0.04,
}: TimelineSpaceProps): React.JSX.Element {
  if (tracks.length === 0) {
    return (
      <div
        data-testid='timeline-space-empty'
        className='flex h-full w-full flex-col items-center justify-center gap-2 bg-muted text-sm text-muted-foreground'
      >
        <Film className='h-6 w-6 opacity-60' />
        <div>Timeline (M3+) · {projectId} / {spaceId}</div>
        <div className='text-xs opacity-70'>
          Drop a clip onto a track to begin.
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid='timeline-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='flex h-full w-full flex-col bg-background'
    >
      <div
        data-testid='timeline-ruler'
        className='h-8 border-b border-border bg-muted/40 text-2xs tabular-nums text-muted-foreground'
      />
      <div className='flex-1 overflow-auto'>
        {tracks.map((track) => (
          <div
            key={track.id}
            data-testid={`timeline-track-${track.id}`}
            className='flex h-12 items-center border-b border-border'
          >
            <div className='w-32 shrink-0 border-r border-border px-2 text-xs font-medium'>
              {track.name}
            </div>
            <div className='relative h-full flex-1'>
              {track.clips.map((clip) => (
                <div
                  key={clip.id}
                  data-testid={`timeline-clip-${clip.id}`}
                  style={{
                    left: `${clip.startMs * pixelsPerMs}px`,
                    width: `${clip.durationMs * pixelsPerMs}px`,
                  }}
                  className='absolute top-1 bottom-1 truncate rounded bg-primary/20 px-1 text-2xs text-foreground'
                  title={clip.label}
                >
                  {clip.label}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
