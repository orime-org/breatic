import type { AudioNodeData } from '@/spaces/canvas/types/node';
import { NodeShell } from '@/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@/spaces/canvas/nodes/_shared/NodePlaceholder';

interface AudioNodeProps {
  data: AudioNodeData;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * Audio node — wraps the native <audio> element for now. WaveSurfer
 * waveform rendering arrives in the M3+ media polish PR; the renderer
 * stays swappable behind this component boundary.
 */
export function AudioNode({
  data,
  selected,
  locked,
  onActivate,
}: AudioNodeProps) {
  const hasContent = Boolean(data.url);
  return (
    <NodeShell
      status={data.status}
      selected={selected}
      locked={locked}
      className='w-64'
      testId='audio-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='audio' onActivate={onActivate} />
        }
        content={
          <div className='p-3'>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded audio asset; the upload flow does not produce a caption track. Add a <track> when caption authoring lands. */}
            <audio
              controls
              src={data.url}
              data-testid='audio-node-audio'
              className='w-full'
            />
          </div>
        }
      />
    </NodeShell>
  );
}
