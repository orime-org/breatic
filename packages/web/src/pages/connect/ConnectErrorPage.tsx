// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the authorization server sends the browser when an external agent's
 * authorization cannot even reach the consent page (#1488 §5.3):
 * `/connect/error?reason=` names why.
 */

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '@web/i18n/use-translation';
import { AuthCardShell } from '@web/pages/auth/_shared/AuthCardShell';

/**
 * The page for an authorization that never reached consent.
 * @returns The page.
 */
export default function ConnectErrorPage(): React.JSX.Element {
  const t = useTranslation();
  const [params] = useSearchParams();
  const reason = params.get('reason');
  // A wrong client or callback is the agent's to fix; anything else is a request that is gone.
  const invalid = reason === 'client_invalid' || reason === 'redirect_mismatch';
  return (
    <AuthCardShell title={t(invalid ? 'agentConnect.invalidTitle' : 'agentConnect.expiredTitle')}>
      <p className='text-sm text-muted-foreground'>{t(invalid ? 'agentConnect.invalidBody' : 'agentConnect.expiredBody')}</p>
    </AuthCardShell>
  );
}
