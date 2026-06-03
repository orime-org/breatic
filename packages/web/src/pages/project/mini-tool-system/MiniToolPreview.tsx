// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Skeleton } from '@web/components/ui/skeleton';
import type { Modality } from '@web/spaces/canvas/types/node';

interface MiniToolPreviewProps {
  /** What the produced node will be. */
  outputModality: Modality;
  /** Live preview content (text stream, image url, etc.); null while loading. */
  preview?: React.ReactNode;
  /** True while the worker / SSE has not finished. */
  pending?: boolean;
}

/**
 * Renders the in-progress preview of a running mini-tool. Text tools
 * stream into the preview via SSE; AIGC tools show a skeleton until the
 * worker writes the URL.
 * @param root0 - The component props.
 * @param root0.outputModality - The modality of the node the tool will produce.
 * @param root0.preview - The live preview content (text stream, image url, etc.).
 * @param root0.pending - Whether the worker / SSE has not finished yet.
 * @returns The preview card, showing a skeleton while pending without content.
 */
export function MiniToolPreview({
  outputModality,
  preview,
  pending,
}: MiniToolPreviewProps): React.JSX.Element {
  return (
    <div
      data-testid='mini-tool-preview'
      data-output-modality={outputModality}
      className='rounded border border-border bg-card p-3'
    >
      {pending && !preview ? (
        <Skeleton className='h-16 w-full' />
      ) : (
        <div className='text-sm'>{preview}</div>
      )}
    </div>
  );
}
