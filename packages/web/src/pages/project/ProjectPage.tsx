import { useParams } from 'react-router-dom';

/**
 * Project page placeholder — chrome (TopBar / TabBar / LeftFloatingMenu /
 * ViewportToolbar) + 2-column layout (Agent 320 + Space flex) + Canvas /
 * Document / Timeline space body arrive in PR 4 + PR 5+.
 *
 * Route resolves with the projectId param so deep links work; the body is
 * minimal scaffolding for now.
 */
export default function ProjectPage() {
  const { projectId, spaceId } = useParams<{
    projectId: string;
    spaceId?: string;
  }>();
  return (
    <main className='flex min-h-screen flex-col items-center justify-center gap-2 bg-background p-6 text-foreground'>
      <h1 className='text-xl font-semibold'>Project</h1>
      <p className='text-sm text-muted-foreground'>
        id: <code>{projectId}</code>
        {spaceId ? (
          <>
            {' '}
            · space: <code>{spaceId}</code>
          </>
        ) : null}
      </p>
      <p className='text-xs text-muted-foreground'>
        Chrome + canvas arrive in upcoming PRs.
      </p>
    </main>
  );
}
