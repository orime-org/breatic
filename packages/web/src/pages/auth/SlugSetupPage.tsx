// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { applyPersonalStudio, useCurrentUserStore } from '@web/stores/current-user';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@web/pages/auth/_shared/FieldError';
import { SlugField } from '@web/pages/studio/container/dialogs/SlugField';
import {
  STUDIO_SLUG_BOUNDS,
  toSlugCheck,
} from '@web/pages/studio/container/dialogs/slug-util';
import {
  recheckSlugTaken,
  useSlugAvailability,
} from '@web/pages/studio/container/dialogs/use-slug-availability';

/**
 * Onboarding step two: pick a slug, which the server uses to create the
 * user's personal studio (`/auth/setup-studio`).
 *
 * Reached after email registration's recovery-code dialog, or whenever the
 * personal-studio gate in `ProtectedRoute` catches an account with no studio
 * yet (`personalStudio === null`). The slug becomes the user's globally-unique
 * web handle — `/studio/{slug}` is their home. It is checked **live** (debounced)
 * via the shared `useSlugAvailability` hook — the same edit-time availability
 * indicator the create-team-studio dialog uses, so both behave identically.
 * Uniqueness is ultimately the server's authority: a slug shown available can
 * still lose a race and return 409 on submit; the page then re-asks, and the
 * refreshed answer turns the field's own hint line to "taken".
 *
 * On success the new personal studio is written into the current-user store
 * (lifting the onboarding gate), then the page navigates to `/studio`. This
 * page is NOT subject to the personal-studio gate (its route uses
 * `requirePersonalStudio={false}`) — otherwise it would redirect to itself.
 * @returns the onboarding slug form.
 */
export default function SlugSetupPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useCurrentUserStore((s) => s.user);
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [slug, setSlug] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const availability = useSlugAvailability(slug);
  const canSubmit = availability.status === 'available' && !submitting;

  /**
   * Create the personal studio from the chosen slug, mirror it into the store
   * (lifting the onboarding gate), then navigate into the app.
   * @param e - the form submit event, prevented so the page does not reload.
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setFormError(null);
    const trimmed = slug.trim();
    setSubmitting(true);
    try {
      const { personalStudio } = await authApi.setupStudio({ slug: trimmed });
      if (user) {
        setUser(applyPersonalStudio(user, personalStudio));
      }
      navigate('/studio', { replace: true });
    } catch (err) {
      // A slug taken since the live check is shown by the field itself once
      // the recheck refreshes its answer; anything else goes to the form line.
      const slugTaken =
        err instanceof ApiException &&
        err.status === 409 &&
        (await recheckSlugTaken(queryClient, trimmed).catch(() => false));
      if (!slugTaken) {
        setFormError(
          err instanceof ApiException ? err.message : t('auth.onboarding.failed'),
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCardShell
      title={t('auth.onboarding.title')}
      subtitle={t('auth.onboarding.subtitle')}
    >
      <form onSubmit={handleSubmit} noValidate className='flex flex-col gap-3'>
        <SlugField
          id='onboarding-slug'
          label={t('auth.onboarding.slugLabel')}
          placeholder={t('auth.onboarding.slugPlaceholder')}
          value={slug}
          onChange={setSlug}
          disabled={submitting}
          check={toSlugCheck(availability)}
          bounds={STUDIO_SLUG_BOUNDS}
          helper={t('auth.onboarding.helper', {
            min: STUDIO_SLUG_BOUNDS.min,
            max: STUDIO_SLUG_BOUNDS.max,
          })}
        />

        {formError ? (
          <FieldError role='alert' className='mt-1'>
            {formError}
          </FieldError>
        ) : null}

        <Button type='submit' size='form' disabled={!canSubmit} className='mt-2'>
          {submitting
            ? t('auth.onboarding.submitting')
            : t('auth.onboarding.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}
