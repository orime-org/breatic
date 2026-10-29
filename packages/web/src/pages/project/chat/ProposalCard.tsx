// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import * as React from 'react';

import { promptPlainText, type CanvasProposal, type ProposalNode } from '@breatic/shared';

import { ProposalAction, ProposalActions } from '@web/pages/project/chat/ProposalActions';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import {
  guidesOf,
  modelOf,
  nameOf,
  shapeOf,
  todosOf,
  writtenOf,
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
 * on, and what is left for them afterwards -- all before they press. Pressing
 * posts the proposal to the canvas, which owns the viewport and decides where
 * the group lands.
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
  const { data: catalog } = useQuery(modelCatalogQuery());

  const shape = React.useMemo(() => shapeOf(proposal), [proposal]);
  // Where each generation's setup is found, in the reader's language. The
  // name in it is the one the canvas's right-click menu shows.
  const panelLines = React.useMemo(
    () => ({ prompt: t('chat.proposal.promptReady'), settings: t('chat.proposal.settingsReady') }),
    [t],
  );
  const todos = React.useMemo(() => todosOf(proposal, panelLines), [proposal, panelLines]);
  const words = React.useMemo(() => writtenOf(proposal), [proposal]);
  const guides = React.useMemo(() => guidesOf(proposal), [proposal]);
  // One note describes one model, so it is drawn only when the whole flow
  // runs on one. Three angles on three models leave it saying nothing anyone
  // can place.
  const model = React.useMemo(() => modelOf(proposal), [proposal]);
  // Named as the picker of the mode it runs in names it.
  const modelName = React.useMemo(
    () => nameOf(catalog, model, proposal.nodes.find((n) => n.role === 'generate' && n.model === model)?.mode),
    [catalog, model, proposal],
  );

  // The canvas answers once the group is placed or once placing threw. Only
  // the card that is waiting reads it: placing runs to completion inside one
  // synchronous effect, so no second card can have posted in between. A
  // failure is told in a toast as it is answered (inner#1530); the button is
  // free to press again.
  const failedLine = t('chat.proposal.failed');
  React.useEffect(() => {
    if (!building || outcome === null) return;
    setBuilding(false);
    if (outcome === 'failed') toast.error(failedLine);
    clearOutcome();
  }, [building, outcome, clearOutcome, failedLine]);

  const onUse = React.useCallback((): void => {
    // Nobody is holding the mailbox when no canvas is open. Said out loud
    // rather than greyed out: a button that will not say why is worse than a
    // sentence naming what to do, and it is the same answer the canvas gives
    // for every other command it refuses.
    if (!canvasListening) {
      toast.warning(t('chat.proposal.needCanvas'));
      return;
    }
    setBuilding(true);
    requestNodeCreate({ proposal });
  }, [canvasListening, proposal, requestNodeCreate, t]);

  // Words on their own are a flow too, so the card is drawn for anything
  // carrying nodes rather than only for something that generates.
  if (proposal.nodes.length === 0) return null;

  return (
    <div
      data-testid='proposal-card'
      className='mt-2 flex flex-col gap-2 rounded-overlay border border-border bg-popover px-3 py-2.5'
    >
      {proposal.rationale ? (
        <div className='text-sm font-semibold text-foreground'>{proposal.rationale}</div>
      ) : null}
      <div className='flex flex-wrap items-center gap-1.5 text-xs'>
        {shape.map((group, g) => (
          <React.Fragment key={`run-${String(g)}`}>
            {g > 0 ? (
              // Two runs side by side with nothing between them read as one.
              // A divider rather than an arrow: an arrow would say the run on
              // its left feeds the one on its right, which is what these two
              // deliberately do not do.
              <span
                data-testid='proposal-divider'
                aria-hidden='true'
                className='text-border'
              >
                |
              </span>
            ) : null}
            {group.map((layer, l) => (
              <React.Fragment key={`layer-${String(l)}`}>
                {l > 0 ? (
                  <ArrowRight
                    data-testid='proposal-arrow'
                    className='h-3 w-3 flex-none text-muted-foreground'
                    aria-hidden='true'
                  />
                ) : null}
                {/* Stacked, the way the confirmed demo draws a layer: three
                    takes of one thing read as three of a kind rather than as
                    a chain running left to right. */}
                <span className='flex flex-col gap-1'>
                  {layer.map((chip, c) => (
                    <span
                      key={`${chip.label}-${String(c)}`}
                      data-testid='proposal-chip'
                      className={cn(
                        'rounded-chrome border px-1.5 py-0.5',
                        chip.empty
                          ? 'border-dashed border-border text-muted-foreground'
                          : 'border-border text-foreground',
                      )}
                    >
                      {chip.label}
                    </span>
                  ))}
                </span>
              </React.Fragment>
            ))}
          </React.Fragment>
        ))}
      </div>
      {words.map((node, i) => (
        <WrittenWords key={`words-${String(i)}`} node={node} />
      ))}
      {model && proposal.modelNote ? (
        <div className='text-xs text-muted-foreground'>
          <span className='font-medium text-foreground'>{modelName}</span>
          {' · '}
          {proposal.modelNote}
        </div>
      ) : null}
      {todos.length > 0 ? (
        <div className='flex flex-col gap-1 text-xs text-muted-foreground'>
          {todos.map((group, g) => (
            <div key={`todo-${String(g)}`} data-testid='proposal-todo-group'>
              {/* Named wherever the proposal places more than one node: with
                  two on screen and one line under them, an unheaded line
                  leaves the reader unable to tell which it is about. A
                  proposal of one node has nothing to tell it apart from. */}
              {proposal.nodes.length > 1 ? (
                <div className='font-medium text-foreground'>
                  {group.nodes.join(' · ')}
                </div>
              ) : null}
              <ul className='list-disc pl-4'>
                {group.notes.map((note, n) => (
                  <li key={`${String(g)}-${String(n)}`}>{note}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      {guides.map((node, i) => (
        <WrittenWords key={`guide-${String(i)}`} node={node} />
      ))}
      <ProposalActions>
        <ProposalAction data-testid='proposal-use' disabled={building} onClick={onUse}>
          {building ? t('chat.proposal.building') : t('chat.proposal.use')}
        </ProposalAction>
      </ProposalActions>
    </div>
  );
});

/**
 * One node's words, already written, drawn in full under its name.
 *
 * Read here rather than after placing: a reader who wants another version
 * asks for one in the chat, with nothing of theirs on the canvas to undo. Not
 * truncated -- a note they cannot finish reading is one they cannot judge,
 * and the chat column scrolls.
 * @param root0 - The component props.
 * @param root0.node - The written node.
 * @returns The block.
 */
const WrittenWords = React.memo(function WrittenWords({ node }: { node: ProposalNode }): React.JSX.Element {
  return (
    <div className='flex flex-col gap-1'>
      {/* Always named, unlike the to-do heading: a proposal with words in it
          carries a generation too -- the check turns away one that generates
          nothing -- so there is always a second node to tell this one apart
          from. */}
      <div
        data-testid='proposal-words-name'
        className='text-xs font-medium text-foreground'
      >
        {node.name}
      </div>
      <div
        data-testid='proposal-words'
        className='whitespace-pre-wrap rounded-chrome border border-border px-2 py-1.5 text-xs text-foreground'
      >
        {promptPlainText(node.prompt ?? [])}
      </div>
    </div>
  );
});
