import { RouterProvider } from 'react-router-dom';

import AuthBootstrap from '@/app/AuthBootstrap';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClientProvider } from '@/app/providers/QueryClientProvider';
import { router } from '@/app/routes';

/**
 * App root — providers stack (outer to inner):
 *   QueryClientProvider (TanStack Query)
 *     → TooltipProvider (Radix tooltip context)
 *       → AuthBootstrap (pings /auth/me once, populates useCurrentUserStore)
 *         → RouterProvider (React Router 7 data router)
 *
 * Authentication is cookie-based since 2026-05-26 — there is no
 * dev-user injection on mount. AuthBootstrap fires the single
 * `/auth/me` ping that converts the httpOnly session cookie into a
 * populated `useCurrentUserStore.user`; ProtectedRoute (wired in
 * `routes.tsx`) bounces unauthenticated visitors of protected pages
 * to `/login` once the boot ping completes.
 *
 * Future providers (Theme / Yjs context / I18n) layer around the same
 * shell as needed.
 */
export default function App() {
  return (
    <QueryClientProvider>
      <TooltipProvider>
        <AuthBootstrap>
          <RouterProvider router={router} />
          {/* Toast surface mounts at the top-center of the viewport so
              critical / interaction-blocking messages (lock notice,
              RPC failures, rename refusals) sit in the user's primary
              sight line — the bottom-right corner was easy to miss
              during canvas-focused work (2026-05-25 user spec).
              `duration={3000}` shortens the sonner default (4000ms)
              because top-center toasts hover over the user's primary
              content; 3s is long enough to read a short message and
              short enough not to linger on the canvas.
              No `closeButton` — top-center toasts auto-dismiss; the X
              in the corner only added clutter without helping. */}
          <Toaster richColors position='top-center' duration={3000} />
        </AuthBootstrap>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
