// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { ErrorBoundary, captureException } from '@sentry/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRouter } from '@web/app/AppRouter';

vi.mock('@sentry/react', async (original) => ({
  ...await original<typeof import('@sentry/react')>(),
  captureException: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('AppRouter error reporting', () => {
  it('reports a render failure after an interaction once, inside the outer Sentry boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Synthetic close render failure');
    const outerError = vi.fn();
    function Page(): React.JSX.Element {
      const [closed, setClosed] = React.useState(false);
      if (closed) throw error;
      return <button onClick={() => setClosed(true)}>Close</button>;
    }
    const router = createMemoryRouter([{ path: '/', element: <Page /> }]);
    const view = render(
      <React.StrictMode>
        <ErrorBoundary fallback={<div>Outer fallback</div>} onError={outerError}>
          <AppRouter router={router} />
        </ErrorBoundary>
      </React.StrictMode>,
    );
    try {
      expect(captureException).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(await screen.findByText('Unexpected Application Error!')).toBeInTheDocument();
      await waitFor(() => expect(captureException).toHaveBeenCalledExactlyOnceWith(error));
      expect(outerError).not.toHaveBeenCalled();
      expect(screen.queryByText('Outer fallback')).not.toBeInTheDocument();
    } finally {
      view.unmount();
      router.dispose();
    }
  });

  it('reports a rejected lazy page through the route boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Synthetic route module failure');
    const Page = React.lazy(async () => { throw error; });
    const router = createMemoryRouter([{
      path: '/',
      element: <React.Suspense fallback={<div>Loading</div>}><Page /></React.Suspense>,
    }]);
    const view = render(<AppRouter router={router} />);
    try {
      expect(await screen.findByText('Unexpected Application Error!')).toBeInTheDocument();
      await waitFor(() => expect(captureException).toHaveBeenCalledExactlyOnceWith(error));
    } finally {
      view.unmount();
      router.dispose();
    }
  });

  it('reports nothing for a successful render or rerender', () => {
    const router = createMemoryRouter([{ path: '/', element: <div>Healthy route</div> }]);
    const view = render(<AppRouter router={router} />);
    try {
      view.rerender(<AppRouter router={router} />);
      expect(screen.getByText('Healthy route')).toBeInTheDocument();
      expect(captureException).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      router.dispose();
    }
  });
});
