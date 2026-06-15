// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import type { WebNodeView } from '@web/spaces/canvas/types/node-view';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface WebNodeProps {
  data: WebNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
}

/**
 * Web node — embeds an external URL in a sandboxed iframe so canvas
 * users can pin reference pages right next to their content nodes.
 * Sandbox flags are restrictive by default; opening the page in a new
 * tab remains the safe fallback for sites that block framing.
 * @param root0 - Web node props.
 * @param root0.data - Web node payload (embedded page URL, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @returns The web node element (placeholder or sandboxed iframe).
 */
export function WebNode({
  data,
  selected,
  locked,
  onActivate,
}: WebNodeProps): React.JSX.Element {
  const hasContent = Boolean(data.content);
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
            src={data.content ?? 'about:blank'}
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
