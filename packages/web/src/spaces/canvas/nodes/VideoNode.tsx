import type { VideoNodeData } from '@web/spaces/canvas/types/node';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

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
          // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded video asset; the upload flow does not produce a caption track. Add a <track> when caption authoring lands.
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
