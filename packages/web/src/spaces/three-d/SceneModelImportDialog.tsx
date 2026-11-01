// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { SceneObjectValuesSchema } from '@breatic/shared';
import { Box, Check, ChevronRight, FolderOpen, Loader2, Lock, TriangleAlert, Upload } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { useTranslation } from '@web/i18n/use-translation';
import { useReturnFocus } from '@web/lib/overlay-focus';
import { ModelImportPreview } from '@web/spaces/three-d/ModelImportPreview';
import type { ModelImportController } from '@web/spaces/three-d/model-import-controller';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { budgetText, importErrorKey } from '@web/spaces/three-d/model-import-error-text';
import { sourcesFromDrop, sourcesFromFiles, supplementSources } from '@web/spaces/three-d/model-source';
import { modelUploadFailure } from '@web/spaces/three-d/model-upload-failure';

interface SceneModelImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: ModelImportController;
  canEdit: boolean;
  maxInputBytes: number;
}

const NAME_MAX_LENGTH = SceneObjectValuesSchema.shape.name.maxLength ?? undefined;
const uploadIcon = <Upload className='size-4' />;
const folderIcon = <FolderOpen className='size-4' />;

/**
 * Let the drop zone receive dropped files.
 * @param event - Drag over the drop zone.
 * @throws {never} Never.
 */
function allowDrop(event: React.DragEvent<HTMLDivElement>): void {
  event.preventDefault();
}

/**
 * Show one document-owned import without taking ownership of its operation.
 * @param props - Controlled dialog and live import bindings.
 * @param props.open - Whether this active Space shows the import dialog.
 * @param props.onOpenChange - Hides or reopens the view without cancelling work.
 * @param props.controller - Import owner retained while the Space is open.
 * @param props.canEdit - Current scene write permission.
 * @param props.maxInputBytes - Configured input-byte budget shown before selection.
 * @returns The approved file, preview and model-information dialog.
 * @throws {never} Import failures remain visible in the controller snapshot.
 */
