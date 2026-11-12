// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { Film, Music, Plus, X } from 'lucide-react';
import * as React from 'react';

import type { MiniToolSlot, MiniToolSlotValue } from '@breatic/shared/mini-tools';

import { PreviewImg } from '@web/components/PreviewImg';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import { formatSeconds } from '@web/spaces/canvas/lib/duration';

/** How far the pointer travels before a press becomes a drag (px), as on the Space tab strip. */
const POINTER_ACTIVATION = { activationConstraint: { distance: 4 } };

/** dnd-kit's default instruction describes a keyboard reorder the row does not offer, in English. */
const DND_ACCESSIBILITY = { screenReaderInstructions: { draggable: '' } };

/** The fewest clips a join runs on; the row keeps that many. */
const MIN_CLIPS = 2;

export interface JoinClipRowProps {
  /** The join's clip list, as the registry declares it. */
  slot: MiniToolSlot;
  /** The clips in the order they are joined. */
  clips: readonly MiniToolSlotValue[];
  /** How many clips the list holds at most. */
  cap: number | undefined;
  /** Whether a pick into the list is running. */
  picking: boolean;
  onPick: (slotKey: string) => void;
  onMove: (slotKey: string, nodeId: string, toIndex: number) => void;
  onRemove: (slotKey: string, nodeId: string) => void;
}

interface JoinTileProps {
  clip: MiniToolSlotValue & { nodeId: string };
  index: number;
  accepts: MiniToolSlot['accepts'];
  removable: boolean;
  removeLabel: string;
  onRemove: (nodeId: string) => void;
}

/**
 * One clip: its picture (a video's cover, or the medium's icon), its place in
 * the order, and its node's name and length under it, since several sounds
 * look alike. The tile drags to reorder, by pointer only; its one button
 * takes the clip out.
 * @param root0 - Component props.
 * @param root0.clip - The clip.
 * @param root0.index - Its place in the list.
 * @param root0.accepts - The list's medium.
 * @param root0.removable - Whether the list has a clip to spare.
 * @param root0.removeLabel - The remove button's name.
 * @param root0.onRemove - Take the clip out.
 * @returns The tile.
 */
const JoinTile = React.memo(function JoinTile({
  clip,
  index,
  accepts,
  removable,
  removeLabel,
  onRemove,
}: JoinTileProps): React.JSX.Element {
  // `attributes` stays unused, as on the Space tab strip: its role and tab
  // stop describe a keyboard reorder the row does not offer.
  const { setNodeRef, listeners, transform, transition, isDragging, active } = useSortable({ id: clip.nodeId });
  const Icon = accepts === 'video' ? Film : Music;
  return (
    <div
      ref={setNodeRef}
      data-testid={`join-tile-${clip.nodeId}`}
      className='relative w-14'
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.55 : undefined,
      }}
    >
      {/* Hovering a clip previews it, playing it, as a generation slot does;
          no card opens or stays while any tile is being dragged. */}
      <HoverPreview
        kind={accepts === 'video' ? 'video' : 'audio'}
        src={clip.url}
        poster={accepts === 'video' ? clip.cover : undefined}
        followCanvas
        suppressed={active !== null}
      >
        <div {...listeners} className='cursor-grab active:cursor-grabbing'>
          <div className='relative h-10 w-14 overflow-hidden rounded-overlay border border-border bg-muted'>
            {clip.cover === undefined ? (
              <Icon className='absolute inset-0 m-auto h-4 w-4 text-muted-foreground' aria-hidden='true' />
            ) : (
              <PreviewImg src={clip.cover} alt='' draggable={false} className='absolute inset-0 h-full w-full object-cover' />
            )}
            <span className='absolute bottom-0.5 left-0.5 rounded-chrome-sm border border-border bg-popover px-1 text-2xs font-semibold tabular-nums text-foreground'>
              {index + 1}
            </span>
          </div>
          <p className='mt-0.5 truncate text-2xs text-foreground'>{clip.name ?? ''}</p>
          <p className='text-2xs tabular-nums text-muted-foreground'>
            {clip.duration === undefined ? '' : formatSeconds(clip.duration)}
          </p>
        </div>
      </HoverPreview>
      <Button
        type='button'
        variant={null}
        size={null}
        aria-label={removeLabel}
        disabled={!removable}
        onClick={() => onRemove(clip.nodeId)}
        // The slot tile's remove badge, which also stands down with too few clips.
        className='absolute right-0.5 top-0.5 z-10 flex h-4 w-4 after:absolute after:-inset-[5px] items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-colors hover-enabled:bg-accent hover-enabled:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
      >
        <X className='h-2.5 w-2.5' aria-hidden='true' />
      </Button>
    </div>
  );
});

