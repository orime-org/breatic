import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TimelineSpace } from '@/spaces/timeline/TimelineSpace';
import type { TimelineTrack } from '@/spaces/timeline/types';

describe('TimelineSpace', () => {
  it('renders the empty state when there are no tracks', () => {
    render(<TimelineSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('timeline-space-empty')).toBeInTheDocument();
  });

  it('renders one row per track and one clip per clip', () => {
    const tracks: TimelineTrack[] = [
      {
        id: 't1',
        name: 'Video',
        modality: 'video',
        clips: [{ id: 'c1', modality: 'video', startMs: 0, durationMs: 1000, label: 'intro' }],
      },
      {
        id: 't2',
        name: 'Audio',
        modality: 'audio',
        clips: [
          { id: 'c2', modality: 'audio', startMs: 0, durationMs: 500, label: 'bgm' },
          { id: 'c3', modality: 'audio', startMs: 600, durationMs: 400, label: 'sfx' },
        ],
      },
    ];
    render(<TimelineSpace projectId='p' spaceId='s' tracks={tracks} />);
    expect(screen.getByTestId('timeline-space')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-track-t1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-track-t2')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-clip-c1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-clip-c2')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-clip-c3')).toBeInTheDocument();
  });

  it('positions clips using startMs * pixelsPerMs', () => {
    const tracks: TimelineTrack[] = [
      {
        id: 't1',
        name: 'V',
        modality: 'video',
        clips: [
          { id: 'c1', modality: 'video', startMs: 1000, durationMs: 500, label: 'x' },
        ],
      },
    ];
    render(
      <TimelineSpace
        projectId='p'
        spaceId='s'
        tracks={tracks}
        pixelsPerMs={0.1}
      />,
    );
    const clip = screen.getByTestId('timeline-clip-c1');
    expect((clip as HTMLDivElement).style.left).toBe('100px');
    expect((clip as HTMLDivElement).style.width).toBe('50px');
  });
});
