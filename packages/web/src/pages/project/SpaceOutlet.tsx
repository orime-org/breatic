import { SPACE_TYPES, type SpaceType } from '@web/spaces';

interface SpaceOutletProps {
  projectId: string;
  spaceId: string;
  type: SpaceType;
}

/**
 * Generic body renderer — looks up the active space's `bodyComponent`
 * from the `SPACE_TYPES` registry and renders it. New space types only
 * have to register themselves; this outlet does not need to change.
 */
export function SpaceOutlet({ projectId, spaceId, type }: SpaceOutletProps) {
  const def = SPACE_TYPES[type];
  if (!def) {
    return (
      <div
        data-testid='space-outlet-unknown'
        className='flex h-full w-full items-center justify-center text-sm text-destructive'
      >
        Unknown space type: {type}
      </div>
    );
  }
  const Body = def.bodyComponent;
  return <Body projectId={projectId} spaceId={spaceId} />;
}
