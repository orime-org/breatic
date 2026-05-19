import {
  Brush,
  Image as ImageIcon,
  Layers,
  Pencil,
  StickyNote,
  Type,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type LeftMenuTool =
  | 'select'
  | 'text'
  | 'image'
  | 'draw'
  | 'sticky'
  | 'layers';

interface LeftFloatingMenuProps {
  active?: LeftMenuTool;
  onPick: (tool: LeftMenuTool) => void;
}

const ITEMS: Array<{
  id: LeftMenuTool;
  icon: typeof Pencil;
  label: string;
}> = [
  { id: 'select', icon: Pencil, label: 'Select' },
  { id: 'text', icon: Type, label: 'Add text' },
  { id: 'image', icon: ImageIcon, label: 'Add image' },
  { id: 'draw', icon: Brush, label: 'Draw' },
  { id: 'sticky', icon: StickyNote, label: 'Annotation' },
  { id: 'layers', icon: Layers, label: 'Layers' },
];

/**
 * Floating left menu over the canvas — 6 quick-access tools. The toolbar
 * floats absolutely so it overlays the canvas viewport. Tool selection is
 * pushed up via `onPick`; the canvas decides what each tool does.
 */
export function LeftFloatingMenu({ active, onPick }: LeftFloatingMenuProps) {
  return (
    <nav
      aria-label='Canvas tools'
      data-testid='left-floating-menu'
      className='absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-lg border border-border bg-background p-1 shadow-sm'
    >
      {ITEMS.map((it) => {
        const Icon = it.icon;
        const isActive = it.id === active;
        return (
          <Tooltip key={it.id}>
            <TooltipTrigger asChild>
              <Button
                variant={isActive ? 'secondary' : 'ghost'}
                size='icon'
                aria-label={it.label}
                aria-pressed={isActive}
                onClick={() => onPick(it.id)}
                data-testid={`tool-${it.id}`}
              >
                <Icon className='h-4 w-4' />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='right'>{it.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
