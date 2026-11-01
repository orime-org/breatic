// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ProjectRegisteredAsset } from '@breatic/shared';
import { Film, Upload } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { timelineApi } from '@web/data/api/timeline';
import { useTranslation } from '@web/i18n/use-translation';
import { useReturnFocus } from '@web/lib/overlay-focus';
import { cn } from '@web/lib/utils';
import type { TimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';

/** A visible view of the document-owned material workflow. */
interface TimelineMaterialDialogProps {
  projectId: string;
  spaceId: string;
  draft: TimelineMediaDraft;
  canWrite: boolean;
  onClose: () => void;
}

/** A registered video choice whose metadata is verified again on acceptance. */
interface ProjectVideoChoiceProps { asset: ProjectRegisteredAsset; selected: boolean; disabled: boolean; onSelect: (asset: ProjectRegisteredAsset) => void }

/**
 * Present one canonical Project video and its current selection.
 * @param props - The registered video and material draft selection.
 * @param props.asset - The canonical registered video metadata.
 * @param props.selected - Whether the current form selects this video.
 * @param props.disabled - Whether a material confirmation is in progress.
 * @param props.onSelect - The draft's explicit selection action.
 * @returns The existing Button primitive with media information.
 * @throws {never} Never.
 */
function ProjectVideoChoice({ asset, selected, disabled, onSelect }: ProjectVideoChoiceProps): React.JSX.Element {
  const t = useTranslation();
  const choose = React.useCallback((): void => onSelect(asset), [onSelect, asset]);
  return <Button type='button' data-testid={`timeline-project-video-${asset.assetId}`} variant={null} size={null} disabled={disabled} onClick={choose} aria-pressed={selected}
    className={cn('flex w-full min-w-0 justify-start gap-3 rounded-chrome border border-border p-3 text-left hover-enabled:bg-accent', selected && 'border-active-border')}>
    {asset.coverUrl === null ? <Film className='size-10 shrink-0 text-muted-foreground' /> : <img src={asset.coverUrl} alt='' className='h-10 w-16 shrink-0 rounded-content-xs object-cover' />}
    <span className='flex min-w-0 flex-1 flex-col gap-1'><span className='min-w-0 truncate leading-normal'>{asset.displayName || t('timeline.video')}</span><span className='text-xs text-muted-foreground'>{asset.durationSeconds === null ? t('timeline.material.durationPending') : t('timeline.material.duration', { seconds: asset.durationSeconds })}</span></span>
  </Button>;
}

/**
 * Display the document-owned material form and its explicit user actions.
 * @param props - The current Project and document-scoped material workflow.
 * @param props.projectId - The Project whose videos are listed.
 * @param props.spaceId - The target Space tab's stable identity.
 * @param props.draft - The document-owned material state and actions.
 * @param props.canWrite - The current Project role's permission.
 * @param props.onClose - The explicit cancel and overlay-release action.
 * @returns The Project picker, local uploader and placement confirmation.
 * @throws {never} Never.
 */
export function TimelineMaterialDialog({ projectId, spaceId, draft, canWrite, onClose }: TimelineMaterialDialogProps): React.JSX.Element {
  const t = useTranslation();
  const state = React.useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const returnFocus = useReturnFocus(true);
  const listKey = React.useMemo(() => ['timeline-videos', projectId], [projectId]);
  const queryFn = React.useCallback(({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => timelineApi.listVideos(projectId, pageParam, signal), [projectId]);
  const list = useInfiniteQuery({ queryKey: listKey, queryFn, initialPageParam: undefined as string | undefined, getNextPageParam: (page) => page.nextCursor ?? undefined, enabled: state.mode === 'project' });
  const { refetch, fetchNextPage } = list;
  const videos = React.useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const changeOpen = React.useCallback((open: boolean): void => { if (!open) onClose(); }, [onClose]);
  const chooseProject = React.useCallback((): void => draft.setMode('project'), [draft]);
  const chooseLocal = React.useCallback((): void => draft.setMode('local'), [draft]);
  const chooseFile = React.useCallback((): void => fileInput.current?.click(), []);
  const changeFile = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => draft.setFile(event.target.files?.[0] ?? null), [draft]);
  const changeFrame = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => draft.setStartFrame(event.target.value), [draft]);
  const retryList = React.useCallback((): void => { void refetch(); }, [refetch]);
  const moreVideos = React.useCallback((): void => { void fetchNextPage(); }, [fetchNextPage]);
  const confirm = React.useCallback((event: React.FormEvent): void => { event.preventDefault(); void draft.confirm(); }, [draft]);
  return <Dialog open onOpenChange={changeOpen}>
    <DialogContent onCloseAutoFocus={returnFocus} className='flex h-[min(36rem,85vh)] flex-col gap-0 p-0'>
      <DialogHeader className='shrink-0 border-b border-border p-4'><DialogTitle>{t('timeline.addMedia')}</DialogTitle><DialogDescription>{t('timeline.material.description')}</DialogDescription></DialogHeader>
      <form noValidate onSubmit={confirm} className='flex min-h-0 flex-1 flex-col'>
        <div className='flex shrink-0 gap-2 px-4 pt-4'>
          <Button data-testid='timeline-material-project' type='button' variant='outline' onClick={chooseProject} disabled={state.busy} aria-pressed={state.mode === 'project'} className={state.mode === 'project' ? 'border-active-border' : undefined}>{t('timeline.material.project')}</Button>
          <Button data-testid='timeline-material-local' type='button' variant='outline' onClick={chooseLocal} disabled={state.busy} aria-pressed={state.mode === 'local'} className={state.mode === 'local' ? 'border-active-border' : undefined}>{t('timeline.material.local')}</Button>
        </div>
        <ScrollArea className='min-h-0 flex-1' viewportClassName='p-4'>
          {state.mode === 'project' ? <div className='flex flex-col gap-2'>
            {list.isPending && <p className='py-6 text-sm text-muted-foreground'>{t('timeline.material.loading')}</p>}
            {list.isError && <div data-testid='timeline-material-error' className='flex flex-col items-start gap-3 py-4 text-sm'><p>{t('timeline.material.listError')}</p><Button type='button' data-testid='timeline-material-retry' variant='outline' onClick={retryList} loading={list.isFetching}>{t('timeline.retry')}</Button></div>}
            {!list.isPending && !list.isError && videos.length === 0 && <p className='py-6 text-sm text-muted-foreground'>{t('timeline.material.empty')}</p>}
            {videos.map((asset) => <ProjectVideoChoice key={asset.assetId} asset={asset} selected={state.selected?.assetId === asset.assetId} disabled={state.busy} onSelect={draft.select} />)}
            {list.hasNextPage && <Button type='button' variant='outline' onClick={moreVideos} loading={list.isFetchingNextPage}>{t('timeline.material.more')}</Button>}
          </div> : <div className='flex flex-col items-start gap-3 py-4'>
            <Input ref={fileInput} data-testid='timeline-file-input' type='file' accept='video/*' onChange={changeFile} disabled={state.busy} className='hidden' />
            <Button type='button' variant='outline' onClick={chooseFile} disabled={state.busy} icon={<Upload className='size-4' />}>{t('timeline.material.chooseFile')}</Button>
            <p className='max-w-full break-words text-sm text-muted-foreground'>{state.file?.name ?? t('timeline.material.fileEmpty')}</p>
            {state.busy && <p className='text-sm text-muted-foreground'>{state.progress === null ? t('timeline.material.preparing') : t('timeline.material.progress', { progress: state.progress })}</p>}
          </div>}
        </ScrollArea>
        <div className='flex shrink-0 flex-col gap-3 border-t border-border p-4'>
          <div className='flex items-center gap-3'><Label htmlFor={`timeline-start-${spaceId}`} className='shrink-0'>{t('timeline.startFrame')}</Label><Input id={`timeline-start-${spaceId}`} data-testid='timeline-start-frame' type='number' autoComplete='off' min={0} step={1} value={state.startFrame} onChange={changeFrame} disabled={state.busy} /></div>
          {state.errorKey !== null && <p data-testid='timeline-material-error' className='text-sm text-status-error-foreground'>{t(`timeline.errors.${state.errorKey}`)}</p>}
          {!canWrite && <p className='text-sm text-muted-foreground'>{t('timeline.errors.readonly')}</p>}
        </div>
        <DialogFooter className='shrink-0 border-t border-border p-4'><Button type='button' variant='outline' onClick={onClose}>{t('timeline.cancel')}</Button><Button type='submit' data-testid='timeline-confirm-material' loading={state.busy} disabled={!canWrite}>{t('timeline.material.confirm')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
