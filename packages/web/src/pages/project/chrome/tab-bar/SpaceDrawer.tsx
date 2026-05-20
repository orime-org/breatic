import { Menu } from 'lucide-react';
import * as React from 'react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type { ProjectSpace } from '@/data/yjs/project-meta';

interface SpaceDrawerProps {
  spaces: ReadonlyArray<ProjectSpace>;
  activeSpaceId: string;
  onActivate: (id: string) => void;
}

/**
 * "All Spaces" drawer — right-side sheet listing every space.
 *
 * Visible button in `.space-header-right` (mock spec). Useful when the
 * tabs row overflows and the user wants to jump to a specific space
 * without scrolling.
 */
export function SpaceDrawer({
  spaces,
  activeSpaceId,
  onActivate,
}: SpaceDrawerProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label='All spaces'
          data-testid='space-drawer-trigger'
          style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
        >
          <Menu className='h-[18px] w-[18px]' />
        </Button>
      </SheetTrigger>
      <SheetContent
        side='right'
        className='w-80'
        data-testid='space-drawer'
      >
        <SheetHeader>
          <SheetTitle>All spaces</SheetTitle>
          <SheetDescription>
            {spaces.length} space{spaces.length === 1 ? '' : 's'}
          </SheetDescription>
        </SheetHeader>
        <div className='mt-3 flex flex-col gap-1'>
          {spaces.map((s) => (
            <button
              key={s.id}
              type='button'
              onClick={() => {
                onActivate(s.id);
                setOpen(false);
              }}
              data-testid={`space-drawer-item-${s.id}`}
              className={`rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                s.id === activeSpaceId ? 'bg-muted font-medium' : ''
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
