// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Clock, Star } from 'lucide-react';
import * as React from 'react';

import type { CanvasProposal } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import {
  generateNodeOf,
  nameOf,
  priceOf,
  shapeOf,
  todosOf,
} from '@web/pages/project/chat/proposal-card';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { useCanvasStore } from '@web/stores';

interface ProposalCardProps {
  /** The group the agent proposed, as the tool answered with it. */
  proposal: CanvasProposal;
}

/**
 * One press that puts a whole wired group on the canvas (#229).
 *
 * The card exists for the reader who has said what they want in the chat and
 * does not know the canvas: it says what would be built, which model it runs
 * on and what that costs, and what is left for them afterwards -- all before
 * they press. Pressing posts the proposal to the canvas, which owns the
 * viewport and decides where the group lands.
 *
 * It remembers nothing between presses, and could not: nothing about it is
 * stored, and this message may be several turns old. Pressing twice builds two
 * groups, the way picking twice from the library builds two nodes.
 * @param root0 - The component props.
 * @param root0.proposal - The group the agent proposed.
 * @returns The card.
 */
export const ProposalCard = React.memo(function ProposalCard({
  proposal,
}: ProposalCardProps): React.JSX.Element | null {
  const t = useTranslation();
  const requestNodeCreate = useCanvasStore((s) => s.requestNodeCreate);
  const canvasListening = useCanvasStore((s) => s.canvasListening);
  const outcome = useCanvasStore((s) => s.proposalOutcome);
  const clearOutcome = useCanvasStore((s) => s.clearProposalOutcome);
  const [building, setBuilding] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const { data: catalog } = useQuery(modelCatalogQuery());

  const generate = generateNodeOf(proposal);
  const shape = React.useMemo(() => shapeOf(proposal), [proposal]);
  const todos = React.useMemo(() => todosOf(proposal), [proposal]);
  const price = React.useMemo(
    () => priceOf(catalog, generate?.model),
    [catalog, generate?.model],
  );
  const modelName = React.useMemo(
    () => nameOf(catalog, generate?.model),
    [catalog, generate?.model],
  );

  // The canvas answers once the group is placed or once placing threw. Only
  // the card that is waiting reads it: placing runs to completion inside one
  // synchronous effect, so no second card can have posted in between.
  React.useEffect(() => {
    if (!building || outcome === null) return;
    setBuilding(false);
    setFailed(outcome === 'failed');
    clearOutcome();
  }, [building, outcome, clearOutcome]);

  const onUse = React.useCallback((): void => {
    // Nobody is holding the mailbox when no canvas is open. Said out loud
    // rather than greyed out: a button that will not say why is worse than a
    // sentence naming what to do, and it is the same answer the canvas gives
    // for every other command it refuses.
    if (!canvasListening) {
      toast.warning(t('chat.proposal.needCanvas'));
      return;
    }
    setFailed(false);
    setBuilding(true);
    requestNodeCreate({ proposal });
  }, [canvasListening, proposal, requestNodeCreate, t]);

  if (!generate) return null;

  return (
    <div
      data-testid='proposal-card'
      className='mt-2 flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5'
    >
      {proposal.rationale ? (
        <div className='text-sm font-semibold text-foreground'>{proposal.rationale}</div>
      ) : null}
      <div className='flex flex-wrap items-center gap-1.5 text-xs'>
        {shape.map((chip, i) => (
          <React.Fragment key={`${chip.label}-${String(i)}`}>
            {i > 0 ? (
              <ArrowRight className='h-3 w-3 text-muted-foreground' aria-hidden='true' />
            ) : null}
            <span
              data-testid='proposal-chip'
              className={cn(
                'rounded-md border px-1.5 py-0.5',
                chip.empty
                  ? 'border-dashed border-border text-muted-foreground'
                  : 'border-border bg-background text-foreground',
              )}
            >
              {chip.label}
            </span>
          </React.Fragment>
        ))}
      </div>
      {proposal.modelNote ? (
        <div className='text-xs text-muted-foreground'>
          <span className='font-medium text-foreground'>{modelName}</span>
          {' · '}
          {proposal.modelNote}
        </div>
      ) : null}
      {todos.length > 0 ? (
        <ul className='list-disc pl-4 text-xs text-muted-foreground'>
          {todos.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {failed ? (
        <div data-testid='proposal-failed' className='text-xs text-status-error'>
          {t('chat.proposal.failed')}
        </div>
      ) : null}
      <div className='flex items-center justify-between gap-2.5 border-t border-border pt-2'>
        <div className='flex min-w-0 items-center gap-3 text-xs text-muted-foreground'>
          {price ? (
            <>
              {price.credits === undefined ? null : (
                <span className='flex items-center gap-0.5 tabular-nums'>
                  <Star className='h-3.5 w-3.5' aria-hidden='true' />
                  {price.credits}
                </span>
              )}
              <span className='flex items-center gap-0.5 tabular-nums'>
                <Clock className='h-3.5 w-3.5' aria-hidden='true' />
                {t('canvas.generatePanel.durationSeconds', { n: price.seconds })}
              </span>
            </>
          ) : null}
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          data-testid='proposal-use'
          disabled={building}
          onClick={onUse}
          className='flex-none'
        >
          {building ? t('chat.proposal.building') : t('chat.proposal.use')}
        </Button>
      </div>
    </div>
  );
});
