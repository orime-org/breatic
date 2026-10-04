// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Archive, ArchiveRestore, Copy, ImageUp, MoreHorizontal, Pencil } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useProjectActions } from '@web/features/project-manage/use-project-actions';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useRenameProject } from '@web/features/project-manage/use-rename-project';
import { ArchiveProjectDialog } from '@web/pages/studio/container/cards/ArchiveProjectDialog';
import { RenameProjectDialog } from '@web/pages/studio/container/cards/RenameProjectDialog';
import { useProjectCover } from '@web/pages/studio/container/cards/use-project-cover';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { ImageCropDialog } from '@web/pages/studio/container/dialogs/ImageCropDialog';
import { checkPickedFile } from '@web/pages/studio/container/dialogs/crop-image';

interface ProjectCardMenuProps {
  project: ContainerProject;
}

/**
 * Whether the card has anything to put behind its `⋯`.
 * @param project - The card's project and the server's verdict on what its viewer may do.
 * @returns True when at least one entry would show.
 */
export function hasCardMenu(project: ContainerProject): boolean {
  return project.canManageMeta || project.canDuplicate || project.canArchive || project.canRestore;
}

/**
 * The `⋯` menu on a project card. Which entries show is the server's answer,
 * one flag per entry: rename and upload cover (`canManageMeta`), duplicate
 * (`canDuplicate`), archive (`canArchive`, after a separator) and restore
 * (`canRestore`). The server sends restore alone on an archived card and the
 * other three only on a live one.
 *
 * Render it only when {@link hasCardMenu} says there is something to show.
 *
 * The file input is `hidden` rather than visually hidden: the native control
 * is drawn by the operating system and has no place in the UI, and a
 * screen-reader-only input would still be an invisible stop in the tab order.
 * The menu entry drives it.
 * @param props - The card's project.
 * @param props.project - The card's project.
 * @returns The menu with its file picker and dialogs.
 */
export function ProjectCardMenu({ project }: ProjectCardMenuProps): React.JSX.Element {
  const t = useTranslation();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = React.useState<File | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [confirmingArchive, setConfirmingArchive] = React.useState(false);
  const cover = useProjectCover(project.id);
  const rename = useRenameProject(project.id);
  const actions = useProjectActions(project.id);
  const { reset, done } = cover;

  const handlePick = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0] ?? null;
      // Reset so picking the same file twice in a row still fires a change.
      event.target.value = '';
      if (file === null) return;
      const problem = checkPickedFile(file);
      if (problem !== null) {
        toast.warning(t(`studio.container.imageError.${problem}`));
        return;
      }
      reset();
      setPicked(file);
    },
    [reset, t],
  );

  const openPicker = React.useCallback((): void => inputRef.current?.click(), []);
  const openRename = React.useCallback((): void => setRenaming(true), []);
  const openArchive = React.useCallback((): void => setConfirmingArchive(true), []);
  const { mutate: renameTo } = rename;
  const { duplicate, archive, restore } = actions;
  // Wrapped so the menu's event never reaches `mutate` as its variables.
  const runDuplicate = React.useCallback((): void => duplicate(), [duplicate]);
  const runArchive = React.useCallback((): void => archive(), [archive]);
  const runRestore = React.useCallback((): void => restore(), [restore]);

  const closeCrop = React.useCallback((): void => {
    setPicked(null);
    reset();
  }, [reset]);

  // A finished upload closes the dialog; a failed one leaves it open with the
  // crop intact, so retrying does not mean cropping again.
  React.useEffect(() => {
    if (done) closeCrop();
  }, [closeCrop, done]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type='button'
            aria-label={t('studio.container.card.more')}
            variant={null}
            size={null}
            className='absolute right-[7px] top-[7px] z-10 flex h-[var(--btn-compact)] w-[var(--btn-compact)] items-center justify-center rounded-chrome bg-black/45 text-white opacity-0 transition-opacity hover:bg-black/70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 data-[state=open]:opacity-100'
          >
            <MoreHorizontal className='h-3.5 w-3.5' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' data-testid='project-card-menu'>
          {project.canManageMeta ? (
            <>
              <DropdownMenuItem onSelect={openRename}>
                <Pencil className='h-4 w-4' />
                {t('studio.container.card.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openPicker}>
                <ImageUp className='h-4 w-4' />
                {t('studio.container.cover.menuUpload')}
              </DropdownMenuItem>
            </>
          ) : null}
          {project.canDuplicate ? (
            <DropdownMenuItem onSelect={runDuplicate} disabled={actions.pending}>
              <Copy className='h-4 w-4' />
              {t('studio.container.card.duplicate')}
            </DropdownMenuItem>
          ) : null}
          {project.canArchive ? (
            <>
              {project.canManageMeta || project.canDuplicate ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={openArchive} disabled={actions.pending}>
                <Archive className='h-4 w-4' />
                {t('studio.container.card.archive')}
              </DropdownMenuItem>
            </>
          ) : null}
          {project.canRestore ? (
            <DropdownMenuItem onSelect={runRestore} disabled={actions.pending}>
              <ArchiveRestore className='h-4 w-4' />
              {t('studio.container.card.restore')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {project.canManageMeta ? (
        <>
          <input
            ref={inputRef}
            type='file'
            accept='image/*'
            hidden
            onChange={handlePick}
            data-testid='project-cover-input'
          />
          <ImageCropDialog
            variant='cover'
            file={picked}
            uploading={cover.uploading}
            error={cover.error}
            onCancel={closeCrop}
            onConfirm={cover.upload}
          />
          <RenameProjectDialog
            open={renaming}
            onOpenChange={setRenaming}
            currentName={project.name}
            onRename={renameTo}
          />
        </>
      ) : null}
      {project.canArchive ? (
        <ArchiveProjectDialog
          open={confirmingArchive}
          onOpenChange={setConfirmingArchive}
          name={project.name}
          onConfirm={runArchive}
        />
      ) : null}
    </>
  );
}
