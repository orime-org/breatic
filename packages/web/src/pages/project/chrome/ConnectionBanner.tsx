import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import * as React from 'react';

import type { ConnectionStatus } from '@/data/yjs/use-socket';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/use-translation';

interface ConnectionBannerProps {
  status: ConnectionStatus;
  /** Click handler for the reload / reconnect CTA (refresh window). */
  onReload?: () => void;
  /** Optional re-login CTA — shown only when status==='authFailed'. */
  onReLogin?: () => void;
}

/**
 * Persistent top-of-page status bar for the project's Hocuspocus
 * connection.
 *
 * Renders nothing when status is `connected` (steady state). When the
 * connection is unhealthy, surfaces a colored 40px horizontal bar with
 * a short explanation + an action button so the user is never left in
 * the dark about why content stopped updating.
 *
 * Design per 2026-05-25 user ask (after a `LOGIN_MODE` env strip caused
 * silent ws auth failures + 14 spaces invisible). Industry standard
 * pattern — Figma / Notion / GitHub / VSCode all show a connection
 * banner of this shape when the realtime channel fails.
 *
 * State → visual:
 *   connecting  → no banner (avoid flash on every quick reconnect)
 *   connected   → no banner
 *   authFailed  → red, "登录已失效", [重新登录] action
 *   disconnected → yellow, "连接断开", [刷新页面] action
 *
 * Tokens used:
 *   --color-status-error-* (red, fatal auth)
 *   --color-status-warning-* (yellow, soft disconnect)
 */
export function ConnectionBanner({
  status,
  onReload,
  onReLogin,
}: ConnectionBannerProps) {
  const t = useTranslation();

  if (status === 'connected' || status === 'connecting') {
    // `connecting` is intentionally silent — a half-second blip during
    // normal navigation shouldn't flash a red bar.
    return null;
  }

  const isAuthFailed = status === 'authFailed';

  return (
    <div
      role='status'
      aria-live='polite'
      data-testid='connection-banner'
      data-status={status}
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-[13px]',
        isAuthFailed
          ? 'border-status-error-border bg-status-error-bg text-status-error-foreground'
          : 'border-status-warning-border bg-status-warning-bg text-status-warning-foreground',
      )}
    >
      <div className='flex min-w-0 items-center gap-2'>
        {isAuthFailed ? (
          <AlertTriangle className='h-4 w-4 shrink-0' aria-hidden />
        ) : (
          <Loader2 className='h-4 w-4 shrink-0 animate-spin' aria-hidden />
        )}
        <span className='truncate font-medium'>
          {isAuthFailed
            ? t('connection.banner.authFailed.text')
            : t('connection.banner.disconnected.text')}
        </span>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        {isAuthFailed && onReLogin ? (
          <Button
            size='sm'
            variant='outline'
            onClick={onReLogin}
            data-testid='connection-banner-relogin'
          >
            {t('connection.banner.authFailed.action')}
          </Button>
        ) : null}
        {onReload ? (
          <Button
            size='sm'
            variant='outline'
            onClick={onReload}
            data-testid='connection-banner-reload'
            className='gap-1.5'
          >
            <RefreshCw className='h-3.5 w-3.5' aria-hidden />
            {t('connection.banner.reload')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
