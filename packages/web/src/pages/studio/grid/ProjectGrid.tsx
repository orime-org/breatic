import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { projectsApi } from '@/data/api';
import type { ProjectSummary } from '@/data/api/projects';
import { useTranslation } from '@/i18n/use-translation';
import { useExclusiveOverlay } from '@/lib/use-exclusive-overlay';
import { useStudioStore } from '@/stores';

import { NewProjectCard } from '@/pages/studio/grid/NewProjectCard';
import { NewProjectDialog, type SpaceTemplate } from '@/pages/studio/grid/NewProjectDialog';
import { ProjectCard } from '@/pages/studio/grid/ProjectCard';

/**
 * Studio project grid — list of project cards + create entry tile.
 *
 * Reads project list from `projectsApi.list` via React Query so:
 *   - SWR caching avoids re-fetch on quick navigation
 *   - create mutation invalidates the list so the new project appears
 *     when the user comes back from `/project/:id`
 *   - filter / sort run client-side on whatever the server returned
 */
export function ProjectGrid() {
  const t = useTranslation();
  const search = useStudioStore((s) => s.search);
  const sortKey = useStudioStore((s) => s.sortKey);
  const sortOrder = useStudioStore((s) => s.sortOrder);
  const setSearch = useStudioStore((s) => s.setSearch);

  const [dialogOpen, setDialogOpen] = useExclusiveOverlay('new-project-dialog');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: ['projects', 'list'],
    queryFn: () => projectsApi.list({}),
  });

  const createMutation = useMutation({
    mutationFn: ({ name, template }: { name: string; template: SpaceTemplate }) =>
      projectsApi.create({ name, templateId: template }),
    onSuccess: (project) => {
      // Invalidate so when the user returns to `/studio` the list reflects
      // the new project (without this, the cached list misses it until
      // staleTime expires).
      queryClient.invalidateQueries({ queryKey: ['projects', 'list'] });
      setDialogOpen(false);
      navigate(`/project/${project.id}`);
    },
    onError: (err) => {
      const reason = err instanceof Error ? err.message : 'unknown';
      // Single-line toast (no title+description stack) per 2026-05-26 user
      // ask — vertical stack felt heavy in the studio grid. Reason
      // string is interpolated via ICU `{reason}` (single curly per
      // [[feedback_icu_handlebars_brace_mismatch]]).
      toast.error(t('studio.createProject.failed', { reason }));
    },
  });

  const visible = React.useMemo(() => {
    const all: ProjectSummary[] = projectsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q ? all.filter((p) => p.name.toLowerCase().includes(q)) : [...all];
    filtered.sort((a, b) => {
      const cmp =
        sortKey === 'name'
          ? a.name.localeCompare(b.name)
          : new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    return filtered;
  }, [projectsQuery.data, search, sortKey, sortOrder]);

  return (
    <div className='mx-auto flex max-w-6xl flex-col gap-4'>
      <header className='flex items-center justify-between gap-4'>
        <div>
          <h1 className='text-xl font-semibold'>Projects</h1>
          <p className='text-sm text-muted-foreground'>
            {projectsQuery.isLoading
              ? 'Loading…'
              : `${visible.length} project${visible.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <input
          type='search'
          placeholder='Search…'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='h-9 w-64 rounded-chrome border border-input bg-transparent px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        />
      </header>

      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
        <NewProjectCard onClick={() => setDialogOpen(true)} />
        {visible.map((p) => (
          // Personal-studio v1 → every project is owner. When the list
          // endpoint returns per-row role we'll pass `p.role` instead.
          // eslint-disable-next-line jsx-a11y/aria-role -- `role` here is a ProjectCard component prop, not a DOM ARIA role
          <ProjectCard key={p.id} project={p} role='owner' />
        ))}
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={(args) => createMutation.mutate(args)}
      />
    </div>
  );
}
