// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { useTranslation } from '@web/i18n/use-translation';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import { STUDIO_SLUG_BOUNDS } from '@web/pages/studio/container/dialogs/slug-util';
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';
import { DANGER_BUTTON } from '@web/pages/studio/container/tabs/settings/danger-button';
import type { StudioDetail } from '@web/pages/studio/container/container-types';
import type { UpdateStudioInput } from '@breatic/shared';

interface ChangeSlugSectionProps {
  studio: StudioDetail;
  /** Whether a settings save is already in flight. */
  saving: boolean;
  onSave: (patch: UpdateStudioInput) => void;
}

/**
 * The danger zone's "Change Slug" entry: a button, and a dialog holding the
 * input, the live availability check and what the change costs.
 *
 * It sits here rather than beside the display name because it is the same
 * weight as deleting: every existing link to this studio 404s, the old handle
 * is free for anyone to claim the same second, and none of it can be undone.
 * A personal studio gets this box for that one reason — its slug is its
 * owner's `@handle`.
 *
 * The shape mirrors the transfer entry next to it (a button that opens a
 * dialog); the wiring does not. Transferring owns its own request because
 * nothing moves afterwards, whereas a rename leaves the page standing on an
 * address that no longer exists — so this one goes through the settings hook's
 * `save`, which owns the five steps that have to follow.
 * @param props - The studio, whether a save is running, and the save handler.
 * @param props.studio - The studio being renamed.
 * @param props.saving - Whether a save is already in flight.
 * @param props.onSave - Called with the slug patch once confirmed.
 * @returns The entry button and its dialog.
 */
export function ChangeSlugSection({
  studio,
  saving,
  onSave,
}: ChangeSlugSectionProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [slug, setSlug] = React.useState(studio.slug);

  const availability = useSlugAvailability(slug, { ownSlug: studio.slug });
  const next = slug.trim();
  const changed = next !== studio.slug;
  // Written as "only when available", never as "unless invalid": an emptied
  // field reports neither, it reports `idle`, and a gate phrased the other way
  // walks the user through a destructive confirmation the server then refuses.
  const canConfirm = changed && availability.status === 'available' && !saving;

  const onOpenChange = React.useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen);
      // Both directions: an abandoned draft must not be waiting when the
      // dialog is opened again.
      setSlug(studio.slug);
    },
    [studio.slug],
  );

  const confirm = React.useCallback((): void => {
    // Deliberately does not close. On success this whole tab unmounts, because
    // the address it is standing on has just been released; the only state in
    // which the dialog is still here afterwards is a failed one, and closing
    // it there would throw away what the user typed.
    onSave({ slug: next });
  }, [next, onSave]);

  return (
    <>
      <button
        type='button'
        className={DANGER_BUTTON}
        onClick={() => setOpen(true)}
        data-testid='settings-slug-open'
      >
        {t('studio.container.settings.slugChangeOpen')}
      </button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid='settings-slug-dialog'>
          <DialogHeader>
            <DialogTitle>
              {t('studio.container.settings.slugChangeTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('studio.container.settings.slugChangeBody', {
                oldSlug: studio.slug,
                newSlug: next === '' ? '…' : next,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className='flex flex-col gap-3'>
            <SlugField
              id='danger-slug'
              label={t('studio.container.settings.slug')}
              value={slug}
              onChange={setSlug}
              disabled={saving}
              error={
                availability.status === 'invalid' ||
                availability.status === 'taken'
                  ? (availability.reason ?? null)
                  : null
              }
              bounds={STUDIO_SLUG_BOUNDS}
              helper={t('studio.container.settings.slugHelper')}
              availability={
                availability.status === 'checking'
                  ? 'checking'
                  : availability.status === 'available' && changed
                    ? 'available'
                    : undefined
              }
            />
            <ul className='list-disc pl-5 text-xs text-muted-foreground'>
              <li>{t('studio.container.settings.slugChangeLinks')}</li>
              <li>{t('studio.container.settings.slugChangeReleased')}</li>
              <li>{t('studio.container.settings.slugChangeNoRedirect')}</li>
              <li>{t('studio.container.settings.slugChangeMovesYou')}</li>
              <li>
                {studio.type === 'personal'
                  ? t('studio.container.settings.slugChangeHandle')
                  : t('studio.container.settings.slugChangeMembers')}
              </li>
            </ul>
            <div className='flex items-center justify-end gap-2'>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => onOpenChange(false)}
                data-testid='settings-slug-cancel'
              >
                {t('studio.container.dialog.cancel')}
              </Button>
              <Button
                size='sm'
                disabled={!canConfirm}
                onClick={confirm}
                data-testid='settings-slug-confirm'
              >
                {saving
                  ? t('studio.container.settings.saving')
                  : t('studio.container.settings.slugChangeConfirm')}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