/**
 * A join's clips as a numbered row (inner#1825 §6.5): drag a tile to reorder,
 * take one out while more than two are left, and add one from the canvas
 * through the add tile at the end, which leaves once the list is full.
 * @param root0 - Component props.
 * @param root0.slot - The join's clip list.
 * @param root0.clips - The clips in order.
 * @param root0.cap - How many the list holds at most.
 * @param root0.picking - Whether a pick into the list is running.
 * @param root0.onPick - Start or end the pick.
 * @param root0.onMove - Move a clip to a new place.
 * @param root0.onRemove - Take a clip out.
 * @returns The row.
 */
export const JoinClipRow = React.memo(function JoinClipRow({
  slot,
  clips,
  cap,
  picking,
  onPick,
  onMove,
  onRemove,
}: JoinClipRowProps): React.JSX.Element {
  const t = useTranslation();
  const sensors = useSensors(useSensor(PointerSensor, POINTER_ACTIVATION));
  // Every clip in a join's list is picked from a node, so it carries one.
  const tiles = React.useMemo(
    () => clips.filter((clip): clip is MiniToolSlotValue & { nodeId: string } => clip.nodeId !== undefined),
    [clips],
  );
  const ids = React.useMemo(() => tiles.map((clip) => clip.nodeId), [tiles]);
  const slotKey = slot.key;
  const onDragEnd = React.useCallback(
    ({ active, over }: DragEndEvent): void => {
      if (over === null || active.id === over.id) return;
      const to = ids.indexOf(String(over.id));
      if (to >= 0) onMove(slotKey, String(active.id), to);
    },
    [ids, onMove, slotKey],
  );
  const removeOne = React.useCallback((nodeId: string): void => onRemove(slotKey, nodeId), [onRemove, slotKey]);
  const removeLabel = t('canvas.miniTool.panel.clearSlot');
  const tip = t(slot.bannerKey);
  return (
    <div>
      <p className='mb-1.5 text-xs font-medium text-muted-foreground'>{t('canvas.miniTool.panel.joinClips')}</p>
      <DndContext accessibility={DND_ACCESSIBILITY} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <div className='flex flex-wrap gap-1.5'>
            {tiles.map((clip, index) => (
              <JoinTile
                key={clip.nodeId}
                clip={clip}
                index={index}
                accepts={slot.accepts}
                removable={tiles.length > MIN_CLIPS}
                removeLabel={removeLabel}
                onRemove={removeOne}
              />
            ))}
            {cap !== undefined && clips.length >= cap ? null : (
              // The tip rides the same hover card a clip opens, as an empty generation slot's does.
              <HoverPreview kind='image' emptyHint={tip} followCanvas>
                <Button
                  type='button'
                  variant={null}
                  size={null}
                  data-testid='join-add'
                  aria-label={tip}
                  aria-pressed={picking}
                  // A pick hands focus back to its trigger when it ends; the card is a pointer affordance.
                  onFocusCapture={suppressTooltipFocusOpen}
                  onClick={() => onPick(slotKey)}
                  className={
                    'flex h-10 w-14 items-center justify-center rounded-overlay border border-dashed border-border transition-colors ' +
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
                      (picking ? 'bg-foreground text-background' : 'text-muted-foreground hover-enabled:bg-accent hover-enabled:text-accent-foreground')
                  }
                >
                  <Plus className='h-4 w-4' aria-hidden='true' />
                </Button>
              </HoverPreview>
            )}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
});
