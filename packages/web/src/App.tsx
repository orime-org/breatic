import { RouterProvider } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { injectDevUser } from './app/dev/inject-dev-user';
import { QueryClientProvider } from './app/providers/QueryClientProvider';
import { router } from './app/routes';

/**
 * App root — providers stack (outer to inner):
 *   QueryClientProvider (TanStack Query)
 *     → TooltipProvider (Radix tooltip context)
 *       → RouterProvider (React Router 7 data router)
 *
 * In dev (`import.meta.env.DEV`), seed the current-user store with a
 * fixed dev identity that matches backend `LOGIN_MODE=NoAccount`.
 * Real login flow lands in a later PR.
 *
 * Future providers (Theme / Yjs context / I18n) layer around the same
 * shell as needed.
 */
if (import.meta.env.DEV) {
  injectDevUser();
}

export default function App() {
  return (
    <QueryClientProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
