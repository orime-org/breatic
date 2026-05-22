import {
  AlignCenterHorizontal,
  Expand,
  Grid3x3,
  Map as MinimapIcon,
  Maximize2,
  Minus,
  Plus,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/use-translation';

interface ViewportToolbarProps {
  zoom: number;
  minimapVisible: boolean;
  snapToGrid: boolean;
  alignActive: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFit: () => void;
  onExpand: () => void;
  onToggleSnap: () => void;
  onToggleAlign: () => void;
  onToggleMinimap: () => void;
}

/**
 * Floating overlay sitting in the canvas viewport's bottom-right —
 * chrome-baseline mock `.viewport-toolbar` (finalized.html CSS 984-1008
 * + HTML 1260-1278).
 *
 * Four groups separated by 1px dividers (`.group + .group { border-left }`):
 *   1. Zoom: -  100%  +
 *   2. Fit / expand
 *   3. Grid snap / align
 *   4. Minimap toggle
 *
 * Notes:
 *   - This toolbar has NO viewport-lock button (the "lock" concept in
 *     breatic is space-level, surfaced only in the SpaceDrawer hover
 *     actions and the SpaceTab indicator — not a per-user view state).
 *   - 32px (`--btn-chrome`) hit areas, 6px chrome radius.
 *   - `bg-popover` elevated surface + `shadow` so it floats above the
 *     dot-grid canvas.
 */
export function ViewportToolbar({
  zoom,
  minimapVisible,
  snapToGrid,
  alignActive,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFit,
  onExpand,
  onToggleSnap,
  onToggleAlign,
  onToggleMinimap,
}: ViewportToolbarProps) {
  const t = useTranslation();
  return (
    <div
      data-testid='viewport-toolbar'
      role='toolbar'
      aria-label={t('viewportToolbar.aria')}
      className='absolute bottom-4 right-4 z-10 flex rounded-chrome border border-border bg-popover p-1 shadow'
    >
      <Group>
        <VtButton
          aria-label={t('viewportToolbar.zoomOut')}
          tooltip={t('viewportToolbar.zoomOut')}
          onClick={onZoomOut}
        >
          <Minus className='h-3.5 w-3.5' />
        </VtButton>
        <VtButton
          aria-label={t('viewportToolbar.zoomResetAria')}
          tooltip={t('viewportToolbar.zoomReset')}
          onClick={onZoomReset}
        >
          <span
            className='text-[11px] tabular-nums'
            data-testid='zoom-readout'
          >
            {Math.round(zoom * 100)}%
          </span>
        </VtButton>
        <VtButton
          aria-label={t('viewportToolbar.zoomIn')}
          tooltip={t('viewportToolbar.zoomIn')}
          onClick={onZoomIn}
        >
          <Plus className='h-3.5 w-3.5' />
        </VtButton>
      </Group>
      <Group>
        <VtButton
          aria-label={t('viewportToolbar.fitAria')}
          tooltip={t('viewportToolbar.fit')}
          onClick={onFit}
        >
          <Maximize2 className='h-3.5 w-3.5' />
        </VtButton>
        <VtButton
          aria-label={t('viewportToolbar.expand')}
          tooltip={t('viewportToolbar.expand')}
          onClick={onExpand}
        >
          <Expand className='h-3.5 w-3.5' />
        </VtButton>
      </Group>
      <Group>
        <VtButton
          aria-label={
            snapToGrid
              ? t('viewportToolbar.snap.off')
              : t('viewportToolbar.snap.on')
          }
          tooltip={t('viewportToolbar.snap.label')}
          onClick={onToggleSnap}
          aria-pressed={snapToGrid}
          active={snapToGrid}
        >
          <Grid3x3 className='h-3.5 w-3.5' />
        </VtButton>
        <VtButton
          aria-label={
            alignActive
              ? t('viewportToolbar.guides.off')
              : t('viewportToolbar.guides.on')
          }
          tooltip={t('viewportToolbar.guides.label')}
          onClick={onToggleAlign}
          aria-pressed={alignActive}
          active={alignActive}
        >
          <AlignCenterHorizontal className='h-3.5 w-3.5' />
        </VtButton>
      </Group>
      <Group last>
        <VtButton
          aria-label={
            minimapVisible
              ? t('viewportToolbar.minimap.hide')
              : t('viewportToolbar.minimap.show')
          }
          tooltip={t('viewportToolbar.minimap.label')}
          onClick={onToggleMinimap}
          aria-pressed={minimapVisible}
          active={minimapVisible}
        >
          <MinimapIcon className='h-3.5 w-3.5' />
        </VtButton>
      </Group>
    </div>
  );
}

function Group({
  children,
  last,
}: {
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 px-1',
        !last && 'border-r border-border',
      )}
    >
      {children}
    </div>
  );
}

interface VtButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
  active?: boolean;
}

function VtButton({ tooltip, active, children, ...rest }: VtButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          {...rest}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-chrome text-[13px] transition-colors',
            active
              ? 'bg-foreground text-background'
              : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side='top'>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
