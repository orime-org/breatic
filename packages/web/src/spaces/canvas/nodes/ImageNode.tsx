import type { ImageNodeData } from '@/spaces/canvas/types/node';
import { NodeShell } from './_shared/NodeShell';
import { NodeContent } from './_shared/NodeContent';
import { NodePlaceholder } from './_shared/NodePlaceholder';

interface ImageNodeProps {
  data: ImageNodeData;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * Image node — displays the bound image URL, or a placeholder when the
 * node is empty. Click-to-generate lives in the toolbar left zone (PR 7);
 * here we just render the asset.
 */
export function ImageNode({
  data,
  selected,
  locked,
  onActivate,
}: ImageNodeProps) {
  const hasContent = Boolean(data.url);
  return (
    <NodeShell
      status={data.status}
      selected={selected}
      locked={locked}
      className='w-56'
      testId='image-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='image' onActivate={onActivate} />
        }
        content={
          <img
            src={data.url ?? ''}
            alt=''
            data-testid='image-node-img'
            className='block h-auto w-full rounded-md'
          />
        }
      />
    </NodeShell>
  );
}
