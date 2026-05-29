import type { WebNodeData } from '@web/spaces/canvas/types/node';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface WebNodeProps {
  data: WebNodeData;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * Web node — embeds an external URL in a sandboxed iframe so canvas
 * users can pin reference pages right next to their content nodes.
 * Sandbox flags are restrictive by default; opening the page in a new
 * tab remains the safe fallback for sites that block framing.
 */
export function WebNode({
  data,
  selected,
  locked,
  onActivate,
}: WebNodeProps) {
  const hasContent = Boolean(data.url);
  return (
    <NodeShell
      status={data.status}
      selected={selected}
      locked={locked}
      className='w-72'
      testId='web-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='web' onActivate={onActivate} />
        }
        content={
          <iframe
            src={data.url ?? 'about:blank'}
            data-testid='web-node-iframe'
            title='Embedded web page'
            sandbox='allow-scripts allow-same-origin allow-popups'
            referrerPolicy='no-referrer'
            className='h-48 w-full rounded-[var(--radius-content-sm)] border-0 bg-background'
          />
        }
      />
    </NodeShell>
  );
}
