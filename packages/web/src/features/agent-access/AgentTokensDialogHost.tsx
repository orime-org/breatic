// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { AgentTokensDialog } from '@web/features/agent-access/AgentTokensDialog';
import { useAgentTokensDialog } from '@web/stores/agent-tokens-dialog';

/**
 * The one Agent tokens dialog, opened through `useAgentTokensDialog`.
 * @returns The dialog.
 */
export function AgentTokensDialogHost(): React.JSX.Element {
  const open = useAgentTokensDialog((s) => s.open);
  const focusId = useAgentTokensDialog((s) => s.focusId);
  const hide = useAgentTokensDialog((s) => s.hide);
  const onOpenChange = React.useCallback(
    (next: boolean): void => {
      if (!next) hide();
    },
    [hide],
  );
  return (
    <AgentTokensDialog open={open} onOpenChange={onOpenChange} {...(focusId === null ? {} : { focusId })} />
  );
}
