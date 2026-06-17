// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import { toast } from 'sonner';

import { SPACE_NAME_MAX_LEN } from '@breatic/shared';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import type { SpaceType } from '@web/spaces';

interface SpaceTabProps {
  id: string;
  name: string;
  type: SpaceType;
  active: boolean;
  locked?: boolean;
  onActivate: () => void;
  onClose?: () => void;
  /**
   * Commit a new name for this Space. Double-click on the tab
   * enters inline edit; Enter / blur commits via this callback;
   * Esc cancels (no callback). When the Space is locked, double-
   * click instead raises a toast and does NOT enter edit mode.
   */
  onRename?: (name: string) => Promise<void> | void;
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
 * - muted-foreground at rest; active + hover both lift to bg-accent
 * - close button fades in on hover; hidden when locked
 * @param root0 - Component props.
 * @param root0.id - Space id, used for the tab's test ids and keys.
 * @param root0.name - Current space name shown on the tab.
 * @param root0.type - Space type, selecting the leading type icon.
 * @param root0.active - Whether this tab is the active one.
 * @param root0.locked - Whether the space is locked (shows a lock icon, blocks inline rename and close).
 * @param root0.onActivate - Activates this tab when clicked.
 * @param root0.onClose - Closes this tab; when omitted, no close affordance is shown.
 * @param root0.onRename - Commits a new name after inline edit; when omitted, double-click rename is disabled.
 * @returns The single space tab button with icon, name (or inline name editor), optional lock icon, and close affordance.
 */
export function SpaceTab({
  id,
  name,
  type,
  active,
  locked,
  onActivate,
  onClose,
  onRename,
}: SpaceTabProps): React.JSX.Element {
  const t = useTranslation();
  const Icon = TYPE_ICON[type] ?? NODE_KIND_ICON.film ?? FileText;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Keep `draft` aligned with external `name` updates (collab broadcast)
  // when we are not currently editing.
  React.useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  /**
   * Stops propagation and invokes `onClose` for the close affordance.
   * @param e - The mouse event from the close span.
   */
  const onCloseClick: React.MouseEventHandler<HTMLSpanElement> = (e) => {
    e.stopPropagation();
    onClose?.();
  };

  /**
   * Enters inline name edit on double-click, or toasts when the space is locked.
   * @param e - The mouse event from the name span.
   */
  const onNameDoubleClick: React.MouseEventHandler<HTMLSpanElement> = (e) => {
    if (!onRename) return;
    e.stopPropagation();
    e.preventDefault();
    if (locked) {
      toast(t('spaces.rename.locked'));
      return;
    }
    setDraft(name);
    setEditing(true);
  };

  /**
   * Leaves edit mode and commits the trimmed draft name via `onRename`
   * unless it is empty or unchanged.
   */
  const commit = (): void => {
    const trimmed = draft.trim().slice(0, SPACE_NAME_MAX_LEN);
    setEditing(false);
    if (trimmed.length === 0 || trimmed === name) {
      setDraft(name);
      return;
    }
    void Promise.resolve(onRename?.(trimmed)).catch(() => {
      // toast already raised by callRpc in ProjectPage
    });
  };

  /**
   * Leaves edit mode and discards the draft, restoring the current name.
   */
  const cancel = (): void => {
    setEditing(false);
    setDraft(name);
  };

  return (
    <button
      type='button'
      role='tab'
      aria-selected={active}
      onClick={editing ? undefined : onActivate}
      data-testid={`space-tab-${id}`}
      className={cn(
        'group inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border-0 text-sm',
        active
          ? 'bg-accent text-foreground'
          : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
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
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={SPACE_NAME_MAX_LEN}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          data-testid={`space-tab-name-input-${id}`}
          aria-label={t('spaces.rename.inputAriaLabel')}
          className='border-0 bg-transparent p-0 text-sm text-foreground outline-none'
          style={{ width: `${Math.max(draft.length, 1) + 1}ch` }}
        />
      ) : (
        <span
          onDoubleClick={onNameDoubleClick}
          data-testid={`space-tab-name-${id}`}
        >
          {name}
        </span>
      )}
      {locked ? (
        <Lock
          className='shrink-0 text-muted-foreground'
          style={{ width: 10, height: 10, opacity: 0.5, strokeWidth: 1.5 }}
          aria-label={t('spaces.lockedAria')}
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
          aria-label={t('spaces.tab.closeAria')}
          onClick={onCloseClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onClose?.();
            }
          }}
          data-testid={`space-tab-close-${id}`}
          className='ml-[2px] inline-flex h-4 w-4 items-center justify-center rounded-chrome text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100'
        >
          <X style={{ width: 12, height: 12 }} />
        </span>
      ) : null}
    </button>
  );
}
