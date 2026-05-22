import {
  Box,
  Clock,
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  LayoutGrid,
  Lock,
  Music,
  Palette,
  Type,
  Video,
  X,
} from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';
import type { SpaceType } from '@/spaces';

interface SpaceTabProps {
  id: string;
  name: string;
  type: SpaceType;
  active: boolean;
  locked?: boolean;
  onActivate: () => void;
  onClose?: () => void;
}

const TYPE_ICON: Record<SpaceType, typeof FileText> = {
  canvas: Palette,
  document: FileText,
  timeline: Clock,
};

const NODE_KIND_ICON: Partial<Record<string, typeof FileText>> = {
  text: Type,
  image: ImageIcon,
  audio: Music,
  video: Video,
  '3d': Box,
  web: Globe,
  layers: LayoutGrid,
  film: Film,
};

/**
 * Single space tab — chrome-baseline mock `.space-tab`.
 *
 * Layout (mock spec):
 *   [type-icon] [name] [optional lock-icon] [hover-revealed × close]
 *
 * - 32px hit area (`--btn-chrome`)
 * - rounded 4px (ground truth specifies sm radius, not chrome 6px)
 * - muted color at rest; foreground + neutral-100 bg on hover/active
 * - close button fades in on hover; hidden when locked
 */
export function SpaceTab({
  id,
  name,
  type,
  active,
  locked,
  onActivate,
  onClose,
}: SpaceTabProps) {
  const Icon = TYPE_ICON[type] ?? NODE_KIND_ICON.film ?? FileText;

  const onCloseClick: React.MouseEventHandler<HTMLSpanElement> = (e) => {
    e.stopPropagation();
    onClose?.();
  };

  return (
    <button
      type='button'
      role='tab'
      aria-selected={active}
      onClick={onActivate}
      data-testid={`space-tab-${id}`}
      className={cn(
        'group inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border-0 text-[13px]',
        active
          ? 'bg-muted text-foreground'
          : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      style={{
        height: 'var(--btn-chrome)',
        padding: '0 var(--space-4)',
        gap: 'var(--space-3)',
        borderRadius: 4,
      }}
    >
      <Icon
        className='shrink-0 text-muted-foreground'
        style={{ width: 14, height: 14 }}
        aria-hidden='true'
      />
      <span>{name}</span>
      {locked ? (
        <Lock
          className='shrink-0 text-muted-foreground'
          style={{ width: 10, height: 10, opacity: 0.5, strokeWidth: 1.5 }}
          aria-label='Locked'
        />
      ) : null}
      {onClose ? (
        // Span (not button) because the outer SpaceTab is itself a
        // <button>, and button-in-button is invalid HTML — browsers
        // silently reparent it (see [[feedback_html_validity_check]]).
        // The span manually replicates button semantics via role +
        // tabIndex + onClick + onKeyDown so keyboard users can still
        // close the tab.
        <span
          role='button'
          tabIndex={0}
          aria-label='Close space tab'
          onClick={onCloseClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onClose?.();
            }
          }}
          data-testid={`space-tab-close-${id}`}
          className='ml-[2px] inline-flex h-4 w-4 items-center justify-center rounded-[4px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100'
        >
          <X style={{ width: 12, height: 12 }} />
        </span>
      ) : null}
    </button>
  );
}
