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
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import {
  StudioSelectField,
  type StudioOption,
} from '@web/pages/studio/container/dialogs/StudioSelectField';
import {
  ITEM_SLUG_BOUNDS,
  validateItemSlug,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';
import type { ItemVisibility } from '@web/pages/studio/shared/studio-types';
import { SpaceKindPicker } from '@web/spaces/SpaceKindPicker';
import { type SpaceType } from '@web/spaces';

/** The values entered into a new-project / new-collection dialog. */
export interface NewItemValues {
  name: string;
  slug: string;
  description: string;
  /** `studio` = visible to every studio member (open baseline) | `private`. */
  visibility: ItemVisibility;
  /**
   * The first space's type, seeded on create (project only — collections have
   * no spaces). Omitted for `kind='collection'`. Canvas is the only editable
   * type today; document/timeline are plumbed end-to-end but disabled in the
   * picker (B.2).
   */
  spaceType?: SpaceType;
  /**
   * The studio the project is created in (project only, chosen via the
   * selector). Omitted for collections and when no selector is rendered (no
   * `studios` passed — e.g. the standalone a11y test).
   */
  studioId?: string;
}

interface NewItemDialogProps {
  kind: 'project' | 'collection';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the entered values on a valid submit (stub in slice 3). */
  onCreate?: (values: NewItemValues) => void;
  /**
   * The studios the viewer may create in (project kind only; spec §7.1). When
   * given and non-empty, the dialog renders the studio selector. Omitted for
   * collections and in tests that only check the form shell.
   */
  studios?: readonly StudioOption[];
  /** The studio pre-selected when the dialog opens (`defaultCreateStudioId`). */
  defaultStudioId?: string;
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
 * @param props.studios the studios the viewer may create in (project kind).
 * @param props.defaultStudioId the studio pre-selected when the dialog opens.
 * @returns the create dialog.
 */
export function NewItemDialog({
  kind,
  open,
  onOpenChange,
  onCreate,
  studios,
  defaultStudioId,
}: NewItemDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [visibility, setVisibility] = React.useState<ItemVisibility>('studio');
  const [spaceType, setSpaceType] = React.useState<SpaceType>('canvas');
  const [studioId, setStudioId] = React.useState(defaultStudioId ?? '');
  const [slugError, setSlugError] = React.useState<SlugError>(null);
  const [submitted, setSubmitted] = React.useState(false);
  const showStudioSelect =
    kind === 'project' && studios !== undefined && studios.length > 0;

  // Pre-select the default studio each time the dialog opens (the studios list
  // and its default load asynchronously in the parent, so reading the prop once
  // at mount is not enough).
  React.useEffect(() => {
    if (open) {
      setStudioId(defaultStudioId ?? '');
    }
  }, [open, defaultStudioId]);

  /**
   * Clear all form fields back to their initial empty state.
   */
  const reset = (): void => {
    setName('');
    setSlug('');
    setDescription('');
    setVisibility('studio');
    setSpaceType('canvas');
    setStudioId(defaultStudioId ?? '');
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
      // A space type + target studio only apply to a project; collections have
      // neither spaces nor a studio selector, so both are omitted for them.
      ...(kind === 'project'
        ? { spaceType, ...(studioId !== '' ? { studioId } : {}) }
        : {}),
    });
    handleOpenChange(false);
  };

  const title =
    kind === 'project'
      ? t('studio.container.dialog.newProjectTitle')
      : t('studio.container.dialog.newCollectionTitle');
  const slugHelper =
    kind === 'project'
      ? t('studio.container.dialog.slugHelperProject')
      : t('studio.container.dialog.slugHelperCollection');
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
            {showStudioSelect ? (
              <StudioSelectField
                studios={studios}
                value={studioId}
                onChange={setStudioId}
                label={t('studio.container.dialog.studioLabel')}
                id={`new-${kind}-studio`}
              />
            ) : null}
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor={nameId}>
                {t('studio.container.dialog.nameLabel')}
              </Label>
              <Input
                id={nameId}
                autoComplete='off'
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('studio.container.dialog.namePlaceholder')}
                required
              />
            </div>
            {kind === 'project' ? (
              <SpaceKindPicker
                value={spaceType}
                onChange={setSpaceType}
                idPrefix={`new-${kind}-type`}
              />
            ) : null}
            <SlugField
              id={slugId}
              label={t('studio.container.dialog.slugLabel')}
              placeholder={t('studio.container.dialog.slugPlaceholder')}
              value={slug}
              onChange={handleSlugChange}
              error={slugError}
              bounds={ITEM_SLUG_BOUNDS}
              helper={slugHelper}
            />
            <fieldset className='flex flex-col gap-1.5'>
              <legend className='text-sm font-medium'>
                {t('studio.container.dialog.visibilityLabel')}
              </legend>
              <RadioGroup
                value={visibility}
                onValueChange={(value) => setVisibility(value as ItemVisibility)}
                data-testid={`new-${kind}-visibility`}
                className='flex-row flex-wrap gap-4 text-sm'
              >
                <label className='flex items-center gap-1.5'>
                  <RadioGroupItem value='studio' />
                  {t('studio.container.dialog.visibilityStudioOption')}
                </label>
                <label className='flex items-center gap-1.5'>
                  <RadioGroupItem value='private' />
                  {t('studio.container.dialog.visibilityPrivateOption')}
                </label>
              </RadioGroup>
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
              variant='outline'
              onClick={() => handleOpenChange(false)}
            >
              {t('studio.container.dialog.cancel')}
            </Button>
            <Button
              type='submit'
              disabled={name.trim() === '' || slugError !== null}
            >
              {t('studio.container.dialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
