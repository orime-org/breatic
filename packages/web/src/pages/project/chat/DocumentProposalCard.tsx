// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { diffWords, type Change } from 'diff';
import * as React from 'react';
import { useParams } from 'react-router-dom';

import { getLocale, type DocumentProposal } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { docName } from '@web/data/yjs/manager';
import { useTranslation } from '@web/i18n/use-translation';
import { projectUuidFromRouteParam } from '@web/lib/project-route';
import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';
import { peekDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { landedAs } from '@web/spaces/document/document-proposal-landing';
import {
  useDocumentProposals,
  type DocumentProposalCardState,
  type LandingAction,
} from '@web/stores/document-proposals';

interface DocumentProposalCardProps {
  /** The edit the Agent proposed, as the tool answered with it. */
  proposal: DocumentProposal;
}

/** The line a finished press shows, by how it ended; `failed` and `applied` depend on the press. */
const STATUS_KEY: Readonly<Record<Exclude<DocumentProposalCardState, 'working' | 'applied' | 'failed'>, string>> = {
  changed: 'chat.documentProposal.changed',
  blockGone: 'chat.documentProposal.blockGone',
  readOnly: 'chat.documentProposal.readOnly',
  spaceGone: 'chat.documentProposal.spaceGone',
};

/** What a press puts in the document: a comment either way, else the rewrite or the insert itself. */
type PressKind = 'comment' | 'rewrite' | 'insert';

/** The line a press that landed shows. */
const APPLIED_KEY: Readonly<Record<PressKind, string>> = {
  comment: 'chat.documentProposal.appliedComment',
  rewrite: 'chat.documentProposal.appliedRewrite',
  insert: 'chat.documentProposal.appliedInsert',
};

/** The line a press that failed shows. */
const FAILED_KEY: Readonly<Record<PressKind, string>> = {
  comment: 'chat.documentProposal.failedComment',
  rewrite: 'chat.documentProposal.failedRewrite',
  insert: 'chat.documentProposal.failedInsert',
};

/**
 * What a press puts in the document.
 * @param proposal - The proposal.
 * @param action - What was pressed.
 * @returns The kind of change.
 */
function pressKind(proposal: DocumentProposal, action: LandingAction): PressKind {
  return action === 'comment' ? 'comment' : proposal.kind === 'insert' ? 'insert' : 'rewrite';
}

/**
 * The rewritten passage's words set against the original's, once its
 * Markdown is read.
 * @param proposal - A rewrite.
 * @returns The changes, or null until they are worked out.
 */
function useRewriteChanges(proposal: DocumentProposal): Change[] | null {
  const [changes, setChanges] = React.useState<Change[] | null>(null);
  React.useEffect(() => {
    if (proposal.kind !== 'rewrite') return undefined;
    let live = true;
    void markdownBlocks(proposal.body).then((blocks) => {
      if (!live) return;
      const rewritten = blocks.map((b) => b.text).join('\n');
      const intlSegmenter = new Intl.Segmenter(getLocale(), { granularity: 'word' });
      setChanges(diffWords(proposal.original, rewritten, { intlSegmenter }));
    });
    return () => {
      live = false;
    };
  }, [proposal]);
  return changes;
}

/**
 * A card that lands an Agent's comment, rewrite or insert in a document
 * (inner#1509). It says which document and passage, what would change, and
 * offers the press; the project page opens the document and the document
 * Space lands it, then the card says how that ended.
 *
 * Whether it already landed is read off the open document each time the card
 * is drawn, so a reload knows too; pressing again checks the same thing first,
 * so nothing lands twice.
 * @param root0 - The component props.
 * @param root0.proposal - The edit the Agent proposed.
 * @returns The card.
 */
export const DocumentProposalCard = React.memo(function DocumentProposalCard({
  proposal,
}: DocumentProposalCardProps): React.JSX.Element {
  const t = useTranslation();
  const { projectId: routeParam = '' } = useParams<{ projectId: string }>();
  const projectId = projectUuidFromRouteParam(routeParam);
  const card = useDocumentProposals((s) => s.cards[proposal.proposalId]);
  const start = useDocumentProposals((s) => s.start);
  const changes = useRewriteChanges(proposal);

  // Read again whenever this card's press ends, since that is when the
  // document may have changed under it.
  const landed = React.useMemo(() => {
    const handle = peekDocumentEditor(docName.documentSpace(projectId, proposal.spaceId));
    return handle === undefined ? null : landedAs(handle, proposal);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when this card's state changes
  }, [projectId, proposal, card?.state]);

  const working = card?.state === 'working';
  const state: DocumentProposalCardState | 'idle' = working ? 'working' : landed !== null ? 'applied' : card?.state ?? 'idle';
  const action: LandingAction | undefined = !working && landed !== null ? landed : card?.action;

  const onComment = React.useCallback(() => {
    start(proposal, 'comment');
  }, [proposal, start]);
  const onWrite = React.useCallback(() => {
    start(proposal, 'write');
  }, [proposal, start]);
  const onView = React.useCallback(() => {
    start(proposal, action ?? 'write');
  }, [action, proposal, start]);

  const where = t(proposal.kind === 'insert' ? 'chat.documentProposal.whereInsert' : 'chat.documentProposal.where', {
    name: proposal.spaceName,
  });
  const place =
    proposal.kind === 'insert' && proposal.blockId === null ? t('chat.documentProposal.end') : proposal.heading;
  const held = state !== 'idle' && state !== 'failed';

  let status: string | null = null;
  if (state === 'applied' && action !== undefined) status = t(APPLIED_KEY[pressKind(proposal, action)]);
  else if (state === 'failed' && action !== undefined) status = t(FAILED_KEY[pressKind(proposal, action)]);
  else if (state !== 'idle' && state !== 'working' && state !== 'applied' && state !== 'failed') status = t(STATUS_KEY[state]);

  return (
    <div
      data-testid='document-proposal-card'
      className='mt-2 flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5'
    >
      <div className='text-sm font-semibold text-foreground'>{proposal.title}</div>
      <div data-testid='document-proposal-where' className='text-xs text-muted-foreground'>
        {place === '' ? where : `${where} · ${place}`}
      </div>
      {proposal.kind === 'comment' ? (
        <>
          <div
            data-testid='document-proposal-quote'
            className='line-clamp-2 border-l border-border pl-2 text-xs text-muted-foreground'
          >
            {proposal.quote}
          </div>
          <div className='whitespace-pre-wrap text-xs text-foreground'>{proposal.body}</div>
        </>
      ) : null}
      {proposal.kind === 'rewrite' ? (
        <div className='whitespace-pre-wrap rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground'>
          {(changes ?? [{ value: proposal.original, added: false, removed: false, count: 0 }]).map((part, i) =>
            part.removed ? (
              <del key={i} data-testid='document-proposal-removed' className='text-status-error line-through'>
                {part.value}
              </del>
            ) : part.added ? (
              <ins key={i} data-testid='document-proposal-added' className='text-status-success no-underline'>
                {part.value}
              </ins>
            ) : (
              <span key={i}>{part.value}</span>
            ),
          )}
        </div>
      ) : null}
      {proposal.kind === 'rewrite' && proposal.lossy ? (
        <div data-testid='document-proposal-lossy' className='text-xs text-muted-foreground'>
          {t('chat.documentProposal.lossy')}
        </div>
      ) : null}
      {proposal.kind === 'insert' ? (
        <div className='rounded-md border border-border bg-background px-2 py-1.5'>
          <MarkdownMessage content={proposal.body} size='xs' />
        </div>
      ) : null}
      {status === null ? null : (
        <div
          data-testid='document-proposal-status'
          className={state === 'failed' ? 'text-xs text-status-error' : 'text-xs text-muted-foreground'}
        >
          {status}
        </div>
      )}
      {state === 'applied' ? (
        <Button type='button' variant='outline' size='sm' onClick={onView} className='w-full max-w-[270px] self-center'>
          {t('chat.documentProposal.view')}
        </Button>
      ) : (
        <div className='flex w-full max-w-[270px] gap-2 self-center'>
          {proposal.kind === 'insert' ? null : (
            <Button
              type='button'
              variant='outline'
              size='sm'
              loading={working && card?.action === 'comment'}
              disabled={held && !(working && card?.action === 'comment')}
              onClick={onComment}
              className='flex-1'
            >
              {t('chat.documentProposal.addComment')}
            </Button>
          )}
          {proposal.kind === 'comment' ? null : (
            <Button
              type='button'
              variant='outline'
              size='sm'
              loading={working && card?.action === 'write'}
              disabled={held && !(working && card?.action === 'write')}
              onClick={onWrite}
              className='flex-1'
            >
              {t(proposal.kind === 'insert' ? 'chat.documentProposal.insert' : 'chat.documentProposal.apply')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
