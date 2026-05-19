import { RouterProvider } from 'react-router-dom';

import { router } from './app/routes';

/**
 * App root — mounts the React Router 7 data router.
 *
 * The router definition lives in `app/routes.tsx`; this component is a
 * thin pass-through so future providers (Theme / Yjs / I18n / QueryClient)
 * can wrap it without churn.
 */
export default function App() {
  return <RouterProvider router={router} />;
}
