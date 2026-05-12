/**
 * HandlingOverlay — overlay rendered on a node while
 * `data.state === 'handling'`. Visual aligned with
 * `design/project/mocks/05-canvas-native-tailwind.html` @1928-1967.
 *
 * Composition (top → bottom):
 *
 *   ┌────────────────────────────────────┐
 *   │  ┌─┐  username                     │   ← (a) avatar + name (handlingBy)
 *   │  └─┘                               │
 *   │           ⟳                        │   ← (b) CSS spinner (brand-500 top arc)
 *   │      operation label               │   ← (c) operation name (i18n'd)
 *   └────────────────────────────────────┘
 *
 * The mock additionally surfaces elapsed seconds + estimated total +
 * progress bar — those require a `startedAt` timestamp on the node
 * data and a per-tool estimate. Neither is wired through Yjs today,
 * so this V1 overlay sticks to the avatar / spinner / label trio.
 * Adding the timer later is a small extension (the mock's logic at
 * @1931-1962 carries over verbatim once `data.startedAt` exists).
 *
 * Avatar color is intentionally neutral (per mock @1944: "去
 * hue-tinted background — Linear refresh") rather than the violet-
 * gradient from earlier exploration.
 */
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/classnames';

export interface HandlingOverlayProps {
  /** Display name for the user driving the operation. */
  username?: string | null;
  /** Operation id (matches an `IMAGE_TOOLS` row id or a backend tool name). */
  operation?: string | null;
  /** When true, the overlay sits on top of a node's content area. */
  className?: string;
}

const HandlingOverlay: React.FC<HandlingOverlayProps> = memo(function HandlingOverlay({
  username,
  operation,
  className,
}) {
  const { t } = useTranslation();
  const initials = useMemo(() => {
    if (!username) return '';
    const parts = username.trim().split(/\s+/);
    const first = parts[0]?.charAt(0) ?? '';
    const second = parts[1]?.charAt(0) ?? '';
    return (first + second).toUpperCase() || username.slice(0, 2).toUpperCase();
  }, [username]);

  // i18n key derived from operation id — `bg-blur` → `tool_bg_blur`
  // (matches mock @1964) so the existing translation table flows in.
  const operationLabel = operation
    ? t(`tool_${operation.replace(/-/g, '_')}`, {
        defaultValue: t(`canvas.node.handling.${operation}`, {
          defaultValue: operation,
        }),
      })
    : null;

  return (
    <div
      className={cn(
        'absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 rounded-[6px] px-3',
        'bg-background-default-base/90 backdrop-blur-[1px] pointer-events-none',
        className,
      )}
    >
      {username && (
        <div className='flex items-center gap-1.5 mb-0.5'>
          <div
            className={cn(
              'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0',
              'bg-neutral-700 text-neutral-0 text-[9px] font-semibold',
            )}
          >
            {initials}
          </div>
          <span className='text-[10px] font-mono text-text-default-secondary truncate max-w-[120px]'>
            {username}
          </span>
        </div>
      )}
      {/* CSS-only spinner — lighter than the SVG-icon spinner the old
          inline overlay used. Top arc is the brand color; the rest of
          the ring is the neutral-200 token so it reads on either
          theme. */}
      <div
        className='w-4 h-4 border-[2px] border-neutral-200 border-t-brand-500 rounded-full animate-spin'
        aria-label={t('canvas.node.processing', 'Processing...')}
      />
      {operationLabel && (
        <div className='text-[9px] font-mono text-text-default-tertiary mt-0.5 truncate max-w-full'>
          {operationLabel}
        </div>
      )}
    </div>
  );
});

export default HandlingOverlay;
