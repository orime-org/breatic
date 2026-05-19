import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SPACE_TYPES, type SpaceType } from '@/spaces';
import { useUIStore } from '@/stores';
import { NewSpaceDialog } from './NewSpaceDialog';

export interface SpaceTabSummary {
  id: string;
  name: string;
  type: SpaceType;
}

interface SpaceTabBarProps {
  spaces: ReadonlyArray<SpaceTabSummary>;
  activeSpaceId: string;
  onActivate: (id: string) => void;
  onCreate: (type: SpaceType, name: string) => void;
}

/**
 * Project tab bar — shows the project's active spaces left-to-right.
 *   AgentToggle (◧) · ScrollArrow ← · SpaceTab list · NewSpaceButton (+)
 *
 * Lives directly under the TopBar. The Agent column visibility toggle
 * lives here so users can collapse the chat column without leaving the
 * project.
 */
export function SpaceTabBar({
  spaces,
  activeSpaceId,
  onActivate,
  onCreate,
}: SpaceTabBarProps) {
  const collapsed = useUIStore((s) => s.chatPanelCollapsed);
  const toggleAgent = useUIStore((s) => s.toggleChatPanel);
  const agentOpen = !collapsed;
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  const scrollBy = (delta: number) => {
    scrollerRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  return (
    <div
      data-testid='space-tab-bar'
      className='flex h-10 items-center gap-1 border-b border-border bg-background px-2'
    >
      <Button
        variant='ghost'
        size='icon'
        aria-label={agentOpen ? 'Hide agent column' : 'Show agent column'}
        aria-pressed={agentOpen}
        onClick={toggleAgent}
        data-testid='agent-toggle'
      >
        <span className='font-mono text-sm'>◧</span>
      </Button>
      <Button
        variant='ghost'
        size='icon'
        aria-label='Scroll tabs left'
        onClick={() => scrollBy(-120)}
      >
        <ChevronLeft className='h-4 w-4' />
      </Button>
      <ScrollArea className='flex-1'>
        <div ref={scrollerRef} className='flex items-center gap-1 py-1'>
          {spaces.map((s) => {
            const def = SPACE_TYPES[s.type];
            const active = s.id === activeSpaceId;
            return (
              <button
                key={s.id}
                type='button'
                onClick={() => onActivate(s.id)}
                className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs ${
                  active
                    ? 'border-border bg-secondary text-secondary-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted'
                }`}
                data-testid={`space-tab-${s.id}`}
              >
                <span className='opacity-70'>{def?.label?.[0] ?? '·'}</span>
                <span className='max-w-[120px] truncate'>{s.name}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
      <Button
        variant='ghost'
        size='icon'
        aria-label='Scroll tabs right'
        onClick={() => scrollBy(120)}
      >
        <ChevronRight className='h-4 w-4' />
      </Button>
      <NewSpaceDialog
        onCreate={onCreate}
        trigger={
          <Button
            variant='ghost'
            size='icon'
            aria-label='New space'
            data-testid='new-space-button'
          >
            <Plus className='h-4 w-4' />
          </Button>
        }
      />
    </div>
  );
}
