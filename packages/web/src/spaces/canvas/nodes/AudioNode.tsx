// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import type { AudioNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

interface AudioNodeProps {
  data: AudioNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  /** Retry a failed upload (error state), pre-bound to this node (#1609 P4). */
  onRetryUpload?: () => void;
  onRename?: (name: string) => void;
}

/**
 * Audio node — renders the unified {@link MediaPlayer} (native `<audio>` +
 * a decorative waveform that doubles as the scrubber + transport controls,
 * zero third-party player dependency).
 * @param root0 - Audio node props.
 * @param root0.data - Audio node payload (asset URL, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @param root0.onRetryUpload - Retry a failed upload from the session stash (#1609 P4); absent hides the Retry button.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @returns The audio node element (placeholder or native audio player).
 */
export function AudioNode({
  data,
  selected,
  locked,
  onActivate,
  onRetryUpload,
  onRename,
}: AudioNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
  return (
    <ContentNodeFrame
      modality='audio'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='audio-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        onRetry={onRetryUpload}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='audio' onActivate={onActivate} />
        }
        content={
          <div className='p-3'>
            <MediaPlayer modality='audio' src={data.content ?? ''} />
          </div>
        }
      />
    </ContentNodeFrame>
  );
}
