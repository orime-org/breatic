// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What fills the prompt slot when the model consumes no prompt (#1966).
 *
 * One component for every panel, because the sentence has to be the same
 * sentence. The video panel first shipped a mode-specific line — "this mode
 * follows the audio, change the audio to change what is said" — back when
 * talking head was the only mode that could reach it (#1950). Once the trigger
 * became a per-MODEL boolean, that copy was one yaml edit away from telling
 * someone about audio in a mode that has nothing to do with audio, so
 * user 2026-08-17 replaced it: say that this mode does not need a prompt, and
 * do not tie it to any one modality.
 *
 * Audio and text panels join this rule when they land (user decision 2.9), and
 * they get the sentence by rendering this, not by copying it.
 */

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';

/**
 * The line that stands in for the prompt editor.
 * @returns A muted paragraph naming why there is no box here.
 */
export function PromptNotUsedNotice(): React.JSX.Element {
  const t = useTranslation();
  return (
    <p
      data-testid='generate-prompt-not-used'
      className='px-1 py-2 text-xs text-muted-foreground'
    >
      {t('canvas.generatePanel.promptNotUsed')}
    </p>
  );
}
