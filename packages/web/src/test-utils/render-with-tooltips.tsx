// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { TooltipProvider } from '@web/components/ui/tooltip';

/**
 * Supplies the query cache the application root owns, unless the test mounted its own: canvas nodes read a video's
 * presentation through it (frames-split §7.8).
 * @param props - The tree.
 * @param props.client - The cache used when none is mounted.
 * @param props.children - The tree.
 * @returns The tree under a query cache.
 * @throws {never} Never.
 */
function WithQueryClient({ client, children }: { client: QueryClient; children: ReactNode }): React.JSX.Element {
  const outer = React.useContext(QueryClientContext);
  return outer === undefined ? <QueryClientProvider client={client}>{children}</QueryClientProvider> : <>{children}</>;
}

/**
 * Supply the tooltip context and the query cache owned by the application root to isolated component tests.
 * @param ui - Component tree to render.
 * @param options - Testing Library options for the render.
 * @returns The mounted component queries and lifecycle controls.
 * @throws {Error} When the rendered component fails.
 */
export function renderWithTooltips(ui: ReactNode, options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  /**
   * The root providers around the tree.
   * @param props - The tree.
   * @param props.children - The tree.
   * @returns The wrapped tree.
   * @throws {never} Never.
   */
  // The root's one provider stands in for the app's, as before; it is built without JSX like the helper always passed it.
  const Wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => <WithQueryClient client={client}>{React.createElement(TooltipProvider, null, children)}</WithQueryClient>;
  return render(ui, { ...options, wrapper: Wrapper });
}
