// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { ImageUp, MoreHorizontal } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useProjectCover } from '@web/pages/studio/container/cards/use-project-cover';
import { ImageCropDialog } from '@web/pages/studio/container/dialogs/ImageCropDialog';
import { checkPickedFile } from '@web/pages/studio/container/dialogs/crop-image';

interface ProjectCoverMenuProps {
  projectId: string;
  /** The studio whose Projects tab lists the project. */
  studioSlug: string;
}

/**
 * The `⋯` menu on a project card, shown to the project's owner. Its one entry
 * picks an image, crops it to the card's 16:9 and uploads it as the cover.
 *
 * The file input is `hidden` rather than visually hidden: the native control
 * is drawn by the operating system and has no place in the UI, and a
 * screen-reader-only input would still be an invisible stop in the tab order.
 * The menu entry drives it.
 * @param props - The project and its studio.
 * @param props.projectId - The project whose cover this changes.
 * @param props.studioSlug - The studio whose list is refreshed afterwards.
 * @returns The menu, its file picker and the crop dialog.
 */
export function ProjectCoverMenu({
  projectId,
  studioSlug,
}: ProjectCoverMenuProps): React.JSX.Element {
  const t = useTranslation();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = React.useState<File | null>(null);
  const { upload, uploading, error, done, reset } = useProjectCover(projectId, studioSlug);

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

  const close = React.useCallback((): void => {
    setPicked(null);
    reset();
  }, [reset]);

  // A finished upload closes the dialog; a failed one leaves it open with the
  // crop intact, so retrying does not mean cropping again.
  React.useEffect(() => {
    if (done) close();
  }, [close, done]);

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
          <DropdownMenuItem onSelect={openPicker}>
            <ImageUp className='h-4 w-4' />
            {t('studio.container.cover.menuUpload')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
        uploading={uploading}
        error={error}
        onCancel={close}
        onConfirm={upload}
      />
    </>
  );
}
