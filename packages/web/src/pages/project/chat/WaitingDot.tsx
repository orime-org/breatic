// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What says the answer is still coming, for as long as it is.
 *
 * One dot, breathing, settled 2026-08-12 over two busier proposals. Its
 * figures live in `index.css` beside the other two animations this app
 * defines; the shape came from the demo page that settled it.
 *
 * It stands alone in an empty bubble before the first word, and once there is
 * a reply it sits on a line under it until the turn is over (user 2026-08-20:
 * the mark must not disappear and must not turn into a bar).
 */
import type { ReactElement } from 'react';
import { useTranslation } from '@web/i18n/use-translation';

/** What the mark is told about the turn it stands for. */
interface WaitingDotProps {
  /**
   * Whether this turn stopped to fold its memory before answering.
   *
   * A long conversation goes over what one request may carry, and the server
   * summarises its oldest part first. That is a second model call in front of
   * the reply: the wait is longer, and the line beside the mark is what makes
   * it explainable rather than shorter.
   */
  consolidating?: boolean;
}

/**
 * The mark an agent bubble carries while its turn is running.
 * @param root0 - What the mark is told.
 * @param root0.consolidating - Whether the turn stopped to fold memory.
 * @returns The dot, and the line when there is one to say.
 */
export function WaitingDot({ consolidating }: WaitingDotProps = {}): ReactElement {
  const t = useTranslation();
  return (
    <>
      <span
        aria-label={t('chat.message.waiting')}
        className='chat-waiting-dot'
        data-testid='chat-waiting-dot'
        role='status'
      />
      {consolidating === true ? (
        <span
          data-testid='chat-message-consolidating'
          className='ml-2 align-middle text-xs text-muted-foreground'
        >
          {t('chat.message.consolidating')}
        </span>
      ) : null}
    </>
  );
}
