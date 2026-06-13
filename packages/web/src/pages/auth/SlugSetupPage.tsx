// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { useCurrentUserStore } from '@web/stores';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';
import { FieldError } from '@web/pages/auth/_shared/FieldError';
import {
  STUDIO_SLUG_BOUNDS,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';

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
 * still lose a race and return 409 on submit, surfaced inline as "taken".
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
  const user = useCurrentUserStore((s) => s.user);
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [slug, setSlug] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // `serverTaken` is set when the server rejects a well-formed, locally-available
  // slug as already-taken (409) — a race between the live check and submit. It
  // is tracked separately so editing the input clears the stale server verdict.
  const [serverTaken, setServerTaken] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const availability = useSlugAvailability(slug);

  /**
   * Map a `SlugError` reason to its localized message, reusing the create-dialog
   * slug strings so the wording stays consistent.
   * @param reason - the validation failure reason, or `null`.
   * @returns the localized error message, or `null` when there is no error.
   */
  function slugErrorMessage(reason: SlugError): string | null {
    switch (reason) {
      case 'format':
        return t('studio.container.dialog.slugFormat');
      case 'length':
        return t('studio.container.dialog.slugLength', {
          min: STUDIO_SLUG_BOUNDS.min,
          max: STUDIO_SLUG_BOUNDS.max,
        });
      case 'reserved':
        return t('studio.container.dialog.slugReserved');
      case 'taken':
        return t('studio.container.dialog.slugTaken');
      default:
        return null;
    }
  }

  // The live status drives the inline message: a server-side 409 (serverTaken)
  // takes priority, then the local/availability error, else the checking /
  // available / helper lines.
  const liveError: SlugError =
    availability.status === 'invalid'
      ? (availability.reason ?? null)
      : availability.status === 'taken'
        ? 'taken'
        : null;
  const activeError: SlugError = serverTaken ? 'taken' : liveError;
  const slugMessage = slugErrorMessage(activeError);
  const showChecking = slugMessage === null && availability.status === 'checking';
  const showAvailable =
    slugMessage === null && availability.status === 'available' && !serverTaken;
  const canSubmit =
    availability.status === 'available' && !serverTaken && !submitting;

  /**
   * Create the personal studio from the chosen slug, mirror it into the store
   * (lifting the onboarding gate), then navigate into the app. A 409 (slug
   * raced) pins a "taken" error to the field.
   * @param e - the form submit event, prevented so the page does not reload.
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting || !canSubmit) return;
    setFormError(null);
    const trimmed = slug.trim();
    setSubmitting(true);
    try {
      const { personalStudio } = await authApi.setupStudio({ slug: trimmed });
      if (user) {
        setUser({ ...user, name: personalStudio.name, personalStudio });
      }
      navigate('/studio', { replace: true });
    } catch (err) {
      if (err instanceof ApiException && err.status === 409) {
        setServerTaken(true);
      } else {
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
        <div className='flex flex-col gap-1'>
          <Label htmlFor='onboarding-slug'>{t('auth.onboarding.slugLabel')}</Label>
          <Input
            id='onboarding-slug'
            type='text'
            value={slug}
            placeholder={t('auth.onboarding.slugPlaceholder')}
            autoComplete='off'
            autoCapitalize='none'
            spellCheck={false}
            onChange={(e) => {
              setSlug(e.target.value);
              if (serverTaken) setServerTaken(false);
            }}
            disabled={submitting}
            aria-invalid={slugMessage !== null || undefined}
            aria-describedby={
              slugMessage ? 'onboarding-slug-error' : 'onboarding-slug-helper'
            }
          />
          {slugMessage ? (
            <FieldError id='onboarding-slug-error'>{slugMessage}</FieldError>
          ) : showChecking ? (
            <p
              id='onboarding-slug-helper'
              className='text-xs text-muted-foreground'
            >
              {t('studio.container.dialog.slugChecking')}
            </p>
          ) : showAvailable ? (
            <p
              id='onboarding-slug-helper'
              className='text-xs text-muted-foreground'
            >
              {t('studio.container.dialog.slugAvailable')}
            </p>
          ) : (
            <p
              id='onboarding-slug-helper'
              className='text-xs text-muted-foreground'
            >
              {t('auth.onboarding.helper', { slug: slug.trim() || 'your-handle' })}
            </p>
          )}
        </div>

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
