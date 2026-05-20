import * as React from 'react';

import { useStudioStore } from '@/stores';

import { NewProjectCard } from '@/pages/studio/grid/NewProjectCard';
import { NewProjectDialog, type SpaceTemplate } from '@/pages/studio/grid/NewProjectDialog';
import { ProjectCard, type ProjectSummary } from '@/pages/studio/grid/ProjectCard';

// Placeholder data until `data/api/projects` is wired (later PR).
const DEMO_PROJECTS: ProjectSummary[] = [
  {
    id: 'demo-1',
    name: 'Cyberpunk Concept',
    role: 'owner',
    updatedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: 'demo-2',
    name: 'BGM Exploration',
    role: 'edit',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
  },
  {
    id: 'demo-3',
    name: 'Trailer v2',
    role: 'view',
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
  },
];

/**
 * Studio project grid — list of project cards + create entry tile.
 *
 * V1 reads search / sort filters from `useStudioStore` and filters the
 * demo project array client-side. When the API layer arrives, swap
 * `DEMO_PROJECTS` for the React Query result; filter logic stays.
 */
export function ProjectGrid() {
  const search = useStudioStore((s) => s.search);
  const sortKey = useStudioStore((s) => s.sortKey);
  const sortOrder = useStudioStore((s) => s.sortOrder);
  const setSearch = useStudioStore((s) => s.setSearch);

  const [dialogOpen, setDialogOpen] = React.useState(false);

  const visible = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? DEMO_PROJECTS.filter((p) => p.name.toLowerCase().includes(q))
      : [...DEMO_PROJECTS];
    filtered.sort((a, b) => {
      const cmp =
        sortKey === 'name'
          ? a.name.localeCompare(b.name)
          : new Date(a.updatedAt).getTime() -
            new Date(b.updatedAt).getTime();
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    return filtered;
  }, [search, sortKey, sortOrder]);

  return (
    <div className='mx-auto flex max-w-6xl flex-col gap-4'>
      <header className='flex items-center justify-between gap-4'>
        <div>
          <h1 className='text-xl font-semibold'>Projects</h1>
          <p className='text-sm text-muted-foreground'>
            {visible.length} project{visible.length === 1 ? '' : 's'}
          </p>
        </div>
        <input
          type='search'
          placeholder='Search…'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='h-9 w-64 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        />
      </header>

      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
        <NewProjectCard onClick={() => setDialogOpen(true)} />
        {visible.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={({ name, template }: { name: string; template: SpaceTemplate }) => {
          // Placeholder until API layer lands; just log so the action is
          // visible during dev. Later PRs will call data/api/projects.create
          // and navigate to /project/<newId>.
          // eslint-disable-next-line no-console
          console.info('[studio] create project', { name, template });
        }}
      />
    </div>
  );
}
