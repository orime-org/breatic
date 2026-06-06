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
import { useTranslation } from '@web/i18n/use-translation';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import {
  STUDIO_SLUG_BOUNDS,
  validateStudioSlug,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';
import type { StudioType } from '@web/pages/studio/shared/studio-types';

/** The values entered into the new-studio dialog. */
export interface NewStudioValues {
  name: string;
  slug: string;
  type: StudioType;
}

interface NewStudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing studio slugs, for the global-uniqueness check (§5.7). */
  takenSlugs: ReadonlySet<string>;
  /** Called with the entered values on a valid submit (stub in slice 3). */
  onCreate?: (values: NewStudioValues) => void;
}

/**
 * The new-studio dialog (spec §3.12) — name + personal/team type + slug. Studio
 * slugs are globally unique, so the slug is validated for shape, reserved words
 * and uniqueness (`validateStudioSlug`). On a valid submit it reports the
 * values and closes; the real create wires to the API in Phase 2. The primary
 * button uses the studio brand color (§1.2).
 * @param props the open state, taken slugs and create callback.
 * @param props.open whether the dialog is open.
 * @param props.onOpenChange called when the open state should change.
 * @param props.takenSlugs the studio slugs already in use.
 * @param props.onCreate called with the entered values on a valid submit.
 * @returns the new-studio dialog.
 */
export function NewStudioDialog({
  open,
  onOpenChange,
  takenSlugs,
  onCreate,
}: NewStudioDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [type, setType] = React.useState<StudioType>('personal');
  const [slugError, setSlugError] = React.useState<SlugError>(null);
  const [submitted, setSubmitted] = React.useState(false);

  /**
   * Clear all form fields back to their initial empty state.
   */
  const reset = (): void => {
    setName('');
    setSlug('');
    setType('personal');
    setSlugError(null);
    setSubmitted(false);
  };

  /**
   * Propagate the open change, resetting the form when closing.
   * @param next the next value.
   */
  const handleOpenChange = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      reset();
    }
  };

  /**
   * Update the slug and re-validate once a submit has been attempted.
   * @param next the next value.
   */
  const handleSlugChange = (next: string): void => {
    setSlug(next);
    if (submitted) {
      setSlugError(validateStudioSlug(next, takenSlugs));
    }
  };

  /**
   * Validate the form and report the values on a successful submit.
   * @param event the form submit event.
   */
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    const error = validateStudioSlug(slug, takenSlugs);
    setSlugError(error);
    if (name.trim() === '' || error !== null) {
      return;
    }
    onCreate?.({ name: name.trim(), slug, type });
    handleOpenChange(false);
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
            <fieldset className='flex flex-col gap-1.5'>
              <legend className='text-sm font-medium'>
                {t('studio.container.dialog.typeLabel')}
              </legend>
              <div className='flex gap-4 text-sm'>
                <label className='flex items-center gap-1.5'>
                  <input
                    type='radio'
                    name='new-studio-type'
                    value='personal'
                    checked={type === 'personal'}
                    onChange={() => setType('personal')}
                  />
                  {t('studio.container.dialog.typePersonal')}
                </label>
                <label className='flex items-center gap-1.5'>
                  <input
                    type='radio'
                    name='new-studio-type'
                    value='team'
                    checked={type === 'team'}
                    onChange={() => setType('team')}
                  />
                  {t('studio.container.dialog.typeTeam')}
                </label>
              </div>
            </fieldset>
            <SlugField
              id='new-studio-slug'
              label={t('studio.container.dialog.slugLabel')}
              placeholder={t('studio.container.dialog.slugPlaceholder')}
              value={slug}
              onChange={handleSlugChange}
              error={slugError}
              bounds={STUDIO_SLUG_BOUNDS}
            />
          </DialogBody>
          <DialogFooter>
            <Button
              type='button'
              variant='ghost'
              onClick={() => handleOpenChange(false)}
            >
              {t('studio.container.dialog.cancel')}
            </Button>
            <Button
              type='submit'
              className='bg-primary text-primary-foreground hover:opacity-90'
            >
              {t('studio.container.dialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
