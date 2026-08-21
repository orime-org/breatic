// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What says the answer is still coming, for as long as it is.
 *
 * One dot, breathing, settled 2026-08-12 over two busier proposals. Its
 * figures live in `index.css` beside the other two animations this app
 * defines; the shape came from the demo page that settled it.
 *
 * It stands alone in an empty bubble before the first word and then rides
 * the end of the text until the turn is over (user 2026-08-20). What used to
 * take its place once there was text — a blinking bar — is gone.
 */
import type { ReactElement } from 'react';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * The mark an agent bubble carries while its turn is running.
 * @returns The dot.
 */
export function WaitingDot(): ReactElement {
  const t = useTranslation();
  return (
    <span
      aria-label={t('chat.message.waiting')}
      className='chat-waiting-dot'
      data-testid='chat-waiting-dot'
      role='status'
    />
  );
}
