import type { VideoNodeData } from '@/spaces/canvas/types/node';
import { NodeShell } from '@/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@/spaces/canvas/nodes/_shared/NodePlaceholder';

interface VideoNodeProps {
  data: VideoNodeData;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * Video node — native <video> element with a cover poster. Heavier
 * playback affordances (scrub, hot-key, picture-in-picture trigger)
 * arrive in a later polish PR.
 */
export function VideoNode({
  data,
  selected,
  locked,
  onActivate,
}: VideoNodeProps) {
  const hasContent = Boolean(data.url);
  return (
    <NodeShell
      status={data.status}
      selected={selected}
      locked={locked}
      className='w-72'
      testId='video-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='video' onActivate={onActivate} />
        }
        content={
          <video
            controls
            src={data.url}
            poster={data.coverUrl}
            data-testid='video-node-video'
            className='block w-full rounded-[var(--radius-content-sm)]'
          />
        }
      />
    </NodeShell>
  );
}
