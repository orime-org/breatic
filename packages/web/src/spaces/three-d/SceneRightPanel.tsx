// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Anchor } from '@radix-ui/react-popover';
import { X } from 'lucide-react';
import { Popover, PopoverContent } from '@web/components/ui/popover';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { isEditableTarget } from '@web/lib/is-editable-target';
import { useTranslation } from '@web/i18n/use-translation';
import { useUIStore } from '@web/stores/ui';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';

/**
 * Anchor one non-modal panel to the scene edge and arbitrate its Escape and focus ownership.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.open - Whether the shared right panel is open.
 * @param root0.onOpenChange - Updates the global overlay ownership.
 * @param root0.title - Visible name of the current panel.
 * @param root0.automatic - Whether selection opened the inspector without moving focus.
 * @param root0.stage - The containing scene allocation.
 * @param root0.returnTarget - The most recent valid panel opener.
 * @param root0.children - Current panel content.
 * @param root0.cancelGesture - Cancels an active scene transform and reports ownership of this press.
 * @param root0.contentRef - Persistent panel container receiving focus before its content changes.
 * @param root0.actions - Contextual controls placed before the panel's close action.
 * @returns The scene-edge shared floating panel.
 * @throws {never} Never directly.
 */
export function SceneRightPanel({ open, onOpenChange, title, automatic, stage, returnTarget, children, cancelGesture, contentRef, actions }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; automatic: React.RefObject<boolean>;
  stage: React.RefObject<HTMLDivElement | null>; returnTarget: React.RefObject<HTMLElement | null>; children: React.ReactNode; cancelGesture: () => boolean;
  contentRef: React.RefObject<HTMLDivElement | null>;
  actions?: React.ReactNode;
}): React.JSX.Element {
  const t = useTranslation();
  return <Popover open={open} onOpenChange={onOpenChange}>
    <Anchor asChild><div className='pointer-events-none absolute bottom-[calc(61px_+_142px_+_var(--space-5))] right-[var(--space-5)] top-[var(--space-5)] w-0' /></Anchor>
    <PopoverContent ref={contentRef} side='left' align='start' sideOffset={0} className='flex h-[var(--radix-popover-trigger-height)] w-80 flex-col p-0' data-testid='scene-right-panel'
      onOpenAutoFocus={(event) => { event.preventDefault(); if (!automatic.current) (event.currentTarget as HTMLElement).focus(); }}
      onEscapeKeyDown={(event) => {
        if (event.repeat || event.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
        if (isEditableTarget(event.target instanceof Element ? event.target : null) || cancelGesture()) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (useUIStore.getState().activeOverlayId !== null) return;
        const target = returnTarget.current;
        if (target?.isConnected && !target.closest('[data-testid="scene-right-panel"]') && !target.matches(':disabled')) target.focus();
        else stage.current?.querySelector<HTMLElement>('canvas')?.focus();
      }}
      onInteractOutside={(event) => { if (event.target instanceof Node && stage.current?.contains(event.target)) event.preventDefault(); }}>
      <div className='flex shrink-0 items-center justify-between gap-2 border-b border-border p-3' data-testid='scene-panel-header'><h2 className='min-w-0 truncate text-sm font-medium'>{title}</h2>
        <div className='flex shrink-0 items-center gap-1'>{actions}<SceneIconButton label={t('spaces.threeD.closePanel')} onClick={() => onOpenChange(false)}><X className='size-4' /></SceneIconButton></div>
      </div>
      <ScrollArea className='min-h-0 flex-1'>{children}</ScrollArea>
    </PopoverContent>
  </Popover>;
}
