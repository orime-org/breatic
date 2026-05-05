/**
 * Video body for canvas nodes — {@link CanvasVideo} without in-node control bar; playback chrome lives in `PlaybackPanel` on the flow toolbar (mixed-editor parity).
 */
import { forwardRef, memo } from 'react';
import CanvasVideo, { type CanvasVideoPlaybackSnapshot, type CanvasVideoRef } from '../../common/CanvasVideo';

export interface LocalVideoNodeContentProps {
  src: string;
  selected?: boolean;
  onPlaybackUpdate?: (snapshot: CanvasVideoPlaybackSnapshot) => void;
}

const LocalVideoNodeContent = forwardRef<CanvasVideoRef, LocalVideoNodeContentProps>(
  ({ src, onPlaybackUpdate }, ref) => (
    <div className='relative flex h-full w-full min-h-0 items-center justify-center overflow-hidden rounded-[8px]'>
      <CanvasVideo ref={ref} src={src} showControlBar={false} onPlaybackUpdate={onPlaybackUpdate} className='rounded-[8px]' />
    </div>
  ),
);

LocalVideoNodeContent.displayName = 'LocalVideoNodeContent';

export default memo(LocalVideoNodeContent);
