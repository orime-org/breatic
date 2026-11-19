// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { AgentsSection } from '@web/features/agent-access/AgentsSection';

interface AgentTokensDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The connection to bring into view and mark. */
  focusId?: string;
}

/**
 * The account menu's Agent tokens dialog: the external agents connected to
 * the user's account, over every Studio they belong to (#1488 §5). Its body
 * grows with the list, so it scrolls inside its own height.
 * @param props - The dialog's props.
 * @param props.open - Whether it is open.
 * @param props.onOpenChange - Opens or closes it.
 * @param props.focusId - The connection to point at.
 * @returns The dialog.
 */
export function AgentTokensDialog({ open, onOpenChange, focusId }: AgentTokensDialogProps): React.JSX.Element {
  const t = useTranslation();
  const viewportRef = React.useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-[560px]' aria-describedby={undefined} data-testid='agent-tokens-dialog'>
        <DialogHeader>
          <DialogTitle>{t('agentTokens.title')}</DialogTitle>
        </DialogHeader>
        <ScrollArea className='max-h-[min(640px,70vh)]' viewportRef={viewportRef}>
          <AgentsSection {...(focusId === undefined ? {} : { focusId })} scroller={viewportRef} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
