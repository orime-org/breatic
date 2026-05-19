import { RouterProvider } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClientProvider } from './app/providers/QueryClientProvider';
import { router } from './app/routes';

/**
 * App root — providers stack (outer to inner):
 *   QueryClientProvider (TanStack Query)
 *     → TooltipProvider (Radix tooltip context)
 *       → RouterProvider (React Router 7 data router)
 *
 * Future providers (Theme / Yjs context / I18n) layer around the same
 * shell as needed.
 */
export default function App() {
  return (
    <QueryClientProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
