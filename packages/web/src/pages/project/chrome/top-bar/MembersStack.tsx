import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

interface Member {
  id: string;
  name: string;
}

interface MembersStackProps {
  projectId: string;
  members?: ReadonlyArray<Member>;
}

const DEFAULT_MEMBERS: ReadonlyArray<Member> = [
  { id: 'me', name: 'You' },
];

/**
 * Stacked avatar group for the active project's members. Click opens a
 * popover that hosts the full members list + invite trigger (those land
 * in `pages/project/members/` in a later PR). For PR 4 we render up to 3
 * overlap avatars + an overflow chip; the popover body is a stub.
 */
export function MembersStack({
  projectId,
  members = DEFAULT_MEMBERS,
}: MembersStackProps) {
  const visible = members.slice(0, 3);
  const overflow = members.length - visible.length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          className='h-7 gap-0 px-1'
          aria-label='Project members'
          data-testid='members-trigger'
        >
          <div className='flex -space-x-1'>
            {visible.map((m) => (
              <Avatar
                key={m.id}
                className='h-6 w-6 border-2 border-background'
              >
                <AvatarFallback className='text-[10px]'>
                  {m.name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            ))}
          </div>
          {overflow > 0 ? (
            <span className='ml-1 text-xs text-muted-foreground'>
              +{overflow}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-64' data-testid='members-popover'>
        <div className='text-sm text-muted-foreground'>
          Members of project {projectId} (popover body coming in a later PR)
        </div>
      </PopoverContent>
    </Popover>
  );
}
