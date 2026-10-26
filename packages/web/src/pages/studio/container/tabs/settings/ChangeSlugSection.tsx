// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import {
  useSlugAvailability,
  useSlugFieldShown,
} from '@web/pages/studio/container/dialogs/use-slug-availability';
import { useWaitForSlugCheck } from '@web/pages/studio/container/dialogs/use-wait-for-slug-check';
import { DANGER_BUTTON } from '@web/pages/studio/container/tabs/settings/danger-button';
import type { StudioDetail } from '@web/pages/studio/container/container-types';
import type { UpdateStudioInput } from '@breatic/shared';

interface ChangeSlugSectionProps {
  studio: StudioDetail;
  /**
   * Whether ANY settings save is in flight — a press of Confirm does nothing.
   *
   * The name, the description and the slug are one mutation, and firing a
   * second one replaces the first on its observer without stopping the request
   * it already sent. Two patches would then be out at once, both addressed to
   * the slug the studio had when the pair started.
   */
  saving: boolean;
  /**
   * Whether THIS rename is the thing in flight — this draws the spinner.
   *
   * Deliberately the narrower of the two: a spinner is a claim about what is
   * running, and a name save must not make this button claim to be renaming.
   * It drives both the spinner and the button's label. Getting it wrong costs
   * an inaccurate button and nothing else, which is why the question that has
   * to be inferred drives what the button says rather than whether a press
   * goes out.
   */
  renaming: boolean;
  onSave: (patch: UpdateStudioInput, slugFieldShown?: () => boolean) => void;
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
 * `save`, which owns everything that has to follow it.
 *
 * While the request is out the button carries a spinner and the dialog stays
 * dismissible, which is how Ant Design, Bootstrap, Chakra and Radix all treat
 * it — the in-progress state and the ability to leave are separate concerns,
 * and every one of them defaults to dismissible. An earlier version locked the
 * dialog instead, reasoned from the avatar upload dialog next door; that one
 * locks because closing mid-upload abandons an upload, and a rename has no
 * equivalent, since success navigates away and failure is reported on the slug
 * line while the dialog shows it, otherwise by a toast.
 * @param props - The studio, the two in-flight flags, and the save handler.
 * @param props.studio - The studio being renamed.
 * @param props.saving - Whether any settings save is in flight.
 * @param props.renaming - Whether this rename in particular is in flight.
 * @param props.onSave - Called with the slug patch once confirmed.
 * @returns The entry button and its dialog.
 */
export function ChangeSlugSection({
  studio,
  saving,
  renaming,
  onSave,
}: ChangeSlugSectionProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [slug, setSlug] = React.useState(studio.slug);
  const [slugError, setSlugError] = React.useState<string | null>(null);

  const availability = useSlugAvailability(slug, { ownSlug: studio.slug });
  const next = slug.trim();
  const changed = next !== studio.slug;
  // The sentence in the header names both ends of the move. Until there is a
  // destination it stays a placeholder: on open both ends hold the same slug,
  // and "the address changes from X to X" is not a thing to greet someone
  // with.
  const destination = changed && next !== '' ? next : '…';

  // The studio can change under a mounted dialog: switching to an already
  // cached studio in the rail re-renders these components rather than
  // rebuilding them. A draft seeded once at mount would then describe somebody
  // else — the dialog would open on an address change nobody asked for, and
  // the availability check would ask about the OTHER studio's slug and be
  // told, truthfully, that it is taken.
  React.useEffect(() => {
    setSlug(studio.slug);
  }, [studio.slug]);

  const fieldShows = useSlugFieldShown(open, slug);

  const onOpenChange = React.useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen);
      // Both directions: an abandoned draft must not be waiting when the
      // dialog is opened again.
      setSlug(studio.slug);
      setSlugError(null);
    },
    [studio.slug],
  );

  /**
   * Send the new slug, or say on the slug line why not (inner#1652). Runs
   * again once a check it waited on settles.
   */
  const attempt = (): void => {
    if (saving) return;
    // Nothing to change: confirming it is already done.
    if (!changed) {
      onOpenChange(false);
      return;
    }
    setSlugError(next === '' ? t('studio.container.dialog.slugRequired') : null);
    if (availability.state === 'checking') {
      wait.start();
      return;
    }
    // Only when valid (or unverifiable), never merely "not invalid": an
    // emptied field reports neither, it reports `empty`, and a check phrased
    // the other way walks the user into a destructive change the server then
    // refuses.
    if (availability.state !== 'valid' && availability.state !== 'unverified') {
      document.getElementById('danger-slug')?.focus();
      return;
    }
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
    onSave({ slug: next }, () => fieldShows(next));
  };
  const wait = useWaitForSlugCheck(availability, slug, open, attempt);

  return (
    <>
      <Button
        type='button'
        variant={null}
        size={null}
        className={DANGER_BUTTON}
        onClick={() => setOpen(true)}
        data-testid='settings-slug-open'
      >
        {t('studio.container.settings.slugChangeOpen')}
      </Button>

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
              onChange={(value) => {
                setSlug(value);
                setSlugError(null);
              }}
              readOnly={saving}
              // The hook answers `valid` for the studio's own slug; here
              // that is no news, so the field goes back to its description.
              check={changed ? availability : { state: 'empty' }}
              error={slugError}
              bounds={STUDIO_SLUG_BOUNDS}
              helper={t('studio.container.dialog.slugHelperStudio', STUDIO_SLUG_BOUNDS)}
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
                variant='outline'
                size='sm'
                onClick={() => onOpenChange(false)}
                data-testid='settings-slug-cancel'
              >
                {t('studio.container.dialog.cancel')}
              </Button>
              <Button
                size='sm'
                loading={renaming || wait.waiting}
                onClick={attempt}
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
