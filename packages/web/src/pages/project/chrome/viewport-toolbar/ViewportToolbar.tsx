import { Lock, LockOpen, Map as MinimapIcon, Maximize, Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ViewportToolbarProps {
  zoom: number;
  locked: boolean;
  minimapVisible: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onToggleLock: () => void;
  onToggleMinimap: () => void;
}

/**
 * Floating overlay sitting in the canvas viewport's bottom-right:
 *   zoom out · zoom % · zoom in · fit-to-view · lock toggle · minimap toggle
 *
 * State is owned by the canvas slice of the global state machinery (not
 * Yjs — these are per-user view settings).
 */
export function ViewportToolbar({
  zoom,
  locked,
  minimapVisible,
  onZoomIn,
  onZoomOut,
  onFit,
  onToggleLock,
  onToggleMinimap,
}: ViewportToolbarProps) {
  return (
    <div
      data-testid='viewport-toolbar'
      className='absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-chrome border border-border bg-popover p-1 shadow-sm'
    >
      <Button variant='chrome-ghost' size='chrome' aria-label='Zoom out' onClick={onZoomOut}>
        <Minus className='h-[18px] w-[18px]' />
      </Button>
      <span
        className='min-w-[3.5rem] text-center text-xs tabular-nums text-muted-foreground'
        data-testid='zoom-readout'
      >
        {Math.round(zoom * 100)}%
      </span>
      <Button variant='chrome-ghost' size='chrome' aria-label='Zoom in' onClick={onZoomIn}>
        <Plus className='h-[18px] w-[18px]' />
      </Button>
      <Button variant='chrome-ghost' size='chrome' aria-label='Fit to view' onClick={onFit}>
        <Maximize className='h-[18px] w-[18px]' />
      </Button>
      <Button
        variant='chrome-ghost'
        size='chrome'
        aria-label={locked ? 'Unlock viewport' : 'Lock viewport'}
        aria-pressed={locked}
        onClick={onToggleLock}
      >
        {locked ? <Lock className='h-[18px] w-[18px]' /> : <LockOpen className='h-[18px] w-[18px]' />}
      </Button>
      <Button
        variant={minimapVisible ? 'secondary' : 'chrome-ghost'}
        size='chrome'
        aria-label={minimapVisible ? 'Hide minimap' : 'Show minimap'}
        aria-pressed={minimapVisible}
        onClick={onToggleMinimap}
      >
        <MinimapIcon className='h-[18px] w-[18px]' />
      </Button>
    </div>
  );
}
