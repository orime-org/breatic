import { Box } from 'lucide-react';

import type { ThreeDNodeData } from '@web/spaces/canvas/types/node';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface ThreeDNodeProps {
  data: ThreeDNodeData;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * 3D node — placeholder body that shows the bound .glb / .gltf model
 * URL. PR 14 ships the structural slot; the real renderer (React
 * Three Fiber Canvas + OrbitControls + suspense loader) lands during
 * the M3+ media polish PR.
 */
export function ThreeDNode({
  data,
  selected,
  locked,
  onActivate,
}: ThreeDNodeProps) {
  const hasContent = Boolean(data.url);
  return (
    <NodeShell
      status={data.status}
      selected={selected}
      locked={locked}
      className='w-64'
      testId='three-d-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='3d' onActivate={onActivate} />
        }
        content={
          <div
            data-testid='three-d-node-stub'
            className='flex h-32 w-full flex-col items-center justify-center gap-1 bg-muted/40 text-xs text-muted-foreground'
          >
            <Box className='h-5 w-5 opacity-60' aria-hidden='true' />
            <span className='truncate px-2'>{data.url}</span>
          </div>
        }
      />
    </NodeShell>
  );
}
