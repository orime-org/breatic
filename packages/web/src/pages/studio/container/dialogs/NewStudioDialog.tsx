// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import { STUDIO_SLUG_BOUNDS } from '@web/pages/studio/container/dialogs/slug-util';
import { useCreateStudio } from '@web/pages/studio/container/dialogs/use-create-studio';
import {
  slugFieldShowsConflict,
  useSlugAvailability,
} from '@web/pages/studio/container/dialogs/use-slug-availability';

interface NewStudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The create-team-studio dialog (rail segment ③ / spec §3.12). Two independent
 * hand-typed fields — display name + globally-unique slug (option C) — with the
 * slug checked live (debounced) via `useSlugAvailability`: the SlugField shows
 * checking / available / format / length / reserved / taken as you type. Submit
 * is gated on a non-empty name + an `available` slug. On submit `useCreateStudio`
 * creates the studio, refreshes the rail list and navigates into it; a server
 * error (taken slug lost a race, per-user limit, rate limit) surfaces inline.
 * The personal/team type radio and the synchronous `takenSlugs` set the old stub
 * carried are gone: a personal studio is created at registration, never here,
 * and global uniqueness can only be a server check, not a client-side set.
 * @param props the open state + change handler.
 * @param props.open whether the dialog is open.
 * @param props.onOpenChange called when the open state should change.
 * @returns the create-studio dialog.
 */
export function NewStudioDialog({
  open,
  onOpenChange,
}: NewStudioDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const availability = useSlugAvailability(slug);
  const createStudio = useCreateStudio();
  const queryClient = useQueryClient();
  // The slug the field shows right now, or null while the dialog is closed;
  // read after the 409 re-ask returns, by which time either may have changed.
  const shownSlugRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    shownSlugRef.current = open ? slug.trim() : null;
  }, [open, slug]);

  /** Clear the form back to empty (on close). */
  const reset = (): void => {
    setName('');
    setSlug('');
    setFormError(null);
  };

  /**
   * Propagate the open change, resetting the form when closing.
   * @param next the next open value.
   */
  const handleOpenChange = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      reset();
    }
  };

  const canSubmit =
    name.trim() !== '' &&
    availability.state === 'valid' &&
    !createStudio.isPending;

  /**
   * Put a refused create where the reader will look for it: a slug taken in
   * the meantime on the slug line while the dialog is open, anything else
   * under the form.
   * @param err - What the create threw.
   * @param submitted - The trimmed slug that was submitted.
   */
  const reportCreateError = async (
    err: unknown,
    submitted: string,
  ): Promise<void> => {
    if (
      await slugFieldShowsConflict(
        queryClient,
        err,
        submitted,
        () => shownSlugRef.current === submitted,
      )
    ) {
      return;
    }
    setFormError(
      err instanceof ApiException
        ? err.message
        : t('studio.container.dialog.createStudioError'),
    );
  };

  /**
   * Validate (slug must already be `available`) and create the studio.
   * @param event the form submit event.
   */
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setFormError(null);
    if (!canSubmit) {
      return;
    }
    createStudio.mutate(
      { name: name.trim(), slug: slug.trim() },
      {
        onSuccess: () => handleOpenChange(false),
        onError: (err) => {
          void reportCreateError(err, slug.trim());
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid='new-studio-dialog' aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('studio.container.dialog.newStudioTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody className='flex flex-col gap-4'>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='new-studio-name'>
                {t('studio.container.dialog.nameLabel')}
              </Label>
              <Input
                id='new-studio-name'
                autoComplete='off'
                placeholder={t('studio.container.dialog.namePlaceholderStudio')}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={createStudio.isPending}
                required
              />
            </div>
            <SlugField
              id='new-studio-slug'
              label={t('studio.container.dialog.slugLabel')}
              placeholder={t('studio.container.dialog.slugPlaceholderStudio')}
              value={slug}
              onChange={setSlug}
              disabled={createStudio.isPending}
              check={availability}
              bounds={STUDIO_SLUG_BOUNDS}
              helper={t('studio.container.dialog.slugHelperStudio', STUDIO_SLUG_BOUNDS)}
            />
            {formError ? (
              <p className='text-xs text-status-error-foreground' role='alert'>
                {formError}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => handleOpenChange(false)}
            >
              {t('studio.container.dialog.cancel')}
            </Button>
            <Button type='submit' disabled={!canSubmit}>
              {t('studio.container.dialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
