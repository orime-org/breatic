// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { SceneGenerationProposal } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useSceneProposals } from '@web/stores/scene-proposals';

/**
 * Receive the 3D generation proposals handed in from the chat while this 3D
 * Space is in front (inner#1691, design 6.2 and 8.5): listening while
 * mounted, opening the idle dialog with each proposal, and saying another
 * generation is being submitted while one is. Either way the proposal is
 * taken out of the mailbox.
 * @param root0 - The dialog's state and its opener.
 * @param root0.submitting - Whether the dialog is waiting on a submit.
 * @param root0.open - Opens the dialog filled with a proposal.
 */
export function useSceneProposalReceiver({ submitting, open }: {
  submitting: boolean;
  open: (proposal: SceneGenerationProposal) => void;
}): void {
  const t = useTranslation();
  const busy = t('spaces.threeD.proposalBusy');
  const setListening = useSceneProposals((s) => s.setListening);
  const incoming = useSceneProposals((s) => s.incoming);
  React.useEffect(() => {
    setListening(true);
    return (): void => setListening(false);
  }, [setListening]);
  React.useEffect(() => {
    if (incoming === null) return;
    const proposal = useSceneProposals.getState().take();
    if (proposal === null) return;
    if (submitting) toast.warning(busy);
    else open(proposal);
  }, [incoming, submitting, open, busy]);
}
