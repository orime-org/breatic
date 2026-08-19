// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What stands in for the answer until its first word arrives.
 *
 * One dot, breathing, settled 2026-08-12 over two busier proposals. Its
 * figures live in `index.css` beside the other two animations this app
 * defines; the shape came from
 * `engineering/demo/2026-08-12-chat-waiting-animation.html`.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 7.3.
 */
import type { ReactElement } from 'react';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * The waiting mark shown in an agent bubble with nothing in it yet.
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
