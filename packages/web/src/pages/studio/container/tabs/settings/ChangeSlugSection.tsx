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
  /**
   * Whether THIS rename is in flight.
   *
   * Not "a save is in flight". The name and the slug ride the same mutation,
   * so the broader flag would let a name save hold this dialog shut over a
   * rename nobody submitted.
   */
  renaming: boolean;
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
 * @param props - The studio, whether this rename is running, and the handler.
 * @param props.studio - The studio being renamed.
 * @param props.renaming - Whether this rename is already in flight.
 * @param props.onSave - Called with the slug patch once confirmed.
 * @returns The entry button and its dialog.
 */
export function ChangeSlugSection({
  studio,
  renaming,
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
  const canConfirm = changed && availability.status === 'available' && !renaming;
  // The sentence in the header names both ends of the move. Until there is a
  // destination it stays a placeholder: on open both ends hold the same slug,
  // and "the address changes from X to X" is not a thing to greet someone
  // with.
  const destination = changed && next !== '' ? next : '…';

  const onOpenChange = React.useCallback(
    (nextOpen: boolean): void => {
      // Closing mid-request would leave the rename running with nothing
      // listening for its answer, and would take the typed slug with it — the
      // one thing a failure is supposed not to cost.
      //
      // This one line covers every way out, because every one of them ends
      // here: Escape and clicking outside both reach Radix's `onDismiss`,
      // which calls `onOpenChange(false)`; the header's X is a
      // `DialogPrimitive.Close`, which calls the same; and Cancel calls it
      // directly. Guarding the dismissal events individually as well was
      // tried and removed — deleting those handlers left every one of the
      // four cases below still passing, so they were not holding anything up.
      if (!nextOpen && renaming) return;
      setOpen(nextOpen);
      // Both directions: an abandoned draft must not be waiting when the
      // dialog is opened again.
      setSlug(studio.slug);
    },
    [renaming, studio.slug],
  );

  const confirm = React.useCallback((): void => {
    // Deliberately does not close. On success this whole tab unmounts, because
    // the address it is standing on has just been released; the only state in
    // which the dialog is still here afterwards is a failed one, and closing
    // it there would throw away what the user typed.
    //
    // That unmount is not this component's doing and is worth knowing about
    // before changing either end: `StudioContainerPage` keys its query on the
    // slug in the route, so the navigation the settings hook performs lands on
    // a key with nothing cached, and its pending branch replaces the whole tab
    // area. A future change that keeps the old data on screen during that
    // switch would leave this dialog standing open over a successful rename.
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
        <DialogContent
          data-testid='settings-slug-dialog'
        >
          <DialogHeader>
            <DialogTitle>
              {t('studio.container.settings.slugChangeTitle')}
            </DialogTitle>
            <DialogDescription data-testid='settings-slug-body'>
              {t('studio.container.settings.slugChangeBody', {
                oldSlug: studio.slug,
                newSlug: destination,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className='flex flex-col gap-3'>
            <SlugField
              id='danger-slug'
              label={t('studio.container.settings.slug')}
              value={slug}
              onChange={setSlug}
              disabled={renaming}
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
                {renaming
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
