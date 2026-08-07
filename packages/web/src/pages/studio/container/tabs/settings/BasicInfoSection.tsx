// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
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
 * The studio's display details: its name and its description.
 *
 * Both are freely editable and freely reversible — nothing outside this studio
 * depends on either. The slug is not here: changing it breaks every link that
 * points at this studio and releases the name for anyone to take, so it lives
 * in the danger zone with the other things that cannot be undone.
 *
 * Only changed fields are sent, so a save that touched neither is not a save.
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
  const [bio, setBio] = React.useState(studio.bio ?? '');

  // A save (or someone else's edit arriving) re-seeds the fields.
  React.useEffect(() => {
    setName(studio.name);
    setBio(studio.bio ?? '');
  }, [studio.bio, studio.name]);

  const patch = React.useMemo((): UpdateStudioInput => {
    const next: UpdateStudioInput = {};
    if (name.trim() !== studio.name) next.name = name.trim();
    if (bio.trim() !== (studio.bio ?? '')) next.bio = bio.trim();
    return next;
  }, [bio, name, studio.bio, studio.name]);

  const dirty = Object.keys(patch).length > 0;
  // The name has no availability check to lean on, so its emptiness is tested
  // here or nowhere: a blank one would otherwise reach the server and come
  // back as a validation error the form could have refused itself.
  const nameBlocked = patch.name !== undefined && patch.name === '';
  const canSubmit = canEdit && dirty && !saving && !nameBlocked;

  const submit = React.useCallback((): void => onSave(patch), [onSave, patch]);

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
    </section>
  );
}
