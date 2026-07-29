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
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import { STUDIO_SLUG_BOUNDS } from '@web/pages/studio/container/dialogs/slug-util';
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';
import type { StudioDetail } from '@web/pages/studio/container/container-types';
import type { UpdateStudioInput } from '@breatic/shared';

/** Matches the server's `bio` bound, so the counter and the API agree. */
const BIO_MAX = 500;

/** Matches the server's `name` bound. */
const NAME_MAX = 255;

interface BasicInfoSectionProps {
  studio: StudioDetail;
  /** Whether the viewer may edit these fields (admins only). */
  canEdit: boolean;
  saving: boolean;
  onSave: (patch: UpdateStudioInput) => void;
}

/**
 * The studio's own details: name, `Slug` and bio.
 *
 * `Slug` lives here rather than in the danger zone even though changing it is
 * the destructive one, because the danger zone does not exist for a personal
 * studio — and a personal studio's slug is its owner's `@handle`, which they
 * must be able to change. The weight of the action is carried by a
 * confirmation spelling out the consequences, not by which box it sits in.
 *
 * Only changed fields are sent. Submitting a field at its current value would
 * be harmless for the name and bio, but for the slug it would mean releasing
 * and re-taking the same handle, which is a real (if brief) window where
 * someone else could claim it.
 * @param props - The studio, the viewer's permission and the save wiring.
 * @param props.studio - The studio being edited.
 * @param props.canEdit - Whether the fields are editable.
 * @param props.saving - Whether a save is in flight.
 * @param props.onSave - Called with the changed fields only.
 * @returns The basic-info section.
 */
export function BasicInfoSection({
  studio,
  canEdit,
  saving,
  onSave,
}: BasicInfoSectionProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState(studio.name);
  const [slug, setSlug] = React.useState(studio.slug);
  const [bio, setBio] = React.useState(studio.bio ?? '');
  const [confirmingSlug, setConfirmingSlug] = React.useState(false);

  // A save (or someone else's edit arriving) re-seeds the fields.
  React.useEffect(() => {
    setName(studio.name);
    setSlug(studio.slug);
    setBio(studio.bio ?? '');
  }, [studio.bio, studio.name, studio.slug]);

  const availability = useSlugAvailability(slug, { ownSlug: studio.slug });

  const patch = React.useMemo((): UpdateStudioInput => {
    const next: UpdateStudioInput = {};
    if (name.trim() !== studio.name) next.name = name.trim();
    if (slug.trim() !== studio.slug) next.slug = slug.trim();
    if (bio.trim() !== (studio.bio ?? '')) next.bio = bio.trim();
    return next;
  }, [bio, name, slug, studio.bio, studio.name, studio.slug]);

  const slugChanged = patch.slug !== undefined;
  const dirty = Object.keys(patch).length > 0;
  const slugBlocked =
    slugChanged &&
    (availability.status === 'invalid' ||
      availability.status === 'taken' ||
      availability.status === 'checking');
  const canSubmit = canEdit && dirty && !saving && !slugBlocked;

  const submit = React.useCallback((): void => {
    if (slugChanged) {
      setConfirmingSlug(true);
      return;
    }
    onSave(patch);
  }, [onSave, patch, slugChanged]);

  const confirmSlug = React.useCallback((): void => {
    setConfirmingSlug(false);
    onSave(patch);
  }, [onSave, patch]);

  return (
    <section className='flex flex-col gap-4'>
      <h3 className='text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground'>
        {t('studio.container.settings.basicTitle')}
      </h3>

      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='studio-name'>
          {t('studio.container.settings.name')}
        </Label>
        <Input
          id='studio-name'
          value={name}
          maxLength={NAME_MAX}
          disabled={!canEdit || saving}
          onChange={(e) => setName(e.target.value)}
          data-testid='settings-name'
        />
      </div>

      <SlugField
        id='studio-slug'
        label={t('studio.container.settings.slug')}
        value={slug}
        onChange={setSlug}
        error={
          availability.status === 'invalid' || availability.status === 'taken'
            ? (availability.reason ?? null)
            : null
        }
        bounds={STUDIO_SLUG_BOUNDS}
        helper={t('studio.container.settings.slugHelper')}
        availability={
          availability.status === 'checking'
            ? 'checking'
            : availability.status === 'available' && slugChanged
              ? 'available'
              : undefined
        }
      />

      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='studio-bio'>
          {t('studio.container.settings.description')}
        </Label>
        <Textarea
          id='studio-bio'
          value={bio}
          maxLength={BIO_MAX}
          rows={3}
          disabled={!canEdit || saving}
          onChange={(e) => setBio(e.target.value)}
          data-testid='settings-bio'
        />
        <span className='self-end text-2xs text-muted-foreground'>
          {t('studio.container.settings.bioCount', {
            count: bio.length,
            max: BIO_MAX,
          })}
        </span>
      </div>

      {canEdit ? (
        <div className='flex justify-end'>
          <Button
            size='form'
            disabled={!canSubmit}
            onClick={submit}
            data-testid='settings-save'
          >
            {saving
              ? t('studio.container.settings.saving')
              : t('studio.container.settings.save')}
          </Button>
        </div>
      ) : null}

      <AlertDialog open={confirmingSlug} onOpenChange={setConfirmingSlug}>
        <AlertDialogContent data-testid='settings-slug-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('studio.container.settings.slugChangeTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('studio.container.settings.slugChangeBody', {
                oldSlug: studio.slug,
                newSlug: patch.slug ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className='list-disc pl-5 text-xs text-muted-foreground'>
            <li>{t('studio.container.settings.slugChangeLinks')}</li>
            <li>{t('studio.container.settings.slugChangeReleased')}</li>
            <li>{t('studio.container.settings.slugChangeNoRedirect')}</li>
            <li>
              {studio.type === 'personal'
                ? t('studio.container.settings.slugChangeHandle')
                : t('studio.container.settings.slugChangeMembers')}
            </li>
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('studio.container.dialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmSlug}
              data-testid='settings-slug-confirm'
            >
              {t('studio.container.settings.slugChangeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
