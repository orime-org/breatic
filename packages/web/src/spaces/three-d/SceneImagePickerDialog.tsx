// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ImageIcon, RotateCw, Upload } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Skeleton } from '@web/components/ui/skeleton';
import { listProjectImages, projectImagesQueryKey } from '@web/data/api/scene';
import { useTranslation } from '@web/i18n/use-translation';
import type { SceneViewImage } from '@web/stores/scene-proposals';

/** The image types a view slot takes. */
export const SCENE_VIEW_ACCEPT = 'image/png,image/jpeg,image/webp';

interface SceneImagePickerDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a Project image the user chose. */
  onPick: (image: SceneViewImage) => void;
  /** Called with a file the user chose from the computer, to upload. */
  onPickFile: (file: File) => void;
}

/**
 * Choose a view slot's picture (inner#1691 design 7.2): from the images this
 * Project already holds, a page at a time, or from the computer. Laid out and
 * stated like the Timeline's material dialog.
 * @param props - The Project, the open state and what a choice is handed to.
 * @param props.projectId - The Project whose images are listed.
 * @param props.open - Whether the picker is open.
 * @param props.onOpenChange - Opens or closes it.
 * @param props.onPick - Takes a Project image.
 * @param props.onPickFile - Takes a file from the computer.
 * @returns The picker.
 */
export const SceneImagePickerDialog = React.memo(function SceneImagePickerDialog({ projectId, open, onOpenChange, onPick, onPickFile }: SceneImagePickerDialogProps): React.JSX.Element {
  const t = useTranslation();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className='flex h-[min(32rem,85vh)] max-w-[560px] flex-col'>
      <DialogHeader className='shrink-0'><DialogTitle>{t('spaces.threeD.picker.title')}</DialogTitle>
        <DialogDescription>{t('spaces.threeD.picker.description')}</DialogDescription></DialogHeader>
      <PickerBody projectId={projectId} onOpenChange={onOpenChange} onPick={onPick} onPickFile={onPickFile} />
    </DialogContent>
  </Dialog>;
});

/**
 * The picker's tabs and lists; mounted only while it is open, so the list is read then.
 * @param props - As the dialog takes them.
 * @param props.projectId - The Project whose images are listed.
 * @param props.onOpenChange - Closes the picker once something is chosen.
 * @param props.onPick - Takes a Project image.
 * @param props.onPickFile - Takes a file from the computer.
 * @returns The body.
 */
function PickerBody({ projectId, onOpenChange, onPick, onPickFile }: Omit<SceneImagePickerDialogProps, 'open'>): React.JSX.Element {
  const t = useTranslation();
  const [tab, setTab] = React.useState<'project' | 'local'>('project');
  const fileInput = React.useRef<HTMLInputElement>(null);
  const queryKey = React.useMemo(() => projectImagesQueryKey(projectId), [projectId]);
  const queryFn = React.useCallback(({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => listProjectImages(projectId, pageParam, signal), [projectId]);
  const list = useInfiniteQuery({ queryKey, queryFn, initialPageParam: undefined as string | undefined, getNextPageParam: (page) => page.nextCursor ?? undefined, enabled: tab === 'project' });
  const { refetch, fetchNextPage } = list;
  const images = React.useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const showProject = React.useCallback((): void => setTab('project'), []);
  const showLocal = React.useCallback((): void => setTab('local'), []);
  const chooseFile = React.useCallback((): void => fileInput.current?.click(), []);
  const changeFile = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    onPickFile(file);
    onOpenChange(false);
  }, [onPickFile, onOpenChange]);
  const retry = React.useCallback((): void => { void refetch(); }, [refetch]);
  const more = React.useCallback((): void => { void fetchNextPage(); }, [fetchNextPage]);
  return <>
    <div className='flex shrink-0 gap-2 px-4'>
      <Button type='button' variant='outline' data-testid='scene-image-picker-project' aria-pressed={tab === 'project'} onClick={showProject}
        className={tab === 'project' ? 'border-active-border' : undefined}>{t('spaces.threeD.picker.project')}</Button>
      <Button type='button' variant='outline' data-testid='scene-image-picker-local' aria-pressed={tab === 'local'} onClick={showLocal}
        className={tab === 'local' ? 'border-active-border' : undefined}>{t('spaces.threeD.picker.local')}</Button>
    </div>
    {tab === 'project' ? <ScrollArea className='min-h-0 flex-1' viewportClassName='p-4'>
      {list.isPending ? <div data-testid='scene-image-picker-loading' className='grid grid-cols-3 gap-2'>
        {[0, 1, 2, 3, 4, 5].map((index) => <Skeleton key={index} className='aspect-square w-full' />)}
      </div> : list.isError ? <div data-testid='scene-image-picker-error' className='flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground'>
        <p>{t('spaces.threeD.picker.loadFailed')}</p>
        <Button type='button' variant='outline' size='compact' data-testid='scene-image-picker-retry' loading={list.isFetching} icon={<RotateCw className='mr-1.5 size-4' />} onClick={retry}>{t('spaces.threeD.retry')}</Button>
      </div> : images.length === 0 ? <div data-testid='scene-image-picker-empty' className='flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground'>
        <ImageIcon className='size-6' aria-hidden='true' /><p>{t('spaces.threeD.picker.empty')}</p>
      </div> : <div className='flex flex-col gap-2'>
        <div className='grid grid-cols-3 gap-2'>
          {images.map((image) => <Button key={image.assetId} type='button' variant={null} size={null} data-testid={`scene-image-picker-item-${image.assetId}`}
            onClick={() => { onPick({ assetId: image.assetId, url: image.fileUrl, displayName: image.displayName }); onOpenChange(false); }}
            className='flex min-w-0 flex-col gap-1 rounded-chrome p-1.5 text-left text-xs hover-enabled:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'>
            <img src={image.fileUrl} alt='' className='aspect-square w-full rounded-content-xs object-cover' />
            <span className='w-full truncate leading-normal'>{image.displayName || t('spaces.threeD.picker.unnamed')}</span>
          </Button>)}
        </div>
        {list.hasNextPage ? <Button type='button' variant='outline' size='compact' className='self-center' data-testid='scene-image-picker-more' loading={list.isFetchingNextPage} onClick={more}>
          {t('spaces.threeD.picker.more')}</Button> : null}
      </div>}
    </ScrollArea> : <div className='m-4 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-chrome border border-dashed border-border text-sm text-muted-foreground'>
      <ImageIcon className='size-6' aria-hidden='true' />
      <p>{t('spaces.threeD.picker.formats')}</p>
      <Input ref={fileInput} data-testid='scene-image-picker-file-input' type='file' accept={SCENE_VIEW_ACCEPT} onChange={changeFile} className='hidden' />
      <Button type='button' variant='outline' icon={<Upload className='mr-2 size-4' />} onClick={chooseFile}>{t('spaces.threeD.picker.chooseFile')}</Button>
    </div>}
  </>;
}
