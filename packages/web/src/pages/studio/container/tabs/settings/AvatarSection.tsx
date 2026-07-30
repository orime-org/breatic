// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { AvatarCropDialog } from '@web/pages/studio/container/dialogs/AvatarCropDialog';
import { checkAvatarFile } from '@web/pages/studio/container/dialogs/avatar-image';
import { StudioAvatar } from '@web/ui/StudioAvatar';
import type { StudioDetail } from '@web/pages/studio/container/container-types';

interface AvatarSectionProps {
  studio: StudioDetail;
  /** Whether the viewer may change the avatar (admins only). */
  canEdit: boolean;
  uploading: boolean;
  /** The last upload failure, shown inside the crop dialog. */
  error: string | null;
  onUpload: (image: Blob) => void;
  onRemove: () => void;
  /** Drops a stale upload failure when the picker is dismissed. */
  onDismissError: () => void;
}

/**
 * The avatar row of the settings tab: the current avatar, and — for an admin —
 * the controls to replace or clear it.
 *
 * A non-admin sees the avatar with no controls at all rather than disabled
 * ones: there is nothing for them to do here, and a greyed-out button reads as
 * "temporarily unavailable" rather than "not yours".
 *
 * The file input is `hidden` rather than visually hidden. The native button is
 * drawn by the operating system, so it cannot appear in the UI; but a
 * screen-reader-only input would still sit in the tab order, giving keyboard
 * users an invisible stop. `hidden` removes it from both, and the visible
 * button drives it.
 * @param props - The studio, the viewer's permission, and the upload wiring.
 * @param props.studio - The studio whose avatar this is.
 * @param props.canEdit - Whether to render the controls at all.
 * @param props.uploading - Whether an upload is in flight.
 * @param props.error - The last upload failure.
 * @param props.onUpload - Called with the cropped, encoded avatar.
 * @param props.onRemove - Called to clear the avatar.
 * @param props.onDismissError - Called when the picker is dismissed.
 * @returns The avatar section.
 */
export function AvatarSection({
  studio,
  canEdit,
  uploading,
  error,
  onUpload,
  onRemove,
  onDismissError,
}: AvatarSectionProps): React.JSX.Element {
  const t = useTranslation();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = React.useState<File | null>(null);
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);

  const handlePick = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0] ?? null;
      // Reset so picking the same file twice in a row still fires a change.
      event.target.value = '';
      if (file === null) return;
      const problem = checkAvatarFile(file);
      if (problem !== null) {
        toast.warning(t(`studio.container.settings.avatarError.${problem}`));
        return;
      }
      setPicked(file);
    },
    [t],
  );

  const handleConfirm = React.useCallback(
    (image: Blob): void => onUpload(image),
    [onUpload],
  );

  // A finished upload closes the dialog; a failed one leaves it open with the
  // crop intact, so retrying does not mean cropping again.
  //
  // Keyed on the upload FINISHING, not on the current state: a studio that
  // already has an avatar satisfies "not uploading, no error, avatar present"
  // the instant a file is picked, which would slam the dialog shut before it
  // ever appeared.
  const wasUploading = React.useRef(false);
  React.useEffect(() => {
    if (wasUploading.current && !uploading && error === null) setPicked(null);
    wasUploading.current = uploading;
  }, [error, uploading]);

  return (
    <div className='flex items-center gap-4'>
      <StudioAvatar
        name={studio.name}
        type={studio.type}
        avatarUrl={studio.avatarUrl}
        size='xl'
      />
      {canEdit ? (
        <div className='flex flex-col gap-2'>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => inputRef.current?.click()}
              data-testid='avatar-upload-open'
            >
              {t('studio.container.settings.avatarUpload')}
            </Button>
            {studio.avatarUrl === null ? null : (
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setConfirmingRemove(true)}
                data-testid='avatar-remove-open'
              >
                {t('studio.container.settings.avatarRemove')}
              </Button>
            )}
          </div>
          <p className='text-xs text-muted-foreground'>
            {t('studio.container.settings.avatarHint')}
          </p>
          <input
            ref={inputRef}
            type='file'
            accept='image/*'
            hidden
            onChange={handlePick}
            data-testid='avatar-file-input'
          />
        </div>
      ) : null}

      <AvatarCropDialog
        file={picked}
        uploading={uploading}
        error={error}
        onCancel={() => {
          setPicked(null);
          // Dismissing ends the attempt the error belonged to; leaving it set
          // would greet the next picked image with it.
          onDismissError();
        }}
        onConfirm={handleConfirm}
      />

      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogContent data-testid='avatar-remove-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('studio.container.settings.avatarRemoveTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('studio.container.settings.avatarRemoveBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('studio.container.dialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onRemove}
              data-testid='avatar-remove-confirm'
            >
              {t('studio.container.settings.avatarRemove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
