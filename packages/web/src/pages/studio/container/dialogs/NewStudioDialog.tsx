// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

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
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';

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

  // Map the live availability status onto the SlugField's error / availability
  // props (invalid + taken render as a destructive error line; checking +
  // available render as a muted line).
  const slugError =
    availability.status === 'invalid' || availability.status === 'taken'
      ? (availability.reason ?? null)
      : null;
  const slugLive =
    availability.status === 'checking'
      ? ('checking' as const)
      : availability.status === 'available'
        ? ('available' as const)
        : undefined;

  const canSubmit =
    name.trim() !== '' &&
    availability.status === 'available' &&
    !createStudio.isPending;

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
        onError: (err) =>
          setFormError(
            err instanceof ApiException
              ? err.message
              : t('studio.container.dialog.createStudioError'),
          ),
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
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <SlugField
              id='new-studio-slug'
              label={t('studio.container.dialog.slugLabel')}
              placeholder={t('studio.container.dialog.slugPlaceholder')}
              value={slug}
              onChange={setSlug}
              error={slugError}
              bounds={STUDIO_SLUG_BOUNDS}
              availability={slugLive}
            />
            {formError ? (
              <p className='text-xs text-destructive' role='alert'>
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
