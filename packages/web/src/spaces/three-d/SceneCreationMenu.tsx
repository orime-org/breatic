// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Accessibility, Box, HelpCircle, MessageCircle, Plus, Sparkles } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useReturnFocus } from '@web/lib/overlay-focus';
import { useTranslation } from '@web/i18n/use-translation';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';

const icons = { add: <Plus className='size-5' />, generate: <Sparkles className='size-5' />, help: <HelpCircle className='size-5' /> };

/**
 * Open scene creation, capability information and help from the floating left rail.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.canEdit - Whether this document currently permits shared edits.
 * @param root0.onAdd - Places the requested built-in source.
 * @returns The left rail and its controlled dialogs.
 * @throws {never} Commands use the existing session feedback path.
 */
export const SceneCreationMenu = React.memo(function SceneCreationMenu({ canEdit, onAdd }: { canEdit: boolean; onAdd: (kind: 'box' | 'figure') => void }): React.JSX.Element {
  const t = useTranslation();
  const id = React.useId();
  const [addOpen, setAddOpen] = useExclusiveOverlay(`${id}:add`);
  const [aiOpen, setAiOpen] = useExclusiveOverlay(`${id}:ai`);
  const [helpOpen, setHelpOpen] = useExclusiveOverlay(`${id}:help`);
  const returnFocus = useReturnFocus(aiOpen || helpOpen);
  /**
   * Open the generation capability dialog.
   * @throws {never} Never.
   */
  const showAi = React.useCallback((): void => setAiOpen(true), [setAiOpen]);
  /**
   * Open the help dialog.
   * @throws {never} Never.
   */
  const showHelp = React.useCallback((): void => setHelpOpen(true), [setHelpOpen]);
  React.useEffect(() => () => { setAddOpen(false); setAiOpen(false); setHelpOpen(false); }, [setAddOpen, setAiOpen, setHelpOpen]);
  return <>
    <nav className='absolute left-[var(--space-5)] top-1/2 z-10 flex w-[52px] -translate-y-1/2 flex-col items-center gap-1 rounded-lg border border-border bg-popover py-1.5 shadow-sm' data-testid='scene-left-menu'>
      <DropdownMenu modal={false} open={addOpen} onOpenChange={setAddOpen}><DropdownMenuTrigger asChild><SceneIconButton label={t('spaces.threeD.add')} rail active disabled={!canEdit}>{icons.add}</SceneIconButton></DropdownMenuTrigger>
        <DropdownMenuContent side='right' align='start'><DropdownMenuItem onSelect={() => onAdd('box')}><Box />{t('spaces.threeD.addBox')}</DropdownMenuItem><DropdownMenuItem onSelect={() => onAdd('figure')}><Accessibility />{t('spaces.threeD.addFigure')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <SceneIconButton rail label={t('spaces.threeD.generate')} onClick={showAi}>{icons.generate}</SceneIconButton>
      <Tooltip><TooltipTrigger asChild><span className='inline-flex'><Button variant={null} size={null} disabled className='inline-flex h-10 w-10 items-center justify-center rounded-lg text-foreground-disabled'><MessageCircle className='size-5' /></Button></span></TooltipTrigger><TooltipContent side='right'>{t('spaces.threeD.annotationsLater')}</TooltipContent></Tooltip>
      <div className='my-1 h-px w-7 bg-border' /><SceneIconButton rail label={t('spaces.threeD.help')} onClick={showHelp}>{icons.help}</SceneIconButton>
    </nav>
    <Dialog open={aiOpen} onOpenChange={setAiOpen}><DialogContent onCloseAutoFocus={returnFocus}><DialogHeader><DialogTitle>{t('spaces.threeD.generate')}</DialogTitle><DialogDescription>{t('spaces.threeD.generationDev')}</DialogDescription></DialogHeader>
      <div className='space-y-4 px-4 py-3'><div className='space-y-2'><Label htmlFor={`${id}:prompt`}>{t('spaces.threeD.prompt')}</Label><Textarea id={`${id}:prompt`} className='min-h-24' disabled /></div>
        <div className='space-y-2'><Label htmlFor={`${id}:reference`}>{t('spaces.threeD.reference')}</Label><div>
          <Button variant='outline' disabled>{t('spaces.threeD.chooseReference')}</Button>
          <input id={`${id}:reference`} type='file' accept='image/*' hidden disabled />
        </div></div></div>
      <DialogFooter><Button variant='outline' onClick={() => setAiOpen(false)}>{t('common.cancel')}</Button><Button disabled>{t('spaces.threeD.submit')}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent onCloseAutoFocus={returnFocus}><DialogHeader><DialogTitle>{t('spaces.threeD.help')}</DialogTitle><DialogDescription>{t('spaces.threeD.helpBody')}</DialogDescription></DialogHeader></DialogContent></Dialog>
  </>;
});
