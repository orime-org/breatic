import type { SpaceBodyProps } from '@/spaces';
import { useTranslation } from '@/i18n/use-translation';

/**
 * Canvas space body — chrome-baseline mock `.canvas-area` (finalized.html
 * CSS 904-929 + HTML 1239-1245).
 *
 * Background:
 *   - 24px dot grid (radial-gradient circle 1px on neutral-200) over a
 *     `--neutral-50` elevated surface; light + dark auto-invert via the
 *     neutral token cascade
 *   - dot grid is painted via inline `background-image` because Tailwind
 *     can't express the `radial-gradient + solid color` composite without
 *     a custom utility, and this lives on exactly one element
 *
 * Empty state (when no nodes exist yet, M0' placeholder):
 *   - centered hint card with dashed border + content radius (`rounded-lg`)
 *   - title + sub-hint loaded via i18n (`canvas.emptyState.*`)
 *
 * The full ReactFlow + Yjs binding + node toolbar + reference chips
 * wiring lands in later PRs; this PR just gets the surface visually
 * correct so chrome layered components (LeftFloatingMenu /
 * ViewportToolbar) sit on the mock-aligned canvas.
 */
export function CanvasSpace({ spaceId, projectId }: SpaceBodyProps) {
  const t = useTranslation();
  return (
    <div
      data-testid='canvas-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='relative h-full w-full overflow-hidden bg-elevated'
      style={{
        backgroundImage:
          'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
        backgroundPosition: '0 0',
      }}
    >
      <div
        data-testid='canvas-empty'
        className='absolute inset-0 flex items-center justify-center text-center text-[13px] leading-relaxed text-muted-foreground'
      >
        <div className='max-w-[360px] rounded-lg border border-dashed border-border bg-elevated px-6 py-4'>
          <strong className='block text-foreground'>{t('canvas.emptyState.title')}</strong>
          <span className='text-[12px] text-muted-foreground'>
            {t('canvas.emptyState.hint')}
          </span>
        </div>
      </div>
    </div>
  );
}
