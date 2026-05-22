import {
  Grid3x3,
  Map as MinimapIcon,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  Undo2,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/use-translation';

interface ViewportToolbarProps {
  zoom: number;
  minimapVisible: boolean;
  snapToGrid: boolean;
  /**
   * Canvas history availability. Both default to `false` so the toolbar
   * renders the undo / redo buttons in their disabled state until a
   * future PR wires the canvas history engine (Yjs `UndoManager` or
   * equivalent). When that lands, drive these flags from the history
   * snapshot — the props surface is intentionally minimal so the
   * toolbar stays presentation-only.
   */
  canUndo?: boolean;
  canRedo?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFit: () => void;
  onToggleSnap: () => void;
  onToggleMinimap: () => void;
  /** Optional — wired when the history engine lands. */
  onUndo?: () => void;
  /** Optional — wired when the history engine lands. */
  onRedo?: () => void;
}

/**
 * Floating overlay sitting in the canvas viewport's bottom-right.
 *
 * Eight buttons in four groups separated by 1px dividers:
 *   1. History:  ↶ undo  ↷ redo
 *   2. Zoom:     -  100%  +
 *   3. Fit:      ⤢ fit
 *   4. View aux: ▦ snap-to-grid   ▤ minimap
 *
 * Notes:
 *   - History buttons render but stay disabled until the canvas undo
 *     engine is wired (props default `canUndo` / `canRedo` to `false`,
 *     and `onUndo` / `onRedo` are optional). Source comment + the
 *     button's disabled visual state document this placeholder status.
 *   - 32px (`--btn-chrome`) hit areas, 6px chrome radius.
 *   - `bg-popover` elevated surface + `shadow` so it floats above the
 *     dot-grid canvas.
 *   - No viewport-lock button (lock is space-level, surfaced in the
 *     SpaceDrawer hover actions and SpaceTab indicator).
 */
export function ViewportToolbar({
  zoom,
  minimapVisible,
  snapToGrid,
  canUndo = false,
  canRedo = false,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFit,
  onToggleSnap,
  onToggleMinimap,
  onUndo,
  onRedo,
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
          aria-label={t('viewportToolbar.undo')}
          tooltip={t('viewportToolbar.undo')}
          onClick={onUndo}
          disabled={!canUndo}
        >
          <Undo2 className='h-3.5 w-3.5' />
        </VtButton>
        <VtButton
          aria-label={t('viewportToolbar.redo')}
          tooltip={t('viewportToolbar.redo')}
          onClick={onRedo}
          disabled={!canRedo}
        >
          <Redo2 className='h-3.5 w-3.5' />
        </VtButton>
      </Group>
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
      </Group>
      <Group last>
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

function VtButton({
  tooltip,
  active,
  disabled,
  children,
  ...rest
}: VtButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          {...rest}
          disabled={disabled}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-chrome text-[13px] transition-colors',
            disabled
              ? 'cursor-not-allowed bg-transparent text-muted-foreground/40'
              : active
                ? 'bg-foreground text-background'
                : 'bg-transparent text-muted-foreground hover:bg-chrome-hover hover:text-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side='top'>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
