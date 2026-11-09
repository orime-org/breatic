// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Accessibility, Box, Keyboard, MessageCircle, Plus, Sparkles, Upload } from 'lucide-react';
import type { ProjectRole } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useReturnFocus } from '@web/lib/overlay-focus';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';
import { SceneGenerateDialog } from '@web/spaces/three-d/SceneGenerateDialog';
import { SceneIconButton } from '@web/spaces/three-d/SceneIconButton';
import { sceneGenerateIntent } from '@web/spaces/three-d/scene-generation';
import { useSceneProposalReceiver } from '@web/spaces/three-d/use-scene-proposal-receiver';
import type { SceneGenerateFill } from '@web/stores/scene-proposals';
import { useRunning } from '@web/stores/task-actions-in-flight';

const icons = { add: <Plus className='size-5' />, import: <Upload className='size-5' />, generate: <Sparkles className='size-5' />, controls: <Keyboard className='size-5' /> };

interface SceneCreationMenuProps {
  projectId: string;
  spaceId: string;
  /** The member's project role; a viewer sees Add, Import model and AI generation as present but unmet. */
  myRole?: ProjectRole;
  /** Whether this document currently permits shared edits (synced, current, budgets loaded). */
  canEdit: boolean;
  onAdd: (kind: 'box' | 'figure') => void;
  onImport: () => void;
  /** Told the row a submitted generation opened. */
  onGenerated?: (rowId: string) => void;
}

/**
 * Open scene creation, generation and the controls description from the floating left rail.
 *
 * Add and Import model need the scene ready for shared edits; AI generation
 * reads and writes no scene document, so it needs only the project role
 * (inner#1691 design 7.1). The rail also hosts the generation dialog and,
 * while drawn, receives the fills an Agent proposal or a Retry hands in.
 * @param root0 - Scene controls and their current owner bindings.
 * @param root0.projectId - The project.
 * @param root0.spaceId - The 3D Space.
 * @param root0.myRole - The member's project role.
 * @param root0.canEdit - Whether this document currently permits shared edits.
 * @param root0.onAdd - Places the requested built-in source.
 * @param root0.onImport - Opens the document's model import.
 * @param root0.onGenerated - Told the row a submitted generation opened.
 * @returns The left rail and its controlled dialogs.
 * @throws {never} Commands use the existing session feedback path.
 */
