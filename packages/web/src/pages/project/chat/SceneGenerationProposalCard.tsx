// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Box } from 'lucide-react';
import type { SceneGenerationProposal } from '@breatic/shared';

import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { toast } from '@web/lib/toast';
import { ProposalAction, ProposalActions } from '@web/pages/project/chat/ProposalActions';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { ownControlSummary, type ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import { SCENE_MODE_LABELS, fillFromProposal } from '@web/spaces/three-d/scene-generation';
import { useSceneProposals } from '@web/stores/scene-proposals';

/**
 * Which settings the card names: the choices, the switches that are on, and those turned off that are on by default.
 * @param control - One of the model's controls.
 * @returns True for a choice or a switch.
 */
const MAIN_SETTING = (control: ModelControl): boolean => control.kind === 'choice' || control.kind === 'toggle';

/**
 * The card for an Agent's 3D generation proposal (inner#1691 design 6.2).
 *
 * It names no Space, like the Canvas proposal card: it shows what would be
 * generated and what it costs, and its button hands the proposal to whichever
 * 3D Space is in front, which opens its generation dialog filled. With none
 * in front the button says to open one first. The button is always available:
 * read-only members never see the Agent column.
 * @param root0 - The component props.
 * @param root0.proposal - The proposal, as the tool answered with it.
 * @returns The card.
 */
export const SceneGenerationProposalCard = React.memo(function SceneGenerationProposalCard({ proposal }: { proposal: SceneGenerationProposal }): React.JSX.Element {
  const t = useTranslation();
  const listening = useSceneProposals((s) => s.listening);
  const request = useSceneProposals((s) => s.request);
  const { data: catalog } = useQuery(modelCatalogQuery());
  const entry = React.useMemo(() => catalog?.three_d.find((candidate) => candidate.name === proposal.model), [catalog, proposal.model]);
  const settings = React.useMemo(() => {
    if (entry === undefined) return '';
    /**
     * A setting's name on screen.
     * @param name - The param.
     * @returns Its translated name.
     */
    const nameOf = (name: string): string => t(`canvas.generatePanel.param.${name}`);
    /**
     * A choice with the setting it sets, since the card has no controls beside it.
     * @param name - The setting's name on screen.
     * @param value - The value's name.
     * @returns The part.
     */
    const named = (name: string, value: string): string => t('chat.sceneProposal.setting', { name, value });
    // The tool resolved the params already.
    return ownControlSummary(entry, proposal.mode, proposal.params, nameOf, MAIN_SETTING, named, t('canvas.generatePanel.switchOff')).join(' · ');
  }, [entry, proposal.mode, proposal.params, t]);
  const needScene = t('chat.sceneProposal.needScene');
  const open = React.useCallback((): void => {
    if (!listening) {
      toast.warning(needScene);
      return;
    }
    request(fillFromProposal(proposal));
  }, [listening, request, proposal, needScene]);
  return <div data-testid='scene-proposal-card' className='mt-2 flex flex-col gap-2 rounded-overlay border border-border bg-popover px-3 py-2.5'>
    <div className='flex items-center gap-2 text-sm font-semibold text-foreground'><Box className='size-4 shrink-0' aria-hidden='true' /><span>{t('chat.sceneProposal.title')}</span></div>
    {proposal.rationale ? <div className='text-xs text-muted-foreground'>{proposal.rationale}</div> : null}
    <div className='flex flex-col gap-2 rounded-chrome border border-border p-2 text-xs'>
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1'>
        <span className='font-medium text-foreground'>{SCENE_MODE_LABELS[proposal.mode]}</span>
        <span className='text-muted-foreground'>·</span>
        <span className='text-muted-foreground'>{entry?.display_name ?? proposal.model}</span>
        {entry?.variant ? <span className='text-muted-foreground'>{`· ${entry.variant}`}</span> : null}
        <span className='ml-auto tabular-nums text-muted-foreground'>{t('chat.sceneProposal.credits', { credits: formatCreditAmount(proposal.credits) })}</span>
      </div>
      {proposal.mode === 't23d' ? <p className='whitespace-pre-wrap break-words text-foreground'>{proposal.prompt ?? ''}</p>
        : <div className='flex items-center gap-1.5'>{proposal.images.map((image) => <HoverPreview key={image.assetId} kind='image' src={image.url}>
          <span className='inline-flex shrink-0'><img src={image.url} alt='' className='size-7 rounded-content-xs object-cover' /></span>
        </HoverPreview>)}</div>}
      {settings === '' ? null : <p className='text-muted-foreground'>{settings}</p>}
    </div>
    <ProposalActions><ProposalAction data-testid='scene-proposal-open' onClick={open}>{t('chat.sceneProposal.open')}</ProposalAction></ProposalActions>
  </div>;
});
