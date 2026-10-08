// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Skeleton } from '@web/components/ui/skeleton';
import type { ImageNodeView } from '@web/data/yjs/node-view';
import { cn } from '@web/lib/utils';
import { usePreviewSrc } from '@web/lib/preview-src';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodeMediaInset } from '@web/spaces/canvas/nodes/_shared/NodeMediaInset';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { useZoomedPastPreview } from '@web/spaces/canvas/nodes/_shared/preview-zoom';
import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/useNodeResolution';

interface ImageNodeProps {
  data: ImageNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  /** Open this node's task list on its failures (#186 §3.7.2). */
  onViewTasks?: () => void;
  /** Whether that list is already open beside this node. */
  tasksPanelOpen?: boolean;
  onRename?: (name: string) => void;
}

/**
 * Image node — displays the bound image URL, or a placeholder when the
 * node is empty. Click-to-generate lives in the toolbar left zone (PR 7);
 * here we just render the asset.
 * @param root0 - Image node props.
 * @param root0.data - Image node payload (asset URL, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @param root0.onViewTasks - Open this node's task list on its failures.
 * @returns The image node element (placeholder or rendered image).
 */
export const ImageNode = React.memo(function ImageNode({
  data,
  selected,
  locked,
  onActivate,
  onViewTasks,
  tasksPanelOpen,
  onRename,
}: ImageNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
  const { resolution, setResolution } = useNodeResolution(data.content, data.width, data.height);
  // The preview stands in only when the image's own size is known: that size
  // reserves the node's height before anything loads, and it is what the badge
  // shows. A node without one shows the original and measures it.
  const knowsSize = typeof data.width === 'number' && typeof data.height === 'number';
  const shown = usePreviewSrc(data.content, { enabled: knowsSize });
  const src = shown.src ?? '';
  // The address whose load has finished, one way or the other. The skeleton
  // covers the box until the address on the element is that one.
  const [settled, setSettled] = React.useState<string | null>(null);
  const loading = settled !== src;
  // Zoomed past the preview, the original is laid over it and shown once it
  // has loaded, so the picture never blanks while it sharpens.
  const zoomedPast = useZoomedPastPreview(data.content);
  const laysOriginal = zoomedPast && !shown.isOriginal;
  const [originalLoaded, setOriginalLoaded] = React.useState<string | undefined>(undefined);
  const { onError: fallBack, isOriginal } = shown;
  const onError = React.useCallback((): void => {
    // A missing preview falls back to the original, which then loads in its
    // place; only the original failing ends the wait.
    if (isOriginal) setSettled(src);
    fallBack();
  }, [fallBack, isOriginal, src]);
  return (
    <ContentNodeFrame
      modality='image'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='image-node'
      resolution={resolution}
    >
      <NodeContent
        onViewTasks={onViewTasks}
        tasksPanelOpen={tasksPanelOpen}
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='image' onActivate={onActivate} />
        }
        content={
          <NodeMediaInset>
            <div className='relative'>
              <img
                src={src}
                alt=''
                width={knowsSize ? data.width : undefined}
                height={knowsSize ? data.height : undefined}
                // Offscreen nodes still mount once on canvas load (xyflow #3883,
                // see onlyRenderVisibleElements in CanvasSpace) — lazy defers
                // their fetch to viewport proximity (#1772).
                loading='lazy'
                decoding='async'
                data-testid='image-node-img'
                className='block h-auto w-full'
                onError={onError}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setSettled(src);
                  shown.onLoad(e);
                  // A preview's pixels are not the image's size.
                  if (!shown.isOriginal) return;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setResolution({
                      width: img.naturalWidth,
                      height: img.naturalHeight,
                    });
                  }
                }}
              />
              {/* With a size the skeleton covers the box the img reserves.
                Without one the unloaded img has no height, and the empty
                node's 288x192 holds the place until the picture brings its
                own. */}
              {loading ? (
                <Skeleton
                  data-testid='image-node-skeleton'
                  className={cn(
                    'rounded-none',
                    knowsSize ? 'pointer-events-none absolute inset-0' : 'aspect-[3/2] w-full',
                  )}
                />
              ) : null}
              {laysOriginal ? (
                <img
                  src={data.content}
                  alt=''
                  decoding='async'
                  data-testid='image-node-original'
                  className={cn(
                    'pointer-events-none absolute inset-0 block size-full',
                    originalLoaded !== data.content && 'opacity-0',
                  )}
                  onLoad={() => setOriginalLoaded(data.content)}
                />
              ) : null}
            </div>
          </NodeMediaInset>
        }
      />
    </ContentNodeFrame>
  );
});
