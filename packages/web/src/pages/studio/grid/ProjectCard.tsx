import type * as React from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '@web/components/ui/badge';
import type { ProjectSummary } from '@web/data/api/projects';
import type { ProjectRole } from '@web/stores';

interface ProjectCardProps {
  project: ProjectSummary;
  /**
   * Caller's role on this project. Passed separately because the
   * list endpoint (`GET /api/v1/projects`) does not currently return
   * per-row role. Personal-studio v1 → owner everywhere.
   */
  role: ProjectRole;
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
 * @param root0 - component props
 * @param root0.project - the project summary to render in the tile
 * @param root0.role - the caller's role on this project, shown as a badge
 * @returns a clickable project tile linking to the project page.
 */
export function ProjectCard({ project, role }: ProjectCardProps): React.JSX.Element {
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
          {ROLE_LABEL[role]}
        </Badge>
      </div>
    </Link>
  );
}

/**
 * Format an ISO timestamp as a short relative string ("5m ago", "3h ago",
 * "2d ago"), falling back to a locale date beyond 30 days or for invalid input.
 * @param iso - the ISO-8601 timestamp to format
 * @returns the relative-time label, or the original string if it is not a valid date
 */
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
