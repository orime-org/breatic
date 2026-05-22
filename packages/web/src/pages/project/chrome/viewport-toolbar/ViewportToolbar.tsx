import * as React from 'react';
import {
  Grid3x3,
  Minus,
  PictureInPicture2 as MinimapIcon,
  Plus,
  Redo2,
  Scan,
  Undo2,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/use-translation';

/** Hard limits on canvas zoom (matches ReactFlow defaults: 0.1 – 4). */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const ZOOM_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

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
  /** Apply an arbitrary zoom (popover preset / custom input). */
  onZoomChange: (zoom: number) => void;
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
  onZoomChange,
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
        <ZoomMenu zoom={zoom} onZoomChange={onZoomChange} />
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
          {/* Scan = four corner brackets, semantically "frame everything"
              — read as "fit all nodes into the viewport" (ReactFlow
              fitView). The previous Maximize2 (four outward arrows)
              read as "expand / fullscreen" which conflicts with the
              actual action. */}
          <Scan className='h-3.5 w-3.5' />
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
                : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side='top'>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

interface ZoomMenuProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

/**
 * Zoom readout + popover with preset shortcuts and a custom input.
 *
 * Click the readout → popover opens with six preset rows
 * (25/50/100/150/200/400%) and a custom-value input. Picking a preset
 * or pressing Enter on the input applies the zoom and closes the
 * popover; the value is clamped to [10%, 400%]. Input accepts
 * `"150"` or `"150%"`.
 *
 * Every preset (including 100%) goes through the same `apply` path —
 * there is no "reset" specialcase. "Going back to 100%" is just
 * applying the 100% preset; treating it differently was the source of
 * a missing-close bug in the first cut.
 *
 * Zoom is currently a ProjectPage local state placeholder — when
 * ReactFlow integration lands, `onZoomChange` should drive the
 * `setViewport` API and `zoom` should read back from it.
 */
function ZoomMenu({ zoom, onZoomChange }: ZoomMenuProps) {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  // Seed the draft with the current zoom each time the popover opens.
  // No focus race here — the `<input autoFocus>` handles focus, and
  // we deliberately do not auto-select() so a `user.type()` test can
  // append characters without fighting an asynchronous selection.
  React.useEffect(() => {
    if (open) setDraft(String(Math.round(zoom * 100)));
  }, [open, zoom]);

  const apply = (next: number) => {
    const clamped = Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX);
    onZoomChange(clamped);
    setOpen(false);
  };

  const applyDraft = () => {
    const parsed = Number.parseFloat(draft.replace('%', '').trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      apply(parsed / 100);
    } else {
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type='button'
              aria-label={t('viewportToolbar.zoomResetAria')}
              data-testid='zoom-readout-trigger'
              className='inline-flex h-8 w-12 shrink-0 items-center justify-center rounded-chrome bg-transparent text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
            >
              <span data-testid='zoom-readout'>{Math.round(zoom * 100)}%</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='top'>
          {t('viewportToolbar.zoomReset')}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align='center'
        side='top'
        sideOffset={8}
        className='w-36 p-1'
        data-testid='zoom-menu'
      >
        <div className='flex flex-col gap-0.5'>
          {ZOOM_PRESETS.map((preset) => {
            const isCurrent = Math.abs(preset - zoom) < 0.001;
            const label = `${Math.round(preset * 100)}%`;
            return (
              <button
                key={preset}
                type='button'
                onClick={() => apply(preset)}
                data-testid={`zoom-preset-${Math.round(preset * 100)}`}
                className={cn(
                  'inline-flex h-7 items-center justify-start rounded-chrome px-2 text-[12px] transition-colors',
                  isCurrent
                    ? 'bg-secondary text-secondary-foreground'
                    : 'bg-transparent text-foreground hover:bg-accent',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className='my-1 h-px bg-border' />
        <div className='flex items-center gap-1 px-1 py-1'>
          <input
            autoFocus
            type='text'
            inputMode='numeric'
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyDraft();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
            aria-label={t('viewportToolbar.zoomCustomAria')}
            placeholder='100'
            data-testid='zoom-custom-input'
            className='h-7 w-full rounded-chrome border border-border bg-transparent px-2 text-[12px] tabular-nums text-foreground outline-none transition-colors focus-visible:border-foreground'
          />
          <span className='text-[12px] text-muted-foreground'>%</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
