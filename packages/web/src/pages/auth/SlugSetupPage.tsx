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
  RESERVED_STUDIO_SLUGS,
  STUDIO_SLUG_BOUNDS,
  validateSlugShape,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';

/**
 * Onboarding step two: pick a slug, which the server uses to create the
 * user's personal studio (`/auth/setup-studio`).
 *
 * Reached after email registration's recovery-code dialog, or whenever
 * the personal-studio gate in `ProtectedRoute` catches an account that
 * has no studio yet (`personalStudio === null`). The slug becomes the
 * user's globally-unique web handle — `/studio/{slug}` is their home —
 * so client-side validation mirrors the server's rule (lowercase start,
 * letters / digits / single hyphens, length 6–39, not a reserved word).
 * Uniqueness is the server's authority: a colliding slug returns 409,
 * surfaced inline as the "taken" error.
 *
 * On success the new personal studio is written into the current-user
 * store, which lifts the onboarding gate, then the page navigates to
 * `/studio`.
 *
 * This page is NOT subject to the personal-studio gate (its route uses
 * `requirePersonalStudio={false}`) — otherwise it would redirect to
 * itself forever, since the user lands here precisely because they have
 * no personal studio yet.
 * @returns the onboarding slug form.
 */
export default function SlugSetupPage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUserStore((s) => s.user);
  const setUser = useCurrentUserStore((s) => s.setUser);

  const [slug, setSlug] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // `fieldError` is the client-side slug validation result (shape /
  // length / reserved); `serverTaken` is set when the server rejects a
  // well-formed slug as already-taken (409). They are tracked separately
  // so editing the input clears the stale server verdict without having
  // to re-run validation.
  const [fieldError, setFieldError] = React.useState<SlugError>(null);
  const [serverTaken, setServerTaken] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  /**
   * Map a `SlugError` reason to its localized message, reusing the
   * create-dialog slug strings so the wording stays consistent.
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

  /**
   * Run the same shape + reserved-word check the server enforces, so the
   * user gets immediate feedback before the round-trip.
   * @param value - the candidate slug.
   * @returns the first failure reason, or `null` when locally acceptable.
   */
  function validateLocally(value: string): SlugError {
    const shape = validateSlugShape(value, STUDIO_SLUG_BOUNDS);
    if (shape !== null) {
      return shape;
    }
    if (RESERVED_STUDIO_SLUGS.has(value)) {
      return 'reserved';
    }
    return null;
  }

  /**
   * Validate the slug client-side, call `/auth/setup-studio`, mirror the
   * returned personal studio into the store (lifting the onboarding
   * gate), then navigate into the app.
   * @param e - the form submit event, prevented so the page does not reload.
   */
  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    setServerTaken(false);
    const trimmed = slug.trim();
    const localError = validateLocally(trimmed);
    setFieldError(localError);
    if (localError !== null) return;

    setSubmitting(true);
    try {
      const { personalStudio } = await authApi.setupStudio({ slug: trimmed });
      if (user) {
        setUser({ ...user, name: personalStudio.name, personalStudio });
      }
      navigate('/studio', { replace: true });
    } catch (err) {
      // 409 Conflict = the slug was taken between the local check and the
      // request (or matched a reserved word the stub list misses). Pin it
      // to the field as a "taken" error rather than the generic form line.
      if (err instanceof ApiException && err.status === 409) {
        setServerTaken(true);
      } else {
        const message =
          err instanceof ApiException
            ? err.message
            : t('auth.onboarding.failed');
        setFormError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const activeError: SlugError = serverTaken ? 'taken' : fieldError;
  const slugMessage = slugErrorMessage(activeError);

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
              if (fieldError) setFieldError(null);
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

        <Button type='submit' disabled={submitting} className='mt-2'>
          {submitting
            ? t('auth.onboarding.submitting')
            : t('auth.onboarding.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}
