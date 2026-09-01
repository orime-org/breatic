// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { useSortable } from '@dnd-kit/sortable';
import { toast } from '@web/lib/toast';

import { SPACE_NAME_MAX_LEN } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import type { SpaceType } from '@web/spaces';
import { useUIStore } from '@web/stores/ui';

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

/**
 * How wide one tab may get (px).
 *
 * A name may run to `SPACE_NAME_MAX_LEN`, and the strip scrolls sideways, so
 * without a cap one long name takes the whole visible width and pushes every
 * other tab behind the scroll arrows. What the name is left with on a tab that
 * has reached the cap, measured in Chrome at 13px: 100px on every tab, current
 * or not, and 84px once a Space is locked and the lock icon joins the row —
 * about seven CJK characters or fourteen Latin ones, six and eleven when
 * locked (user set 160 on 2026-08-28, #2015).
 *
 * The cap is a width and not a character count because a full-width character
 * is about as wide as the font size while a Latin one is about half that: the
 * same count would render a Chinese tab close to twice the width of an English
 * one, which is the crowding this exists to stop.
 */
export const SPACE_TAB_MAX_WIDTH = 160;

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
 * - muted-foreground at rest; hover lifts to bg-accent and the current tab
 *   sits one step further at bg-accent-strong
 * - close button takes room and fades in on hover; hidden when locked
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
  // The comparison sits inside the selector so a tab subscribes to a boolean
  // and zustand bails out of every re-render where that boolean holds.
  const spaceRegionActive = useUIStore((s) => s.activeRegion === 'space');
  const Icon = TYPE_ICON[type] ?? NODE_KIND_ICON.film ?? FileText;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [nameTipOpen, setNameTipOpen] = React.useState(false);

  // `attributes` is left on the floor on purpose. Nothing in it carries the
  // drag — that is `listeners` — and what it does carry describes a keyboard
  // gesture this strip does not offer: `role='button'` and `tabIndex=0` would
  // rename the tab out of its tablist, and `aria-roledescription='sortable'`
  // would announce a reorder to the one group of people who cannot perform it
  // (design §4.5: pointer only).
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id, disabled: editing });

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
      toast.warning(t('spaces.rename.locked'));
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

  const tab = (
    <Button
      // A tab strip, not a standalone labelled button: the active fill is the
      // affordance, and `menu-item` is the one size that leaves the tab's own
      // 32px chrome height alone.
      variant={null}
      size={null}
      ref={setNodeRef}
      {...listeners}
      type='button'
      role='tab'
      aria-selected={active}
      onClick={editing ? undefined : onActivate}
      data-testid={`space-tab-${id}`}
      className={cn(
        'group inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border-0 text-sm',
        // The fill answers which of these spaces is the current one, and that
        // stays true whichever region is active — so only the label colour
        // moves, saying whether the keyboard belongs here (#168). Hover
        // reaches for that same brightness, so it follows the region too:
        // with the agent column active a hovered tab brighter than the
        // current one would read as the current one. Which is why the current
        // tab sits one step past hover: landing on the same fill leaves a
        // hovered neighbour and the current tab looking alike.
        active
          ? spaceRegionActive
            ? 'bg-accent-strong text-foreground'
            : 'bg-accent-strong text-muted-foreground'
          : spaceRegionActive
            ? 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'bg-transparent text-muted-foreground hover:bg-accent',
      )}
      style={{
        height: 'var(--btn-chrome)',
        padding: '0 var(--space-4)',
        gap: 'var(--space-3)',
        borderRadius: 4,
        maxWidth: SPACE_TAB_MAX_WIDTH,
        // Only the x of what dnd-kit offers. The strip runs left to right and
        // that is the whole gesture; carrying the y would lift a dragged tab
        // clear of the 40px bar it belongs to.
        transform: transform
          ? `translate3d(${transform.x}px, 0, 0)`
          : undefined,
        transition,
        // Above the tabs it slides past, so it stays whole while it travels.
        zIndex: isDragging ? 1 : undefined,
        // Lifted off the strip while it travels: the tabs it passes over stay
        // readable through it, and the tab under the pointer reads as the one
        // being carried rather than one more tab sitting in the row.
        opacity: isDragging ? 0.55 : undefined,
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
          // Grows with what is typed and stops at the tab's cap, after which
          // the field scrolls and the caret stays in view. The floor is a
          // minimum and nothing more: `field-sizing` only replaces the
          // AUTOMATIC size, so any definite `width` here switches it off and
          // pins the field at that width whatever is typed. This is the shape
          // the project title, the node header and the group name all use.
          className='min-w-[2ch] border-0 bg-transparent p-0 text-sm text-foreground outline-none [field-sizing:content]'
        />
      ) : (
        <span
          onDoubleClick={onNameDoubleClick}
          data-testid={`space-tab-name-${id}`}
          // The name is what gives way when the tab meets its cap: the icon
          // and the close control keep their room, and `min-w-0` is what lets
          // this shrink below its text inside the flex row.
          className='min-w-0 truncate'
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
          // The tab around this span starts a drag on pointerdown, and a hand
          // that shifts while pressing × would drag the tab away instead of
          // closing it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onCloseClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onClose?.();
            }
          }}
          data-testid={`space-tab-close-${id}`}
          className='ml-0 inline-flex h-4 w-0 shrink-0 items-center justify-center overflow-hidden rounded-chrome text-muted-foreground opacity-0 transition-[width,margin,opacity] hover:bg-accent hover:text-foreground focus-visible:ml-[2px] focus-visible:w-4 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:ml-[2px] group-hover:w-4 group-hover:opacity-100'
        >
          <X style={{ width: 12, height: 12 }} />
        </span>
      ) : null}
    </Button>
  );
  return (
    // Every tab hands its whole name back, whatever the name is worth (user
    // 2026-08-29). Someone who has learnt that hovering a tab shows the full
    // name must get the same answer on the short ones: asking first whether
    // the strip had cut this one short leaves that gesture silently dead on
    // some tabs and alive on others.
    //
    // The rename field is the one state that closes it — the whole name is
    // already in the field, selected, and a tooltip over it would be labelling
    // the old name while a new one is being typed.
    // A tab under a pointer that is dragging it is the other state that closes
    // it: the name would ride along across the strip, over whatever the tab is
    // passing.
    <Tooltip
      open={nameTipOpen && !editing && !isDragging}
      onOpenChange={setNameTipOpen}
    >
      {/* The whole tab is the anchor, so the gap the tooltip keeps is measured
          from the edge a person sees rather than from the name inset within
          it. */}
      <TooltipTrigger asChild>{tab}</TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
