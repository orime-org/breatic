// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { FieldError } from '@web/components/FieldError';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { useCreatingProject } from '@web/pages/studio/container/dialogs/use-create-project';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import {
  StudioSelectField,
  type StudioOption,
} from '@web/pages/studio/container/dialogs/StudioSelectField';
import {
  ITEM_SLUG_BOUNDS,
  itemSlugFromName,
  validateItemSlug,
  type SlugCheck,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';
import { useItemSlugCheck } from '@web/pages/studio/container/dialogs/use-item-slug-check';
import { SpaceKindPicker } from '@web/spaces/SpaceKindPicker';
import type { SpaceType } from '@breatic/shared';

/** The values entered into a new-project / new-collection dialog. */
export interface NewItemValues {
  name: string;
  slug: string;
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
  /**
   * Called with the entered values on a valid submit. Returning a promise
   * holds the dialog open until the create settles: the reader keeps what he
   * typed and the button says it is working, which is the only thing on
   * screen between the press and the new project's page (#255).
   */
  onCreate?: (values: NewItemValues) => void | Promise<unknown>;
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
 * slug) parameterized by kind. Project / collection slugs are not unique, so
 * the slug is optional: it follows the name until the reader edits it, and is
 * checked for shape alone (inner#1463). Create is always pressable; a press
 * that cannot go ahead says why under the field (inner#1652).
 * A submit reports the values and closes once the caller's create succeeds;
 * a rejected create leaves the dialog open with what was typed.
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
  // Whether the reader has typed a slug of their own; until then it follows
  // the name. Clearing the field hands it back to the name on the next edit.
  const [slugEdited, setSlugEdited] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  // A slug refused at press, shown before the debounced check catches up.
  const [slugRefused, setSlugRefused] = React.useState<Exclude<SlugError, null> | null>(null);
  const [spaceType, setSpaceType] = React.useState<SpaceType>('canvas');
  const [studioId, setStudioId] = React.useState(defaultStudioId ?? '');
  const slugCheck = useItemSlugCheck(slug);
  const [pressed, setPressed] = React.useState(false);
  // A project create is held outside this dialog (inner#1490): opened again
  // while one is out, from either entry, it shows Create busy.
  const creatingProject = useCreatingProject();
  const submitting = pressed || (kind === 'project' && creatingProject);
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
    setSlugEdited(false);
    setNameError(null);
    setSlugRefused(null);
    setSpaceType('canvas');
    setStudioId(defaultStudioId ?? '');
    setPressed(false);
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

  const fallbackSlug = kind;
  const nameId = `new-${kind}-name`;
  const slugId = `new-${kind}-slug`;

  /**
   * Take a new name, and carry the slug along while the reader has not
   * written one of their own.
   * @param next the name as typed.
   */
  const changeName = (next: string): void => {
    setName(next);
    setNameError(null);
    if (!slugEdited) {
      setSlug(next.trim() === '' ? '' : itemSlugFromName(next, fallbackSlug));
      setSlugRefused(null);
    }
  };

  /**
   * Take a slug the reader typed; an emptied field follows the name again.
   * @param next the slug as typed.
   */
  const changeSlug = (next: string): void => {
    setSlug(next);
    setSlugEdited(next !== '');
    setSlugRefused(null);
  };

  /**
   * Check the form on press and either say what is missing or report the values.
   * @param event the form submit event.
   */
  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const trimmedName = name.trim();
    const typedSlug = slug.trim();
    const refused = typedSlug === '' ? null : validateItemSlug(typedSlug);
    setNameError(trimmedName === '' ? t('studio.container.dialog.nameRequired') : null);
    setSlugRefused(refused);
    if (trimmedName === '') {
      document.getElementById(nameId)?.focus();
      return;
    }
    if (refused !== null) {
      document.getElementById(slugId)?.focus();
      return;
    }
    setPressed(true);
    // Awaited whether or not the caller returns a promise, so there is one
    // path out of a press. A caller that reports failure by rejecting leaves
    // the dialog up with what was typed still in it; saying what went wrong
    // is that caller's job, since only it knows what the server answered.
    void Promise.resolve(
      onCreate?.({
        name: trimmedName,
        slug: typedSlug === '' ? itemSlugFromName(trimmedName, fallbackSlug) : typedSlug,
        // A space type + target studio only apply to a project; collections
        // have neither spaces nor a studio selector, so both are omitted.
        ...(kind === 'project'
          ? { spaceType, ...(studioId !== '' ? { studioId } : {}) }
          : {}),
      }),
    ).then(
      () => {
        handleOpenChange(false);
      },
      () => {
        setPressed(false);
      },
    );
  };

  const title =
    kind === 'project'
      ? t('studio.container.dialog.newProjectTitle')
      : t('studio.container.dialog.newCollectionTitle');
  const slugHelper =
    kind === 'project'
      ? t('studio.container.dialog.slugHelperProject', ITEM_SLUG_BOUNDS)
      : t('studio.container.dialog.slugHelperCollection', ITEM_SLUG_BOUNDS);
  const namePlaceholder =
    kind === 'project'
      ? t('studio.container.dialog.namePlaceholder')
      : t('studio.container.dialog.namePlaceholderCollection');
  const slugPlaceholder =
    kind === 'project'
      ? t('studio.container.dialog.slugPlaceholder')
      : t('studio.container.dialog.slugPlaceholderCollection');
  // The slug line carries the description while the slug is acceptable, and
  // the reason in red once it is not; an item slug has nothing to look up.
  const slugLine: SlugCheck =
    slugRefused !== null
      ? { state: 'invalid', reason: slugRefused }
      : slugCheck.state === 'invalid'
        ? slugCheck
        : { state: 'empty' };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid={`new-${kind}-dialog`}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} noValidate>
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
                onChange={(event) => changeName(event.target.value)}
                placeholder={namePlaceholder}
                readOnly={submitting}
                aria-invalid={nameError !== null}
                aria-describedby={nameError !== null ? `${nameId}-error` : undefined}
              />
              {nameError !== null ? (
                <FieldError id={`${nameId}-error`} className='text-xs'>{nameError}</FieldError>
              ) : null}
            </div>
            {/* Right under the Name it follows, so the generated value is seen as it is typed. */}
            <SlugField
              id={slugId}
              label={t('studio.container.dialog.slugLabelOptional')}
              placeholder={slugPlaceholder}
              value={slug}
              onChange={changeSlug}
              check={slugLine}
              bounds={ITEM_SLUG_BOUNDS}
              helper={slugHelper}
              readOnly={submitting}
            />
            {kind === 'project' ? (
              <SpaceKindPicker
                value={spaceType}
                onChange={setSpaceType}
                idPrefix={`new-${kind}-type`}
              />
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
            <Button type='submit' loading={submitting}>
              {t('studio.container.dialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