export const SceneModelImportDialog = React.memo(function SceneModelImportDialog({ open, onOpenChange, controller, canEdit, maxInputBytes }: SceneModelImportDialogProps): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const t = useTranslation();
  const id = React.useId();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);
  const appendFiles = React.useRef(false);
  const [details, setDetails] = React.useState(false);
  const returnFocus = useReturnFocus(open);
  const busy = snapshot.phase === 'uploading' || snapshot.phase === 'registering';
  const checking = snapshot.phase === 'checking';
  const prepared = snapshot.prepared;
  const progress = Math.round(snapshot.progress * 100);
  const failedUpload = snapshot.phase === 'failed' && prepared !== null;
  const hasInput = snapshot.phase !== 'idle' && snapshot.phase !== 'placed';
  const error = snapshot.error;
  const uploadFailure = failedUpload && !(error instanceof ModelImportError) ? modelUploadFailure(error, prepared.file.name) : null;
  const errorText = error instanceof ModelImportError ? t(importErrorKey(error.code))
    : uploadFailure ? t(uploadFailure.key, uploadFailure.params) : t('spaces.threeD.importModel.errorLoad');
  const retryable = failedUpload && (uploadFailure?.retryable ?? true);
  // A check that failed outside the model content can succeed on the same retained collection.
  const retryCheck = snapshot.phase === 'failed' && prepared === null && error !== null && !(error instanceof ModelImportError) && snapshot.files.length > 0;

  /**
   * Ask for a fresh source collection through the browser's hidden file input.
   * @throws {never} Never directly.
   */
  const chooseFiles = React.useCallback((): void => {
    appendFiles.current = false;
    fileInput.current?.click();
  }, []);
  /**
   * Ask for a directory while preserving its relative source paths.
   * @throws {never} Never directly.
   */
  const chooseFolder = React.useCallback((): void => {
    appendFiles.current = false;
    folderInput.current?.click();
  }, []);
  /**
   * Add missing resources to the same selected entry and original collection.
   * @throws {never} Never directly.
   */
  const supplement = React.useCallback((): void => {
    appendFiles.current = true;
    fileInput.current?.click();
  }, []);
  /**
   * Send original File objects to the document's inspection operation.
   * @param event - Hidden picker result.
   * @throws {never} Inspection failures are represented by controller state.
   */
  const selectedFiles = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!files.length) return;
    const current = controller.getSnapshot();
    const append = appendFiles.current;
    appendFiles.current = false;
    setDetails(false);
    void controller.select(append ? [...current.files, ...supplementSources(files, current.missing)] : sourcesFromFiles(files), append ? current.entry : undefined);
  }, [controller]);
  /**
   * Read a dropped file collection through the same inspection entry point.
   * @param event - Drop on the finite input surface.
   * @throws {never} Inspection failures are represented by controller state.
   */
  const dropFiles = React.useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (!canEdit || busy) return;
    // A drag that carries no files (selected text, a link) is not a selection.
    if (!event.dataTransfer.files.length) return;
    setDetails(false);
    // An unreadable drop is inspected as dropped, so the read failure shows as the selection's own error.
    const dropped = sourcesFromFiles(Array.from(event.dataTransfer.files));
    void controller.selectWhenRead(sourcesFromDrop(event.dataTransfer).catch(() => dropped));
  }, [canEdit, busy, controller]);
  /**
   * Reinspect the same resource collection around an explicitly selected entry.
   * @param entry - User-selected normalized model path.
   * @throws {never} Inspection failures are represented by controller state.
   */
  const changeEntry = React.useCallback((entry: string): void => {
    setDetails(false);
    void controller.select(controller.getSnapshot().files, entry);
  }, [controller]);
  /**
   * Forward the exact visible object-name draft.
   * @param event - Name input change.
   * @throws {never} Never directly.
   */
  const changeName = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    controller.setName(event.currentTarget.value);
  }, [controller]);
  /**
   * Confirm through the operation's common upload and scene-command boundary.
   * @throws {never} Controller state retains any failed confirmation.
   */
  const confirm = React.useCallback((): void => { void controller.confirm(); }, [controller]);
  /**
   * Check the retained collection and main file again.
   * @throws {never} Never directly.
   */
  const checkAgain = React.useCallback((): void => { void controller.select(snapshot.files, snapshot.entry); }, [controller, snapshot.files, snapshot.entry]);
  /**
   * Hide this view while the document retains any active import.
   * @throws {never} Never directly.
   */
  const hide = React.useCallback((): void => onOpenChange(false), [onOpenChange]);
  /**
   * Show or hide the selected collection's file list.
   * @throws {never} Never.
   */
  const toggleDetails = React.useCallback((): void => setDetails((value) => !value), []);
  const detailsIcon = React.useMemo(() => <ChevronRight className={details ? 'size-3 rotate-90' : 'size-3'} />, [details]);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className='max-w-[760px]' onCloseAutoFocus={returnFocus} data-testid='model-import-dialog'>
      <DialogHeader><DialogTitle>{t('spaces.threeD.importModel.title')}</DialogTitle><DialogDescription>{t('spaces.threeD.importModel.description')}</DialogDescription></DialogHeader>
      <ScrollArea viewportClassName='max-h-[calc(100dvh-200px)] p-4'>
        <div className='space-y-4'>
          <div className='flex items-center gap-2'>
            <Button variant='outline' icon={uploadIcon} onClick={chooseFiles} disabled={busy || !canEdit}>{t('spaces.threeD.importModel.chooseFiles')}</Button>
            <Button variant='outline' icon={folderIcon} onClick={chooseFolder} disabled={busy || !canEdit}>{t('spaces.threeD.importModel.chooseFolder')}</Button>
            <span className='ml-auto shrink-0 text-xs text-muted-foreground'>{t('spaces.threeD.importModel.inputLimit', { size: Math.floor(maxInputBytes / 1024 / 1024) })}</span>
            <input ref={fileInput} type='file' multiple hidden onChange={selectedFiles} />
            <input ref={folderInput} type='file' multiple hidden {...{ webkitdirectory: '' }} onChange={selectedFiles} />
          </div>
          {!hasInput ? <div className='grid h-[300px] place-items-center rounded-chrome border border-dashed border-border bg-muted/30 p-4' onDragOver={allowDrop} onDrop={dropFiles} data-testid='model-import-dropzone'>
            <div className='space-y-3 text-center'>
              {canEdit ? <Upload className='mx-auto size-7 text-muted-foreground' /> : <Lock className='mx-auto size-6 text-muted-foreground' />}
              <p>{canEdit ? t('spaces.threeD.importModel.dropFiles') : t('spaces.threeD.importModel.readOnly')}</p>
              <p className='max-w-[340px] text-sm text-muted-foreground'>{canEdit ? t('spaces.threeD.importModel.resourceHint') : t('spaces.threeD.importModel.readOnlyHint')}</p>
            </div>
          </div> : <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4'>
            <div className='h-[300px] min-w-0 overflow-hidden rounded-chrome border border-border bg-muted/30'>
              {prepared?.preview ? <ModelImportPreview root={prepared.preview} /> : <div className='grid h-full place-items-center p-4 text-center text-sm text-muted-foreground'><div className='space-y-2'>
                {checking ? <Loader2 className='mx-auto size-6 animate-spin' /> : <Box className='mx-auto size-8' />}
                <p>{checking ? t('spaces.threeD.importModel.checking') : t('spaces.threeD.importModel.preview')}</p>
              </div></div>}
            </div>
            <div className='flex min-w-0 flex-col gap-4'>
              {snapshot.entries.length > 1 && <div className='min-w-0 space-y-2'><Label htmlFor={`${id}:entry`}>{t('spaces.threeD.importModel.entry')}</Label><Select value={snapshot.entry ?? ''} onValueChange={changeEntry} disabled={busy || !canEdit}><SelectTrigger id={`${id}:entry`}><SelectValue placeholder={t('spaces.threeD.importModel.chooseEntry')} /></SelectTrigger><SelectContent>{snapshot.entries.map((entry) => <SelectItem key={entry} value={entry}><span className='break-all'>{entry}</span></SelectItem>)}</SelectContent></Select></div>}
              <div className='space-y-2'><Label htmlFor={`${id}:name`}>{t('spaces.threeD.importModel.name')}</Label><Input id={`${id}:name`} value={snapshot.name} autoComplete='off' maxLength={NAME_MAX_LENGTH} onChange={changeName} disabled={busy || checking || !canEdit} /></div>
              <div className='space-y-2 text-xs text-muted-foreground'>
                {snapshot.entry && <p className='break-all'>{snapshot.entry}</p>}
                {snapshot.paths.length > 0 && <p>{t('spaces.threeD.importModel.fileCount', { count: snapshot.paths.length })}{prepared?.meshCount !== undefined && <> · {t('spaces.threeD.importModel.meshCount', { count: prepared.meshCount })}</>}{prepared?.skinned && <> · {t('spaces.threeD.importModel.skinned')}</>}</p>}
              </div>
              {checking ? <p className='flex items-center gap-2 text-sm text-muted-foreground'><Loader2 className='size-4 shrink-0 animate-spin' />{t('spaces.threeD.importModel.checkingResources')}</p>
                : busy ? <div className='space-y-3'><p className='flex items-center gap-2 text-sm'><Loader2 className='size-4 shrink-0 animate-spin' />{snapshot.phase === 'uploading' ? t('spaces.threeD.importModel.uploading', { progress }) : t('spaces.threeD.importModel.registering')}</p><div className='h-1.5 overflow-hidden rounded-full bg-muted'><div className='h-full rounded-full bg-foreground transition-all' style={{ width: `${progress}%` }} /></div><p className='text-xs text-muted-foreground'>{t('spaces.threeD.importModel.placingHint')}</p></div>
                  : error ? <div className='space-y-2'><p className='flex items-start gap-2 text-sm text-status-error'><TriangleAlert className='mt-0.5 size-4 shrink-0' /><span>{errorText}</span></p>{error instanceof ModelImportError && error.budget && <p className='pl-6 text-xs text-muted-foreground'>{budgetText(t, error.budget)}</p>}{error instanceof ModelImportError && error.detail && <p className='break-all pl-6 text-xs text-muted-foreground'>{error.detail}</p>}{snapshot.missing.length > 0 && <ScrollArea viewportClassName='max-h-24'><div className='space-y-1 pl-6 text-xs text-muted-foreground'>{snapshot.missing.map((path) => <p className='break-all' key={path}>{path}</p>)}</div></ScrollArea>}</div>
                    : <p className='flex items-center gap-2 text-sm'><Check className='size-4 shrink-0 text-status-success' />{t('spaces.threeD.importModel.ready')}</p>}
              {!canEdit && <p className='text-sm text-muted-foreground'>{snapshot.assetId ? t('spaces.threeD.importModel.registeredReadOnly') : t('spaces.threeD.importModel.readOnlyHint')}</p>}
              {snapshot.missing.length > 0 && <Button variant='outline' className='w-fit' onClick={supplement} disabled={busy || !canEdit}>{t('spaces.threeD.importModel.addResources')}</Button>}
              {prepared?.warnings?.length ? <div className='space-y-1 text-xs text-muted-foreground'><p>{t('spaces.threeD.importModel.optionalExtensions')}</p>{prepared.warnings.map((warning) => <p key={warning} className='break-all'>{warning}</p>)}</div> : null}
              {snapshot.paths.length > 0 && <Button variant='outline' size='compact' className='w-fit text-xs text-muted-foreground' icon={detailsIcon} onClick={toggleDetails}>{details ? t('spaces.threeD.importModel.hideFiles') : t('spaces.threeD.importModel.showFiles')}</Button>}
              {details && <ScrollArea className='h-[70px]' viewportClassName='space-y-1'><div className='space-y-1 text-xs text-muted-foreground'>{snapshot.paths.map((path) => <p key={path} className='break-all'>{path}</p>)}</div></ScrollArea>}
            </div>
          </div>}
        </div>
      </ScrollArea>
      <DialogFooter><Button variant='outline' onClick={hide}>{busy || checking ? t('spaces.threeD.importModel.hide') : t('common.cancel')}</Button>{retryCheck ? <Button onClick={checkAgain} disabled={!canEdit}>{t('spaces.threeD.importModel.retry')}</Button>
        : <Button loading={busy} onClick={confirm} disabled={!prepared || !['ready', 'failed', 'uploading', 'registering'].includes(snapshot.phase) || (failedUpload && !retryable) || !canEdit || !snapshot.name.trim()}>{retryable ? t('spaces.threeD.importModel.retry') : t('spaces.threeD.importModel.confirm')}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
});
