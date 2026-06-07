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
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import {
  ITEM_SLUG_BOUNDS,
  validateItemSlug,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';
import type { ItemVisibility } from '@web/pages/studio/shared/studio-types';

/** The values entered into a new-project / new-collection dialog. */
export interface NewItemValues {
  name: string;
  slug: string;
  description: string;
  /** `studio` = visible to every studio member (open baseline) | `private`. */
  visibility: ItemVisibility;
}

interface NewItemDialogProps {
  kind: 'project' | 'collection';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the entered values on a valid submit (stub in slice 3). */
  onCreate?: (values: NewItemValues) => void;
}

/**
 * The new-project / new-collection dialog (spec §3.12) — a shared form (name +
 * slug + optional description) parameterized by kind. Project / collection
 * slugs are not unique, so only shape is validated (`validateItemSlug`). On a
 * valid submit it reports the values and closes; the real create wires to the
 * API in Phase 2. The primary button uses the studio brand color (§1.2).
 * @param props the kind, open state and create callback.
 * @param props.kind the dialog / collection kind.
 * @param props.open whether the dialog is open.
 * @param props.onOpenChange called when the open state should change.
 * @param props.onCreate called with the entered values on a valid submit.
 * @returns the create dialog.
 */
export function NewItemDialog({
  kind,
  open,
  onOpenChange,
  onCreate,
}: NewItemDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [visibility, setVisibility] = React.useState<ItemVisibility>('studio');
  const [slugError, setSlugError] = React.useState<SlugError>(null);
  const [submitted, setSubmitted] = React.useState(false);

  /**
   * Clear all form fields back to their initial empty state.
   */
  const reset = (): void => {
    setName('');
    setSlug('');
    setDescription('');
    setVisibility('studio');
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
      setSlugError(validateItemSlug(next));
    }
  };

  /**
   * Validate the form and report the values on a successful submit.
   * @param event the form submit event.
   */
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    const error = validateItemSlug(slug);
    setSlugError(error);
    if (name.trim() === '' || error !== null) {
      return;
    }
    onCreate?.({
      name: name.trim(),
      slug,
      description: description.trim(),
      visibility,
    });
    handleOpenChange(false);
  };

  const title =
    kind === 'project'
      ? t('studio.container.dialog.newProjectTitle')
      : t('studio.container.dialog.newCollectionTitle');
  const nameId = `new-${kind}-name`;
  const slugId = `new-${kind}-slug`;
  const descId = `new-${kind}-desc`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid={`new-${kind}-dialog`}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody className='flex flex-col gap-4'>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor={nameId}>
                {t('studio.container.dialog.nameLabel')}
              </Label>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('studio.container.dialog.namePlaceholder')}
                required
              />
            </div>
            <SlugField
              id={slugId}
              label={t('studio.container.dialog.slugLabel')}
              placeholder={t('studio.container.dialog.slugPlaceholder')}
              value={slug}
              onChange={handleSlugChange}
              error={slugError}
              bounds={ITEM_SLUG_BOUNDS}
            />
            <fieldset className='flex flex-col gap-1.5'>
              <legend className='text-sm font-medium'>
                {t('studio.container.dialog.visibilityLabel')}
              </legend>
              <div className='flex flex-col gap-1.5 text-sm'>
                <label className='flex items-center gap-1.5'>
                  <input
                    type='radio'
                    name={`new-${kind}-visibility`}
                    value='studio'
                    checked={visibility === 'studio'}
                    onChange={() => setVisibility('studio')}
                  />
                  {t('studio.container.dialog.visibilityStudioOption')}
                </label>
                <label className='flex items-center gap-1.5'>
                  <input
                    type='radio'
                    name={`new-${kind}-visibility`}
                    value='private'
                    checked={visibility === 'private'}
                    onChange={() => setVisibility('private')}
                  />
                  {t('studio.container.dialog.visibilityPrivateOption')}
                </label>
              </div>
            </fieldset>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor={descId}>
                {t('studio.container.dialog.descriptionLabel')}
              </Label>
              <Textarea
                id={descId}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
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
