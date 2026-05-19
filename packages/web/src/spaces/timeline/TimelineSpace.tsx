import type { SpaceBodyProps } from '@/spaces';

/**
 * Timeline space body — placeholder. Real implementation arrives in M3+
 * (V1 was removed; rebuild on canvas-native primitives later).
 */
export function TimelineSpace({ spaceId, projectId }: SpaceBodyProps) {
  return (
    <div
      data-testid='timeline-space'
      className='flex h-full w-full items-center justify-center bg-muted text-sm text-muted-foreground'
    >
      Timeline space (M3+) · {projectId} / {spaceId}
    </div>
  );
}
