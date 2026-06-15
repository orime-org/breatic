// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import type { AudioNodeView } from '@web/spaces/canvas/types/node-view';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface AudioNodeProps {
  data: AudioNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * Audio node — wraps the native <audio> element for now. WaveSurfer
 * waveform rendering arrives in the M3+ media polish PR; the renderer
 * stays swappable behind this component boundary.
 * @param root0 - Audio node props.
 * @param root0.data - Audio node payload (asset URL, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @returns The audio node element (placeholder or native audio player).
 */
export function AudioNode({
  data,
  selected,
  locked,
  onActivate,
}: AudioNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
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
              src={data.content}
              data-testid='audio-node-audio'
              className='w-full'
            />
          </div>
        }
      />
    </NodeShell>
  );
}
