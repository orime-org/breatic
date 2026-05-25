import { RouterProvider } from 'react-router-dom';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { injectDevUser } from '@/app/dev/inject-dev-user';
import { QueryClientProvider } from '@/app/providers/QueryClientProvider';
import { router } from '@/app/routes';

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
        {/* Toast surface mounts at the top-center of the viewport so
            critical / interaction-blocking messages (lock notice,
            RPC failures, rename refusals) sit in the user's primary
            sight line — the bottom-right corner was easy to miss
            during canvas-focused work (2026-05-25 user spec). */}
        <Toaster richColors closeButton position='top-center' />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
