// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ScrollText } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useAgentInstructions } from '@web/data/api/agent-instructions';
import { useTranslation } from '@web/i18n/use-translation';
import { AgentInstructionsEditor } from '@web/pages/project/chrome/agent-header/AgentInstructionsEditor';

interface AgentInstructionsButtonProps {
  projectId: string;
}

/**
 * The Project instructions entry in the Agent header (#1400): opens the
 * full-screen editor, and carries a dot while the Project has instructions.
 *
 * Each opening mounts the editor afresh, so its draft and its read belong to
 * that opening alone.
 * @param root0 - Component props.
 * @param root0.projectId - The Project whose instructions it opens.
 * @returns The entry and, while open, the editor.
 */
export function AgentInstructionsButton({ projectId }: AgentInstructionsButtonProps): React.JSX.Element {
  const t = useTranslation();
  const { data } = useAgentInstructions(projectId);
  const [opening, setOpening] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const onOpen = React.useCallback((): void => {
    setOpening((n) => n + 1);
    setOpen(true);
  }, []);
  const onClose = React.useCallback((): void => setOpen(false), []);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant='chrome-ghost'
            size='chrome'
            className='relative'
            aria-label={t('chat.instructions.open')}
            onClick={onOpen}
            data-testid='agent-instructions-open'
          >
            <ScrollText className='h-[18px] w-[18px]' />
            {data?.text ? (
              <span
                data-testid='agent-instructions-dot'
                className='absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-foreground'
              />
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('chat.instructions.open')}</TooltipContent>
      </Tooltip>
      {open ? <AgentInstructionsEditor key={opening} projectId={projectId} onClose={onClose} /> : null}
    </>
  );
}