export const SceneCreationMenu = React.memo(function SceneCreationMenu({ projectId, spaceId, myRole, canEdit, onAdd, onImport, onGenerated }: SceneCreationMenuProps): React.JSX.Element {
  const t = useTranslation();
  const id = React.useId();
  const [addOpen, setAddOpen] = useExclusiveOverlay(`${id}:add`);
  const [aiOpen, setAiOpen] = useExclusiveOverlay(`${id}:ai`);
  const [controlsOpen, setControlsOpen] = useExclusiveOverlay(`${id}:controls`);
  const returnFocus = useReturnFocus(aiOpen || controlsOpen);
  const [fill, setFill] = React.useState<SceneGenerateFill | null>(null);
  const submitting = useRunning(sceneGenerateIntent(spaceId)) !== undefined;
  const viewer = myRole === 'viewer';
  const readOnlyText = t('spaces.threeD.readOnlyCreate');
  /**
   * Say why a viewer's press does nothing.
   * @throws {never} Never.
   */
  const sayReadOnly = React.useCallback((): void => { toast.warning(readOnlyText); }, [readOnlyText]);
  /**
   * Open the generation dialog blank.
   * @throws {never} Never.
   */
  const showAi = React.useCallback((): void => { setFill(null); setAiOpen(true); }, [setAiOpen]);
  /**
   * Open the generation dialog filled.
   * @param next - What it opens with.
   * @throws {never} Never.
   */
  const openFilled = React.useCallback((next: SceneGenerateFill): void => { setFill(next); setAiOpen(true); }, [setAiOpen]);
  useSceneProposalReceiver({ submitting, open: openFilled });
  // The row a submit opened, handed on once the dialog has finished closing:
  // the close returns focus to whatever opened the dialog, so a row focused
  // before that would lose it again. A dialog closed while the submit was
  // still waiting has no close left to wait for.
  const openedRow = React.useRef<string | null>(null);
  const dialogOpen = React.useRef(aiOpen);
  React.useEffect(() => {
    dialogOpen.current = aiOpen;
  }, [aiOpen]);
  /**
   * Keep the row the server opened until the dialog has closed on it.
   * @param rowId - The row the server opened.
   * @throws {never} Never.
   */
  const submitted = React.useCallback((rowId: string): void => {
    if (dialogOpen.current) openedRow.current = rowId;
    else onGenerated?.(rowId);
  }, [onGenerated]);
  /**
   * Return focus as every closing overlay does, then hand on the row a submit opened.
   * @param event - The dialog's close-focus event.
   * @throws {never} Never.
   */
  const generateClosed = React.useCallback((event: Event): void => {
    returnFocus(event);
    const rowId = openedRow.current;
    openedRow.current = null;
    if (rowId !== null) onGenerated?.(rowId);
  }, [returnFocus, onGenerated]);
  /**
   * Open the controls dialog.
   * @throws {never} Never.
   */
  const showControls = React.useCallback((): void => setControlsOpen(true), [setControlsOpen]);
  React.useEffect(() => () => { setAddOpen(false); setAiOpen(false); setControlsOpen(false); }, [setAddOpen, setAiOpen, setControlsOpen]);
  return <>
    <nav className='absolute left-[var(--space-5)] top-1/2 z-10 flex w-[52px] -translate-y-1/2 flex-col items-center gap-1 rounded-lg border border-border bg-popover py-1.5 shadow-sm' data-testid='scene-left-menu'>
      {viewer ? <SceneIconButton label={t('spaces.threeD.add')} rail active aria-disabled className='opacity-50' onClick={sayReadOnly}>{icons.add}</SceneIconButton>
        : <DropdownMenu modal={false} open={addOpen} onOpenChange={setAddOpen}><DropdownMenuTrigger asChild><SceneIconButton label={t('spaces.threeD.add')} rail active disabled={!canEdit}>{icons.add}</SceneIconButton></DropdownMenuTrigger>
          <DropdownMenuContent side='right' align='start'><DropdownMenuItem onSelect={() => onAdd('box')}><Box />{t('spaces.threeD.addBox')}</DropdownMenuItem><DropdownMenuItem onSelect={() => onAdd('figure')}><Accessibility />{t('spaces.threeD.addFigure')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      {viewer ? <SceneIconButton rail label={t('spaces.threeD.importModel.title')} aria-disabled className='opacity-50' onClick={sayReadOnly} data-testid='scene-import-button'>{icons.import}</SceneIconButton>
        : <SceneIconButton rail label={t('spaces.threeD.importModel.title')} disabled={!canEdit} onClick={onImport} data-testid='scene-import-button'>{icons.import}</SceneIconButton>}
      <SceneIconButton rail label={t('spaces.threeD.generate')} aria-disabled={viewer ? true : undefined} className={viewer ? 'opacity-50' : undefined} onClick={viewer ? sayReadOnly : showAi}>{icons.generate}</SceneIconButton>
      <Tooltip><TooltipTrigger asChild><span className='inline-flex'><Button variant={null} size={null} disabled className='inline-flex h-10 w-10 items-center justify-center rounded-lg text-foreground-disabled'><MessageCircle className='size-5' /></Button></span></TooltipTrigger><TooltipContent side='right'>{t('spaces.threeD.annotationsLater')}</TooltipContent></Tooltip>
      <div className='my-1 h-px w-7 bg-border' /><SceneIconButton rail label={t('spaces.threeD.controls')} onClick={showControls}>{icons.controls}</SceneIconButton>
    </nav>
    <SceneGenerateDialog projectId={projectId} spaceId={spaceId} open={aiOpen} onOpenChange={setAiOpen} fill={fill} onSubmitted={submitted} onCloseAutoFocus={generateClosed} />
    <Dialog open={controlsOpen} onOpenChange={setControlsOpen}><DialogContent onCloseAutoFocus={returnFocus}><DialogHeader><DialogTitle>{t('spaces.threeD.controls')}</DialogTitle><DialogDescription>{t('spaces.threeD.helpBody')}</DialogDescription></DialogHeader></DialogContent></Dialog>
  </>;
});
