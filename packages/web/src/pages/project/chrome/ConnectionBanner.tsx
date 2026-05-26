import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import * as React from 'react';

import type { ConnectionStatus } from '@/data/yjs/use-socket';
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
 * Banner-internal button. Raw `<button>` instead of the shadcn
 * `<Button variant='outline'>` because the outline variant's
 * defaults — `hover:bg-accent` + `hover:text-accent-foreground` —
 * are mode-aware tokens that win the cascade over a base
 * `bg-black/30 text-white` override on hover. That made the banner
 * button visibly different in light vs. dark mode on hover (light
 * mode flashed a near-white button on the red banner, 2026-05-26
 * user smoke). A fully self-styled `<button>` opts out of the
 * variant cascade entirely → both modes render identically and the
 * hover effect (`hover:opacity-90`) is the only thing that changes.
 *
 * Mode-independent palette here matches the banner itself — see the
 * component-level docstring for rationale + memory reference.
 */
interface BannerButtonProps {
  onClick?: () => void;
  className?: string;
  testId?: string;
  children: React.ReactNode;
}

function BannerButton({
  onClick,
  className,
  testId,
  children,
}: BannerButtonProps) {
  return (
    <button
      type='button'
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md',
        'border border-white/30 bg-black/30 px-3',
        'text-[13px] font-medium text-white',
        // Hover feedback: solid color swap (bg + border). Aligns with the
        // rest of the project's hover convention (bg/text-color change,
        // not transform / filter). Uses Tailwind static `zinc-700` /
        // `zinc-800` solid colors — does NOT trip the lint:hover ADR
        // ban (which only forbids `hover:bg-X/N` alpha-modifier patterns
        // for Tailwind v4 silent-fail prevention; solid colors are fine).
        //
        // Prior attempts (chrome MCP-verified 2026-05-26):
        //   - `hover:opacity-90` — 10% change on dark button: invisible
        //   - `hover:brightness-125` — no-op on pure-black/white palette
        //     (RGB 0×N=0; 255 clamps)
        //   - `hover:scale-105` — physical feedback but introduced a
        //     third hover-feedback standard inconsistent with the rest
        //     of the project; user rejected as cross-standard.
        'transition-colors duration-150',
        'hover:border-white/70 hover:bg-zinc-700',
        'active:bg-zinc-800',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50',
        className,
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
 *   connecting   → no banner (avoid flash on every quick reconnect)
 *   connected    → no banner
 *   authFailed   → deep red, "登录已失效", [重新登录] action
 *   disconnected → deep amber, "连接断开", [刷新页面] action
 *
 * Mode-independent palette (Tailwind static `red-900` / `amber-700`):
 *   banner is an alarm signal — its color semantics are constant
 *   regardless of light/dark mode. Using shared `--color-status-error-*`
 *   tokens would make light-mode banner a pale-red wash (silly for a
 *   "session expired" alert) AND would couple banner color changes to
 *   in-app error text in ToolCallCard / NewSpaceDialog (which DO want
 *   to follow theme mode). See memory
 *   `feedback_mode_independent_tokens` for the broader rule:
 *   brand / status alarm UI elements opt out of theme switching.
 *
 * Button override (`bg-black/30 border-white/30 text-white`): default
 * shadcn outline variant uses `--background` which would render a
 * white pill on the deep-red banner in light mode — visually jarring.
 * Translucent-black + white border + white text keeps strong contrast
 * on both deep-red and deep-amber banners.
 */
export function ConnectionBanner({
  status,
  onReload,
  onReLogin,
}: ConnectionBannerProps) {
  const t = useTranslation();

  // `connecting` is intentionally silent — a half-second blip during
  // normal navigation shouldn't surface as an alarm. Visible status
  // set is therefore just authFailed + disconnected.
  const visible = status === 'authFailed' || status === 'disconnected';
  const isAuthFailed = status === 'authFailed';

  // Wrapper stays in the DOM at all times so that the transition from
  // hidden → visible (and back) animates smoothly via max-height. If
  // we early-returned null the banner would *insert* into layout on
  // first ws fail, pushing the entire workspace down in a single
  // frame — visually feels like "TopBar suddenly gets shoved down by
  // banner" (2026-05-26 user smoke report). Always-mounted wrapper +
  // max-height transition gives a smooth slide-in instead.
  return (
    <div
      className={cn(
        'overflow-hidden transition-[max-height] duration-200 ease-out',
        visible ? 'max-h-[60px]' : 'max-h-0',
      )}
      aria-hidden={!visible || undefined}
    >
    <div
      role='status'
      aria-live='polite'
      data-testid='connection-banner'
      data-status={status}
      className={cn(
        'flex shrink-0 items-center justify-between gap-3 px-4 py-2 text-[13px]',
        // Mode-independent — see component docstring. Tailwind static
        // palette is intentional: banner color does NOT follow light/dark.
        isAuthFailed
          ? 'bg-red-900 text-red-50'
          : 'bg-amber-700 text-amber-50',
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
            onClick={onReLogin}
            testId='connection-banner-relogin'
          >
            {t('connection.banner.authFailed.action')}
          </BannerButton>
        ) : null}
        {onReload ? (
          <BannerButton
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
