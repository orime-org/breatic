import type { SpaceBodyProps } from '@/spaces';

/**
 * Document space body — placeholder. The full TipTap editor + Yjs binding
 * lands in PR 12 (M2 milestone).
 */
export function DocumentSpace({ spaceId, projectId }: SpaceBodyProps) {
  return (
    <div
      data-testid='document-space'
      className='flex h-full w-full items-center justify-center bg-muted text-sm text-muted-foreground'
    >
      Document space (M2) · {projectId} / {spaceId}
    </div>
  );
}
