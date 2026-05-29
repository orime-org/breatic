import { Loader2 } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';

/**
 * Full-viewport loading screen used while async backend state
 * (currently the Hocuspocus connection in `useProjectMeta`) is still
 * resolving its initial value.
 *
 * Why this exists (2026-05-26 user spec): without it, ProjectPage
 * renders one paint with `connectionStatus === 'connecting'` — banner
 * + workspace overlay both bail to null — and the user sees a clean
 * project page for a few hundred ms. Then the websocket auth fails,
 * `setStatus('authFailed')` fires, and the banner + overlay pop in on
 * the next frame, causing a visible "page → flash banner+overlay"
 * jitter. Showing this screen instead during `connecting` defers the
 * project page mount until the status is final, so banner + overlay
 * appear together with the page on a single frame.
 *
 * Visual: project background color + centered spinner + "Loading..."
 * (uses the project-wide `loading` i18n key — same string as elsewhere
 * in the app).
 */
export function LoadingScreen() {
  const t = useTranslation();
  return (
    <div
      role='status'
      aria-live='polite'
      data-testid='project-loading-screen'
      className='flex h-screen w-screen items-center justify-center bg-background text-muted-foreground'
    >
      <div className='flex flex-col items-center gap-3'>
        <Loader2 className='h-6 w-6 animate-spin' aria-hidden />
        <span className='text-sm'>{t('loading')}</span>
      </div>
    </div>
  );
}
