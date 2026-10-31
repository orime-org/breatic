// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { diffWords, type Change } from 'diff';
import * as React from 'react';
import { useParams } from 'react-router-dom';

import { getLocale, hasWords, type DocumentProposal } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { ProposalAction, ProposalActions } from '@web/pages/project/chat/ProposalActions';
import { docName } from '@web/data/yjs/manager';
import { useTranslation } from '@web/i18n/use-translation';
import { projectUuidFromRouteParam } from '@web/lib/project-route';
import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';
import { peekDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { markdownBlocks } from '@web/spaces/document/document-markdown';
import { commentTextOf, landedAt } from '@web/spaces/document/document-proposal-landing';
import {
  useDocumentProposals,
  pressKind,
  type DocumentProposalCardState,
  type LandingAction,
  type PressKind,
} from '@web/stores/document-proposals';

interface DocumentProposalCardProps {
  /** The edit the Agent proposed, as the tool answered with it. */
  proposal: DocumentProposal;
}

/** How a block with no words is named on the card, by its BlockNote type. */
const BLOCK_NAME_KEY: Readonly<Record<string, string>> = {
  paragraph: 'spaces.document.commands.paragraph',
  heading: 'chat.documentProposal.headingBlock',
  quote: 'spaces.document.commands.quote',
  bulletListItem: 'spaces.document.commands.bulletList',
  numberedListItem: 'spaces.document.commands.orderedList',
  checkListItem: 'spaces.document.commands.taskList',
  codeBlock: 'spaces.document.commands.codeBlock',
  divider: 'spaces.document.commands.divider',
  table: 'spaces.document.commands.table',
  image: 'spaces.document.media.image',
  video: 'spaces.document.media.video',
  audio: 'spaces.document.media.audio',
};

/** The line a press that landed shows. */
const APPLIED_KEY: Readonly<Record<PressKind, string>> = {
  comment: 'chat.documentProposal.appliedComment',
  rewrite: 'chat.documentProposal.appliedRewrite',
  insert: 'chat.documentProposal.appliedInsert',
};

/**
 * How long the word-by-word comparison may run on the page's thread. Two
 * passages that share almost nothing (a table translated whole) take seconds
 * to compare, and past this the card shows the whole passage out and the
 * whole rewrite in.
 */
const DIFF_TIMEOUT_MS = 100;

/** A rewrite's or an insert's body, read once with the document's schema. */
interface ReadBody {
  /** The rewrite's words set against the original's; null for an insert. */
  changes: Change[] | null;
  /** Whether its text holds anything to put in a comment. */
  hasCommentText: boolean;
}

/**
 * A rewrite's or an insert's body, read once: its Markdown parsed with the
 * document's schema, which the card waits for.
 * @param proposal - The proposal.
 * @returns What the card draws from the body, or null until it is read.
 */
function useReadBody(proposal: DocumentProposal): ReadBody | null {
  const [read, setRead] = React.useState<ReadBody | null>(null);
  React.useEffect(() => {
    if (proposal.kind === 'comment') return undefined;
    let live = true;
    void markdownBlocks(proposal.body).then((blocks) => {
      if (!live) return;
      const rewritten = blocks.map((b) => b.text).join('\n');
      const intlSegmenter = new Intl.Segmenter(getLocale(), { granularity: 'word' });
      setRead({
        changes:
          proposal.kind === 'rewrite'
            ? (diffWords(proposal.original, rewritten, { intlSegmenter, timeout: DIFF_TIMEOUT_MS }) ?? [
              { value: proposal.original, removed: true, added: false, count: 0 },
              { value: rewritten, added: true, removed: false, count: 0 },
            ])
            : null,
        hasCommentText: commentTextOf(blocks).length > 0,
      });
    });
    return () => {
      live = false;
    };
  }, [proposal]);
  return read;
}

/**
 * A card that lands an Agent's comment, rewrite or insert in a document
 * (inner#1509). It says which document and passage, what would change, and
 * offers the press; the project page opens the document and the document
 * Space lands it. A press that landed shows its result on the card; any other
 * ending is told in a toast and the card goes back to its buttons.
 *
 * Whether it landed is read off the open document whenever the document
 * changes, so a reload knows once the document is open and undoing a rewrite
 * or an insert takes the card back; while the
 * document is open it is the truth, over what a press reported. Pressing
 * again checks the same thing first, so nothing lands twice; "View" only
 * shows where it is.
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
  const viewing = useDocumentProposals((s) => s.pending[proposal.proposalId]?.action === 'view');
  const docVersion = useDocumentProposals((s) => s.docVersion[proposal.spaceId] ?? 0);
  const start = useDocumentProposals((s) => s.start);
  const view = useDocumentProposals((s) => s.view);
  const body = useReadBody(proposal);
  const changes = body?.changes ?? null;

  // Read again whenever the document changes or this card's press ends.
  const read = React.useMemo(() => {
    const handle = peekDocumentEditor(docName.documentSpace(projectId, proposal.spaceId));
    return handle === undefined ? { open: false, landed: null } : { open: true, landed: landedAt(handle, proposal)?.how ?? null };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the document or this card's state changes
  }, [projectId, proposal, docVersion, card?.state]);

  const working = card?.state === 'working';
  const reported = read.open && card?.state === 'applied' ? undefined : card?.state;
  const state: DocumentProposalCardState | 'idle' = working ? 'working' : read.landed !== null ? 'applied' : reported ?? 'idle';
  const action: LandingAction | undefined = !working && read.landed !== null ? read.landed : card?.action;

  const onComment = React.useCallback(() => {
    start(proposal, 'comment');
  }, [proposal, start]);
  const onWrite = React.useCallback(() => {
    start(proposal, 'write');
  }, [proposal, start]);
  const onView = React.useCallback(() => {
    view(proposal, action ?? 'write');
  }, [action, proposal, view]);

  const where = t(proposal.kind === 'insert' ? 'chat.documentProposal.whereInsert' : 'chat.documentProposal.where', {
    name: proposal.spaceName,
  });
  const place =
    proposal.kind === 'insert' && proposal.blockId === null ? t('chat.documentProposal.end') : proposal.heading;
  // A comment hangs on words; a block with none (an empty code block, an
  // image, a table of empty cells) has nowhere to put it. A rewrite's comment
  // carries the rewrite's words, so one with none offers no comment either.
  const commentable =
    proposal.kind === 'comment'
      ? hasWords(proposal.original)
      : proposal.kind === 'rewrite' && hasWords(proposal.original) && body?.hasCommentText !== false;
  // Until a rewrite's or an insert's body is read, what it would write is not known.
  const unread = proposal.kind !== 'comment' && body === null;

  const status = state === 'applied' && action !== undefined ? t(APPLIED_KEY[pressKind(proposal, action)]) : null;

  return (
    <div
      data-testid='document-proposal-card'
      data-state={state}
      className='mt-2 flex flex-col gap-2 rounded-overlay border border-border bg-popover px-3 py-2.5'
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
          <div className='whitespace-pre-wrap rounded-chrome border border-border px-2 py-1.5 text-xs text-foreground'>
            {proposal.body}
          </div>
        </>
      ) : null}
      {proposal.kind === 'rewrite' ? (
        <div className='whitespace-pre-wrap rounded-chrome border border-border px-2 py-1.5 text-xs text-foreground'>
          {(changes ?? [{ value: proposal.original, added: false, removed: false, count: 0 }]).map((part, i) =>
            part.removed ? (
              <del key={i} data-testid='document-proposal-removed' className='rounded-content-xs bg-status-error-bg line-through'>
                {part.value}
              </del>
            ) : part.added ? (
              <ins key={i} data-testid='document-proposal-added' className='rounded-content-xs bg-status-success-bg no-underline'>
                {part.value}
              </ins>
            ) : (
              <span key={i}>{part.value}</span>
            ),
          )}
        </div>
      ) : null}
      {proposal.kind === 'rewrite' && proposal.lossy && state !== 'applied' ? (
        <div data-testid='document-proposal-lossy' className='text-xs text-muted-foreground'>
          {t('chat.documentProposal.lossy')}
        </div>
      ) : null}
      {proposal.kind === 'insert' && proposal.blockId !== null ? (
        <div className='flex flex-col gap-1'>
          <div data-testid='document-proposal-anchor-label' className='text-xs text-muted-foreground'>
            {t('chat.documentProposal.insertAfter')}
          </div>
          <div
            data-testid='document-proposal-anchor'
            className='line-clamp-2 border-l border-border pl-2 text-xs text-muted-foreground'
          >
            {hasWords(proposal.original)
              ? proposal.original
              : t(BLOCK_NAME_KEY[proposal.blockType ?? ''] ?? 'spaces.document.commands.paragraph')}
          </div>
        </div>
      ) : null}
      {proposal.kind === 'insert' ? (
        <div className='rounded-chrome border border-border px-2 py-1.5'>
          <MarkdownMessage content={proposal.body} size='xs' />
        </div>
      ) : null}
      {state === 'applied' ? (
        <div className='flex items-center justify-between gap-2'>
          <div data-testid='document-proposal-status' className='text-xs text-muted-foreground'>
            {status}
          </div>
          <Button type='button' variant='outline' size='form' loading={viewing} onClick={onView}>
            {t('chat.documentProposal.view')}
          </Button>
        </div>
      ) : (
        <ProposalActions>
          {commentable ? (
            <ProposalAction
              loading={working && card?.action === 'comment'}
              disabled={unread || (working && card?.action !== 'comment')}
              onClick={onComment}
            >
              {t('chat.documentProposal.addComment')}
            </ProposalAction>
          ) : null}
          {proposal.kind === 'comment' ? null : (
            <ProposalAction
              loading={working && card?.action === 'write'}
              disabled={unread || (working && card?.action !== 'write')}
              onClick={onWrite}
            >
              {t(proposal.kind === 'insert' ? 'chat.documentProposal.insert' : 'chat.documentProposal.apply')}
            </ProposalAction>
          )}
        </ProposalActions>
      )}
    </div>
  );
});
