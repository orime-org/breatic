// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueryClientProvider, queryClient } from '@web/app/providers/QueryClientProvider';

function ActualNodeProbe(): React.JSX.Element {
  const client = useQueryClient();
  return <div data-testid='actual-node-query-cache'>{client === queryClient ? 'account-owned' : 'different'}</div>;
}
const nodeTypes = { probe: ActualNodeProbe };

describe('production account provider across the actual ReactFlow node boundary', () => {
  it('gives permanent rendered nodes the same existing account query client without a node-local provider', () => {
    render(<QueryClientProvider><ReactFlowProvider><div style={{ width: 800, height: 600 }}><ReactFlow nodeTypes={nodeTypes} nodes={[{ id: 'video', type: 'probe', position: { x: 0, y: 0 }, data: {} }]} edges={[]} /></div></ReactFlowProvider></QueryClientProvider>);
    expect(screen.getByTestId('actual-node-query-cache')).toHaveTextContent('account-owned');
  });
});
