import type { SpaceBodyProps } from '@/spaces';

/**
 * Canvas space body — placeholder for PR 4. The full ReactFlow + Yjs
 * binding + node toolbar + reference chips wiring lands in later PRs
 * (PR 5: shared atoms; PR 6: typed nodes; PR 7: toolbar; PR 8: annotation).
 *
 * For now this is the structural slot the SpaceOutlet renders so the chrome
 * layer (top-bar / tab-bar / left-menu / viewport-toolbar) has a body to
 * frame.
 */
export function CanvasSpace({ spaceId, projectId }: SpaceBodyProps) {
  return (
    <div
      data-testid='canvas-space'
      className='relative flex h-full w-full items-center justify-center bg-muted text-sm text-muted-foreground'
    >
      <div className='text-center'>
        <div>Canvas space</div>
        <div className='mt-1 text-xs opacity-60'>
          project {projectId} · space {spaceId}
        </div>
      </div>
    </div>
  );
}
