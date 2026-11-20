// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { TooltipProvider } from '@web/components/ui/tooltip';

/**
 * The tooltip and server-data contexts the application root owns, one query
 * cache per mounted tree that does not retry.
 * @param props - The tree.
 * @param props.children - What it wraps.
 * @returns The wrapped tree.
 */
function RootProviders({ children }: { children: ReactNode }): React.JSX.Element {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

/**
 * Supply the contexts owned by the application root (tooltips, server data)
 * to isolated component tests.
 * @param ui - Component tree to render.
 * @param options - Testing Library options for the render.
 * @returns The mounted component queries and lifecycle controls.
 * @throws {Error} When the rendered component fails.
 */
export function renderWithTooltips(ui: ReactNode, options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  return render(ui, { ...options, wrapper: RootProviders });
}
