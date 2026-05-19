import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import type { ProjectRole } from '@/stores';

export interface ProjectSummary {
  id: string;
  name: string;
  thumbnailUrl?: string;
  role: ProjectRole;
  updatedAt: string;
}

interface ProjectCardProps {
  project: ProjectSummary;
}

const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: 'Owner',
  edit: 'Edit',
  view: 'View',
};

/**
 * Project card — single project tile in the studio grid.
 *
 * Links to `/project/:id`. Header strip shows thumbnail (or a tinted
 * placeholder); footer shows name + role badge + relative updated time.
 */
export function ProjectCard({ project }: ProjectCardProps) {
  return (
    <Link
      to={`/project/${project.id}`}
      className='group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground transition-colors hover:border-neutral-300'
      aria-label={`Open project ${project.name}`}
    >
      <div className='aspect-video w-full bg-muted'>
        {project.thumbnailUrl ? (
          <img
            src={project.thumbnailUrl}
            alt=''
            className='h-full w-full object-cover'
            loading='lazy'
          />
        ) : null}
      </div>
      <div className='flex items-start justify-between gap-2 p-3'>
        <div className='min-w-0'>
          <div className='truncate text-sm font-medium'>{project.name}</div>
          <div className='mt-1 text-xs text-muted-foreground'>
            {formatRelative(project.updatedAt)}
          </div>
        </div>
        <Badge variant='outline' className='shrink-0'>
          {ROLE_LABEL[project.role]}
        </Badge>
      </div>
    </Link>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}
