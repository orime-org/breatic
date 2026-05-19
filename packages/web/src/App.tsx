import { RouterProvider } from 'react-router-dom';

import { TooltipProvider } from '@/components/ui/tooltip';
import { router } from './app/routes';

/**
 * App root — mounts the React Router 7 data router under a global
 * TooltipProvider so any descendant `<Tooltip>` works without local
 * wrapping. Future providers (Theme / Yjs / I18n / QueryClient) layer
 * around the same shell.
 */
export default function App() {
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  );
}
