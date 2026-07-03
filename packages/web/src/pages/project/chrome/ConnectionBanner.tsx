// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import * as React from 'react';

import type { ConnectionStatus } from '@web/data/yjs/use-socket';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';

interface ConnectionBannerProps {
  status: ConnectionStatus;
  /** Click handler for the reload / reconnect CTA (refresh window). */
  onReload?: () => void;
  /** Optional re-login CTA - shown only when status==='authFailed'. */
  onReLogin?: () => void;
}

/** The banner's two alarm tones, mapping 1:1 onto status token triples. */
type BannerTone = 'error' | 'warning';

/**
 * Banner-internal button. Self-styled (not the shadcn outline variant, whose
 * mode-aware hover tokens fight banner-local colors — 2026-05-26 user smoke)
 * and toned with the same status triple as the banner surface (#1549): the
 * identity color carries the text + border, hover recesses with the tint.
 * Tailwind classes are written out per tone — no template-assembled class
 * names (they would be purged).
 */
interface BannerButtonProps {
  tone: BannerTone;
  onClick?: () => void;
  testId?: string;
  children: React.ReactNode;
}

/**
 * Self-styled banner action button carrying the banner's status tone
 * (see the interface docstring above for why not shadcn outline).
 * @param root0 - Component props.
 * @param root0.tone - Status tone matching the banner surface.
 * @param root0.onClick - Click handler for the button action.
 * @param root0.testId - Test id applied to the button for assertions.
 * @param root0.children - Button label / icon content.
 * @returns The toned banner action button.
 */
function BannerButton({
  tone,
  onClick,
  testId,
  children,
}: BannerButtonProps): React.JSX.Element {
  return (
    <button
      type='button'
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3',
        'text-sm font-medium transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-1',
        tone === 'error'
          ? 'border-status-error-border text-status-error-foreground hover:bg-status-error-bg focus-visible:ring-status-error'
          : 'border-status-warning-border text-status-warning-foreground hover:bg-status-warning-bg focus-visible:ring-status-warning',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Persistent top-of-page status bar for the project's Hocuspocus
 * connection.
 *
 * Renders nothing when status is `connected` (steady state). When the
 * connection is unhealthy, surfaces a status-colored horizontal bar with
 * a short explanation + an action button so the user is never left in
 * the dark about why content stopped updating.
 *
 * Industry standard pattern - Figma / Notion / GitHub / VSCode all
 * show a connection banner of this shape when the realtime channel
 * fails.
 *
 * State → visual (#1549 — the palette status triples, superseding the
 * pre-#1549 static `bg-red-900` / `bg-amber-700` alarm colors by user
 * decision 2026-07-03):
 *   connecting   → no banner (avoid flash on every quick reconnect)
 *   connected    → no banner
 *   authFailed   → status-error triple, "session expired", [re-login]
 *   disconnected → status-warning triple, "disconnected", [refresh]
 *
 * Structure is two layers: the outer fixed shell paints the opaque page
 * surface (the status `-bg` tints are 14% translucent by design — painted
 * directly on a fixed element they would ghost the TopBar underneath),
 * and the inner surface carries the tint + bottom border + identity text.
 * Both layers adapt to light/dark automatically through the palette's
 * dark overrides — the banner no longer opts out of theming.
 * @param root0 - Component props.
 * @param root0.status - Current Hocuspocus connection status driving the banner's visibility and color.
 * @param root0.onReload - Click handler for the reload / reconnect CTA (refresh window).
 * @param root0.onReLogin - Click handler for the re-login CTA, shown only when status is `authFailed`.
 * @returns The connection status banner, or `null` when the connection is healthy or merely connecting.
 */
export function ConnectionBanner({
  status,
  onReload,
  onReLogin,
}: ConnectionBannerProps): React.JSX.Element | null {
  const t = useTranslation();

  // `connecting` is intentionally silent - a half-second blip during
  // normal navigation shouldn't surface as an alarm. Visible status
  // set is therefore just authFailed + disconnected.
  if (status !== 'authFailed' && status !== 'disconnected') {
    return null;
  }
  const isAuthFailed = status === 'authFailed';
  const tone: BannerTone = isAuthFailed ? 'error' : 'warning';

  // `fixed top-0 left-0 right-0 z-50` - banner sits OUTSIDE the
  // document flow, overlaying the very top of the viewport. TopBar
  // therefore always hugs viewport top (per 2026-05-26 user spec);
  // when banner is visible it overlays the topmost ~40px of TopBar
  // rather than pushing TopBar down (no layout shift at all).
  //
  // No enter/exit transition: paired with the workspace overlay
  // (ProjectPage.tsx) which also mounts instantly - both must appear
  // / disappear on the same frame, otherwise the staggered timing
  // reads as visual jitter (per 2026-05-26 user spec).
  return (
    <div
      role='status'
      aria-live='polite'
      data-testid='connection-banner'
      data-status={status}
      className='fixed top-0 right-0 left-0 z-50 bg-background'
    >
      <div
        data-testid='connection-banner-surface'
        className={cn(
          'flex items-center justify-between gap-3 border-b px-4 py-2 text-sm',
          tone === 'error'
            ? 'bg-status-error-bg text-status-error-foreground border-status-error-border'
            : 'bg-status-warning-bg text-status-warning-foreground border-status-warning-border',
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
            <BannerButton
              tone={tone}
              onClick={onReLogin}
              testId='connection-banner-relogin'
            >
              {t('connection.banner.authFailed.action')}
            </BannerButton>
          ) : null}
          {onReload ? (
            <BannerButton
              tone={tone}
              onClick={onReload}
              testId='connection-banner-reload'
            >
              <RefreshCw className='h-3.5 w-3.5' aria-hidden />
              {t('connection.banner.reload')}
            </BannerButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
