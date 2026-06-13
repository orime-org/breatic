// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';
import { RecoveryCodePanel } from '@web/pages/auth/_shared/RecoveryCodePanel';

/** Navigation state carried into the recovery-code screen. */
interface RecoveryCodeState {
  /** The one-time plaintext recovery code from the register / reset response. */
  code: string;
  /** Where to go after acknowledging (`/choose-slug` register, `/login` reset). */
  next: string;
}

/**
 * Recovery-code screen — a dedicated auth-flow page (NOT a modal) shown after
 * registration or a recovery-code reset. It reads the one-time code from
 * navigation state (never the URL, never persisted) and makes the user copy /
 * download / acknowledge before continuing. Reached only via
 * `navigate('/recovery-code', { state })`; a direct visit (no code in state,
 * e.g. a page refresh wipes navigation state) bounces to `/login`.
 *
 * Uses the shared `AuthCardShell` so it matches login / register exactly — no
 * surface overrides. This replaced the earlier modal-styled-as-a-page approach.
 * @returns the recovery-code screen, or a redirect to `/login` when reached
 * without a code in navigation state.
 */
export default function RecoveryCodePage(): React.JSX.Element {
  const t = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as RecoveryCodeState | null;

  // Reached without a code (direct nav / refresh wipes navigation state) —
  // there is nothing to reveal, so bounce to the sign-in page.
  if (!state?.code) {
    return <Navigate to='/login' replace />;
  }

  const { code, next } = state;

  return (
    <AuthCardShell
      title={t('auth.recovery.title')}
      subtitle={t('auth.recovery.subtitle')}
    >
      <RecoveryCodePanel
        code={code}
        onContinue={() => navigate(next || '/studio', { replace: true })}
      />
    </AuthCardShell>
  );
}
